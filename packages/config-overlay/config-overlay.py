#!/usr/bin/env python3
"""OpenClaw Nix + Control UI config overlay.

Nix renders the base config. The gateway runs with a *writable* runtime config so
the Control UI (models, provider sign-in, thinking level, heartbeats, ...) can
save. Before every gateway start this tool:

  capture  diff(last rendered base -> current runtime file) and keep the changes
           whose paths the policy allows in <state>/config-overlay.json. Changes
           to denied paths (security fences, plugins, channels, gateway, exec,
           secrets) are NOT kept; they are written to <state>/config-drift.json
           so they surface in the audit instead of silently persisting.
  apply    write the new Nix base to <state>/.nix-base.json, prune overlay
           entries the base now already contains (= promoted to the repo), and
           render base + allowed overlay into the runtime config.

Operator commands: list | drop <index|all> | promote (JSON merge patch to paste
into the instance's source config) | check (exit 1 if overlay or drift exists) |
preview (what capture would keep from the live runtime file; writes nothing).
`redact` (stdin to stdout, no other arguments) applies the drift-report
redaction to any JSON document.

Paths are JSON arrays of keys, so model ids such as "anthropic/claude-opus-5-5"
and keys containing dots are handled exactly. Arrays are atomic values.
Stdlib only; safe to run under ExecStartPre while the gateway is stopped.
"""
from __future__ import annotations

import argparse
import copy
import datetime as _dt
import json
import os
import re
import sys
import tempfile

DELETE = {"__overlay_delete__": True}

SECRET_VALUE = re.compile(
    r"(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{8,}|xox[abposr]-[A-Za-z0-9-]{8,}|"
    r"gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|"
    r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|nsec1[02-9ac-hj-np-z]{50,})"
)
SECRET_KEY = re.compile(r"(token|apikey|api_key|password|secret|refresh|access)$", re.I)
# Redaction for diagnostics (config-drift.json, upgrade drift) is deliberately
# wider than SECRET_KEY, which decides what the overlay may keep: here a false
# positive only hides a value from a report, a false negative leaks a credential.
REDACT_KEY = re.compile(
    r"(token|key|password|passwd|passphrase|secret|refresh|access|credentials?|cookie|"
    r"authorization|nsec|bearer|signature|private)$", re.I)
REDACT_CONTAINER = re.compile(r"^(env|headers|secrets|credentials)$", re.I)
URL_USERINFO = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@")
REDACTED = "<redacted>"


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def dump_atomic(path, data):
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".overlay-", dir=d)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


# ---------------------------------------------------------------- policy
def compile_patterns(patterns):
    return [p.split(".") if isinstance(p, str) else list(p) for p in patterns]


def seg_match(pat, key):
    return pat == "*" or pat == key


def matches(pattern, path):
    """'*' = one segment, '**' (last) = any remainder (including none)."""
    for i, pat in enumerate(pattern):
        if pat == "**":
            return True
        if i >= len(path) or not seg_match(pat, path[i]):
            return False
    return len(path) == len(pattern)


def overlaps(pattern, path):
    """True if pattern covers path, or path is an ancestor of something pattern covers."""
    if matches(pattern, path):
        return True
    for i, key in enumerate(path):
        if i >= len(pattern):
            return False
        if pattern[i] == "**":
            return True
        if not seg_match(pattern[i], key):
            return False
    return True  # path is a strict prefix of pattern -> writing it replaces a denied subtree


def decide(policy, path, value):
    for pat in policy["ignore"]:
        if overlaps(pat, path):
            return False, "ignored"
    for pat in policy["deny"]:
        if overlaps(pat, path):
            return False, "denied:" + ".".join(pat)
    if not any(matches(pat, path) for pat in policy["allow"]):
        return False, "not-allowlisted"
    leak = find_secret(path, value)
    if leak:
        return False, "literal-secret:" + leak
    return True, "allowed"


def find_secret(path, value):
    if isinstance(value, str):
        if value.startswith("${") or value.startswith("$"):
            return None  # env reference, not a literal
        if SECRET_VALUE.search(value):
            return ".".join(path)
        if path and SECRET_KEY.search(path[-1]) and len(value) >= 12:
            return ".".join(path)
        return None
    if isinstance(value, dict):
        if {"source", "id"} <= set(value):  # SecretRef object
            return None
        for k, v in value.items():
            hit = find_secret(path + [k], v)
            if hit:
                return hit
    if isinstance(value, list):
        for i, v in enumerate(value):
            hit = find_secret(path + [str(i)], v)
            if hit:
                return hit
    return None


def redact(value, path=()):
    """Copy of value with credentials replaced by "<redacted>", for anything
    written to a diagnostic file. Env references ($VAR, ${VAR}) and SecretRef
    objects are references, not secrets, and stay readable; so do ordinary
    values, so a drift report still says what was attempted."""
    if isinstance(value, dict):
        if {"source", "id"} <= set(value):  # SecretRef object
            return copy.deepcopy(value)
        return {k: redact(v, (*path, str(k))) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v, (*path, str(i))) for i, v in enumerate(value)]
    if not isinstance(value, str) or value.startswith("$"):
        return value
    named = [seg for seg in path if not seg.isdigit()]
    if named and REDACT_KEY.search(named[-1]):
        return REDACTED
    if any(REDACT_CONTAINER.match(seg) for seg in path):
        return REDACTED
    if SECRET_VALUE.search(value):
        return REDACTED
    return URL_USERINFO.sub(r"\1" + REDACTED + "@", value)


# ---------------------------------------------------------------- diff/apply
def diff(base, cur, path=None):
    path = path or []
    if isinstance(base, dict) and isinstance(cur, dict):
        ops = []
        for k in base:
            if k not in cur:
                ops.append((path + [k], DELETE))
        for k, v in cur.items():
            if k not in base:
                ops.append((path + [k], copy.deepcopy(v)))
            else:
                ops.extend(diff(base[k], v, path + [k]))
        return ops
    if base != cur:
        return [(path, copy.deepcopy(cur))]
    return []


def expand_ops(policy, ops):
    """A whole new subtree (e.g. `auth` when the base had none) is split into
    child ops until each one is either allowed, explicitly denied, or a leaf,
    so an allowed `auth.profiles.<id>` is not lost under a non-allowlisted
    `auth` parent."""
    out = []
    stack = list(reversed(ops))
    while stack:
        path, value = stack.pop()
        if isinstance(value, dict) and value is not DELETE and value != DELETE and value:
            ok, why = decide(policy, path, value)
            if not ok and why == "not-allowlisted":
                for k in reversed(list(value)):
                    stack.append((path + [k], value[k]))
                continue
        out.append((path, value))
    return out


def get(cfg, path):
    node = cfg
    for k in path:
        if not isinstance(node, dict) or k not in node:
            return DELETE
        node = node[k]
    return node


def put(cfg, path, value):
    if not path:
        return copy.deepcopy(value) if value is not DELETE else {}
    node = cfg
    for k in path[:-1]:
        if not isinstance(node.get(k), dict):
            if value == DELETE:
                return cfg
            node[k] = {}
        node = node[k]
    if value == DELETE:
        node.pop(path[-1], None)
    else:
        node[path[-1]] = copy.deepcopy(value)
    return cfg


def key(path):
    return json.dumps(path)


# ---------------------------------------------------------------- commands
def paths_for(state):
    return {
        "runtime": os.path.join(state, "openclaw-runtime.json"),
        "base": os.path.join(state, ".nix-base.json"),
        "overlay": os.path.join(state, "config-overlay.json"),
        "drift": os.path.join(state, "config-drift.json"),
    }


def related(a, b):
    """True if one path is the other or an ancestor of it."""
    n = min(len(a), len(b))
    return a[:n] == b[:n]


def reconcile(policy, base, cur, overlay):
    """The overlay that turns `base` into `cur`, as far as the policy allows.

    Rebuilt from the current diff every time rather than merged into the old
    overlay, so a setting the Control UI changed back to its Nix value (no
    longer in the diff) loses its override instead of coming back at the next
    start, and a removed or reshaped subtree leaves no overlapping entries
    behind (2026-10-05 audit F3). Unchanged entries keep their record
    (capturedAt). Entries apply refused, because the policy tightened, were
    never in the runtime file, so their absence is not a revert: they stay
    until a current change covers the same subtree.

    Returns (entries, drift, newly_captured)."""
    old = {key(e["path"]): e for e in overlay.get("entries", [])}
    dropped = {key(e["path"]): e for e in overlay.get("dropped", [])}
    entries, drift, captured = [], [], 0
    for path, value in expand_ops(policy, diff(base, cur)):
        gone = dropped.get(key(path))
        if gone and gone.get("value") == (None if value == DELETE else value):
            continue  # operator dropped exactly this; the running file still shows it
        ok, why = decide(policy, path, value)
        if ok:
            op = "delete" if value == DELETE else "set"
            prev = old.get(key(path))
            if prev and prev["op"] == op and prev.get("value") == (None if value == DELETE else value) and not prev.get("refused"):
                entries.append(prev)  # unchanged (the overlay itself re-appears in every diff)
                continue
            entries.append({"path": path, "op": op, **({} if value == DELETE else {"value": value}), "capturedAt": now()})
            captured += 1
        elif why == "ignored":
            continue  # gateway bookkeeping (meta stamps etc.); never persisted, never reported
        elif (prev := old.get(key(path))) and prev["op"] == ("delete" if value == DELETE else "set") \
                and prev.get("value") == (None if value == DELETE else value):
            # An entry captured while allowed, still live, under a policy that
            # has since tightened: keep it for apply to refuse, not as drift.
            entries.append(prev)
        else:
            # Policy denial is decided before secret detection, so a denied
            # change (gateway.auth.token, a channel bot token, an MCP header)
            # carries its raw value here: redact every drift value, not only
            # the ones refused as literal secrets.
            if value == DELETE:
                shown = None
            elif why.startswith("literal-secret"):
                shown = REDACTED
            else:
                shown = redact(value, tuple(path))
            drift.append({"path": path, "op": "delete" if value == DELETE else "set",
                          "value": shown, "reason": why, "seenAt": now()})
    for e in overlay.get("entries", []):
        if e.get("refused") and not any(related(e["path"], x["path"]) for x in entries):
            entries.append(e)
    return entries, drift, captured


def read_runtime(path, attempts=5):
    """The live runtime config; retried briefly in case the gateway is mid-write."""
    for attempt in range(attempts):
        try:
            return load(path)
        except json.JSONDecodeError:
            if attempt == attempts - 1:
                raise
            import time
            time.sleep(0.2)


def cmd_capture(args, policy):
    p = paths_for(args.state)
    base, cur = load(p["base"]), load(p["runtime"])
    overlay = load(p["overlay"], {"version": 1, "entries": []})
    if base is None or cur is None:
        print("overlay capture: no previous base or runtime; nothing to capture")
        return 0
    entries, drift, captured = reconcile(policy, base, cur, overlay)
    removed = len(overlay["entries"]) - (len(entries) - captured)
    overlay["entries"] = entries
    overlay["instance"] = args.instance
    dump_atomic(p["overlay"], overlay)
    if drift:
        old = load(p["drift"], {"version": 1, "events": []})
        # Also scrub events written before every drift value was redacted.
        for ev in old.get("events", []):
            if ev.get("value") is not None:
                ev["value"] = redact(ev["value"], tuple(ev.get("path", [])))
        old["events"] = (old.get("events", []) + drift)[-500:]
        old["instance"] = args.instance
        dump_atomic(p["drift"], old)
    print(f"overlay capture ({args.instance}): new {captured}, removed {max(removed, 0)}, drift {len(drift)}, total overlay {len(entries)}")
    return 0


def cmd_preview(args, policy):
    """What capture would keep right now, from the live runtime file, without
    writing anything: for the nightly review branch (prod-ui-sync), which
    otherwise only saw edits captured at the last gateway start (audit F4).
    Prints the overlay document (the config-overlay.json shape) to stdout."""
    p = paths_for(args.state)
    base, cur = load(p["base"]), read_runtime(p["runtime"])
    overlay = load(p["overlay"], {"version": 1, "entries": []})
    if base is None or cur is None:
        entries = overlay.get("entries", [])
    else:
        entries, _drift, _captured = reconcile(policy, base, cur, overlay)
    json.dump({"version": 1, "instance": args.instance, "preview": True, "entries": entries}, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def cmd_apply(args, policy):
    p = paths_for(args.state)
    base = load(args.base)
    if base is None:
        print(f"overlay apply: base {args.base} missing", file=sys.stderr)
        return 2
    overlay = load(p["overlay"], {"version": 1, "entries": []})
    out = copy.deepcopy(base)
    survivors, applied, pruned, refused = [], 0, 0, 0
    for e in overlay["entries"]:
        path = e["path"]
        value = DELETE if e["op"] == "delete" else e["value"]
        if get(base, path) == value:
            pruned += 1  # repo now carries it
            continue
        ok, why = decide(policy, path, value)  # policy may have tightened
        if not ok:
            refused += 1
            e["refused"] = why
            survivors.append(e)
            continue
        e.pop("refused", None)
        out = put(out, path, value)
        survivors.append(e)
        applied += 1
    overlay["entries"] = survivors
    overlay["dropped"] = []  # the new runtime file no longer carries them
    # OpenClaw's config observer treats a file without a `meta` object as
    # clobbered once it has seen one with meta (any Control UI save writes it),
    # and restores its own older .bak over the fresh render, Nix base included
    # ("missing-meta-vs-last-good"). From 2026-10-07 every prod start did that,
    # so 9.9 ran 9.8's plugin set. Any object satisfies it; meta.** is ignored
    # by capture, so this never becomes an overlay entry or drift.
    if not isinstance(out.get("meta"), dict):
        out["meta"] = {}
    dump_atomic(p["overlay"], overlay)
    dump_atomic(p["base"], base)
    dump_atomic(args.out, out)
    print(f"overlay apply ({args.instance}): applied {applied}, pruned {pruned}, refused {refused}")
    return 0


def cmd_list(args, _policy):
    overlay = load(paths_for(args.state)["overlay"], {"entries": []})
    for i, e in enumerate(overlay["entries"]):
        v = "<delete>" if e["op"] == "delete" else json.dumps(e.get("value"))
        flag = f"  [refused: {e['refused']}]" if e.get("refused") else ""
        print(f"{i:3}  {'.'.join(e['path'])} = {v[:120]}  ({e.get('capturedAt','?')}){flag}")
    drift = load(paths_for(args.state)["drift"], {"events": []})
    if drift.get("events"):
        print(f"\n{len(drift['events'])} drift event(s) in config-drift.json (not applied):")
        for ev in drift["events"][-15:]:
            print(f"     {'.'.join(ev['path'])}  {ev['reason']}")
    return 0


def cmd_drop(args, _policy):
    p = paths_for(args.state)
    overlay = load(p["overlay"], {"version": 1, "entries": []})
    if args.which == "all":
        gone, overlay["entries"] = overlay["entries"], []
    else:
        gone = [overlay["entries"].pop(int(args.which))]
    overlay["dropped"] = overlay.get("dropped", []) + gone
    dump_atomic(p["overlay"], overlay)
    print("dropped; takes effect at the next gateway start")
    return 0


def cmd_promote(args, _policy):
    """Emit a JSON merge patch (RFC 7396) for the source config.

    The runtime shape uses agents.entries.<id>; prod's source JSON still uses
    agents.list[]. Entries under agents.entries are emitted separately, keyed by
    agent id, so the operator (or an agent lane) can fold them into the list.
    """
    overlay = load(paths_for(args.state)["overlay"], {"entries": []})
    patch, per_agent = {}, {}
    for e in overlay["entries"]:
        path = e["path"]
        value = None if e["op"] == "delete" else e["value"]
        if path[:2] == ["agents", "entries"] and len(path) > 2:
            put(per_agent.setdefault(path[2], {}), path[3:], value)
            continue
        put(patch, path, value)
    print(json.dumps({"mergePatch": patch, "agentsListById": per_agent}, indent=2))
    return 0


def cmd_check(args, _policy):
    p = paths_for(args.state)
    n_over = len(load(p["overlay"], {"entries": []})["entries"])
    n_drift = len(load(p["drift"], {"events": []}).get("events", []))
    print(json.dumps({"instance": args.instance, "overlayEntries": n_over, "driftEvents": n_drift}))
    return 1 if (n_over or n_drift) else 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["redact"]:
        # `config-overlay.py redact < in.json > out.json`: the same redaction for
        # other diagnostic dumps (the upgrade migration's doctor config drift).
        json.dump(redact(json.load(sys.stdin)), sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 0
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--state", required=True)
    ap.add_argument("--instance", default="unknown")
    ap.add_argument("--policy", required=True, help="JSON file {allow:[...], deny:[...]}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("capture")
    a = sub.add_parser("apply")
    a.add_argument("--base", required=True)
    a.add_argument("--out", required=True)
    sub.add_parser("list")
    d = sub.add_parser("drop")
    d.add_argument("which")
    sub.add_parser("promote")
    sub.add_parser("check")
    sub.add_parser("preview")
    args = ap.parse_args(argv)
    raw = load(args.policy)
    policy = {
        "allow": compile_patterns(raw["allow"]),
        "deny": compile_patterns(raw["deny"]),
        "ignore": compile_patterns(raw.get("ignore", [])),
    }
    return {
        "capture": cmd_capture, "apply": cmd_apply, "list": cmd_list,
        "drop": cmd_drop, "promote": cmd_promote, "check": cmd_check,
        "preview": cmd_preview,
    }[args.cmd](args, policy)


if __name__ == "__main__":
    sys.exit(main())
