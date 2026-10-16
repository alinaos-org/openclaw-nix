#!/usr/bin/env python3
"""openclaw-doctor: what this machine's OpenClaw gateways still need, and how to fix it.

Run it as the desktop user. Per instance it checks:
- environment: each variable in requiredEnvironment is set in the instance's env
  files, not empty and not a placeholder, and not removed by the unit;
- gateway: the user unit is active and /readyz answers ready;
- secrets: `openclaw secrets audit` (no plaintext secrets, no unresolved refs), run with
  the gateway password its launcher derives or reads, as the gateway sees it;
- models: `openclaw models status --check` (the default route's sign-in or key).
It reads secret values only to see whether they are set and never prints one.
Exit 0 when everything passes, 1 otherwise.
"""
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

MANIFEST = json.load(open(os.environ["OPENCLAW_DOCTOR_MANIFEST"]))
PLACEHOLDERS = {"REPLACE-ME", "CHANGEME", "changeme", "TODO"}
failures = 0


def report(ok, instance, check, detail, fix=None):
    global failures
    mark = {True: "ok  ", False: "FAIL", None: "warn"}[ok]
    print(f"{mark} {instance}: {check}: {detail}")
    if fix and ok is not True:
        print(f"       fix: {fix}")
    if ok is False:
        failures += 1


def read_env(path):
    # systemd EnvironmentFile syntax: KEY=VALUE lines, # comments, optional quotes.
    values = {}
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip("'\"")
    return values


def environment(name, spec):
    env, problems = {}, []
    for path in spec["environmentFiles"]:
        try:
            env.update(read_env(path))
        except OSError as error:
            report(False, name, "environment", f"cannot read {path} ({error.strerror})",
                   "rebuild, then check that the file belongs to you (`ls -l` it)")
            return None
    for key in spec["unset"]:
        env.pop(key, None)
    for var in spec["required"]:
        if var in spec["unset"]:
            problems.append((var, "removed by the unit (unsetEnvironment / unsetOpenAIApiKey)"))
        elif not env.get(var):
            problems.append((var, "not set"))
        elif env[var] in PLACEHOLDERS:
            problems.append((var, "still a placeholder"))
    files = " ".join(spec["environmentFiles"]) or "no env file"
    if problems:
        for var, why in problems:
            report(False, name, "environment", f"{var} {why}",
                   f"add it to the secret behind {files} (starter: `sops secrets/openclaw.yaml`, "
                   f"key {var.lower()}), then rebuild")
    else:
        report(True, name, "environment", f"{len(spec['required'])} required set ({', '.join(spec['required']) or 'none'})")
    return env


def with_password(name, spec, env):
    # The OPENCLAW_GATEWAY_PASSWORD the unit's launcher gives its gateway, so the audit
    # resolves the config's reference to it: the first line of its file, or, derived,
    # sha256(token NUL instance) from the first OPENCLAW_GATEWAY_TOKEN line of the
    # shared env file, with one pair of double quotes stripped, as the launcher does.
    how = spec.get("password")
    if not how or env is None:
        return env
    try:
        if "file" in how:
            with open(how["file"]) as handle:
                password = handle.readline().rstrip("\n")
        else:
            password = ""
            with open(how["deriveFrom"]) as handle:
                for line in handle:
                    if line.startswith("OPENCLAW_GATEWAY_TOKEN="):
                        token = line.rstrip("\n").partition("=")[2]
                        token = token[1:] if token.startswith('"') else token
                        token = token[:-1] if token.endswith('"') else token
                        if token:
                            password = hashlib.sha256(f"{token}\0{name}".encode()).hexdigest()
                        break
    except OSError as error:
        report(None, name, "secrets", f"cannot read the gateway password's source ({error.strerror}); "
               "the audit may report its reference as unresolved")
        return env
    return dict(env, OPENCLAW_GATEWAY_PASSWORD=password) if password else env


def gateway(name, spec):
    unit = spec["unit"]
    active = subprocess.run(["systemctl", "--user", "is-active", unit], capture_output=True, text=True).stdout.strip()
    if active != "active":
        report(False, name, "gateway", f"{unit} is {active or 'unknown'}", f"systemctl --user status {unit}")
        return
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{spec['port']}/readyz", timeout=10) as response:
            body = response.read().decode()
        report(True, name, "gateway", f"{unit} active, ready on port {spec['port']}")
    except urllib.error.HTTPError as error:
        try:
            failing = json.loads(error.read().decode()).get("failing", [])
        except (ValueError, AttributeError):
            failing = []
        report(False, name, "gateway", f"not ready ({', '.join(map(str, failing)) or error.code})",
               f"journal: journalctl --user -u {unit}; it may still be starting")
    except (urllib.error.URLError, OSError) as error:
        report(False, name, "gateway", f"no answer on port {spec['port']} ({error})", f"systemctl --user status {unit}")


def redact(text, env):
    # Mask every env-file value, and the first and last 8 characters OpenClaw shows of
    # a key (`sk-proj-...abcd1234`), so no part of a secret is printed.
    pieces = set()
    for value in (env or {}).values():
        if len(value) >= 4:
            pieces.add(value)
        if len(value) >= 12:
            pieces.update({value[:8], value[-8:]})
    for piece in sorted(pieces, key=len, reverse=True):
        text = text.replace(piece, "<redacted>")
    return text


def openclaw(name, spec, env, args):
    # The instance's own CLI with the environment its gateway runs with: the unit's
    # variables and its env files' values, in the process environment only.
    # Returns the exit code, the raw stdout to parse (never printed: it can hold masked
    # key fragments), and a redacted tail to show.
    child = dict(os.environ, **spec["environment"], **(env or {}))
    try:
        result = subprocess.run([spec["openclaw"], *args], env=child, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None, "", "timed out after 180 s"
    # One line for the bundled-plugin identity warnings OpenClaw repeats per plugin.
    lines = redact(result.stdout + result.stderr, env).strip().splitlines()
    noise = [line for line in lines if "identity unavailable:" in line]
    lines = [line for line in lines if "identity unavailable:" not in line][-15:]
    if noise:
        lines.insert(0, f"({len(noise)} bundled-plugin identity warnings, e.g. {noise[0].strip()[:120]})")
    return result.returncode, result.stdout, "\n".join(lines)


def show(output):
    for line in output.splitlines():
        print(f"       | {line}")


AUDIT_PROBLEMS = {
    "plaintextCount": "plaintext secret(s)",
    "unresolvedRefCount": "unresolved reference(s)",
    "shadowedRefCount": "shadowed reference(s)",
    "storeResidueCount": "secret(s) left in a store",
}


def secrets_audit(name, spec, env):
    # Judged from the audit's own counts. Legacy residue alone is not a problem: a
    # subscription sign-in (an auth profile's OAuth credentials) is stored by OpenClaw,
    # outside SecretRefs, and every signed-in instance has some.
    code, raw, output = openclaw(name, spec, env, ["secrets", "audit", "--json"])
    cli = spec["command"]
    try:
        audit = json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
        summary = audit["summary"]
        findings = [f for f in audit.get("findings") or [] if isinstance(f, dict)]
    except (ValueError, KeyError, TypeError, AttributeError):
        report(None, name, "secrets", f"could not read `secrets audit --json` (exit {code})", f"{cli} secrets audit")
        show(output)
        return
    problems = [f"{summary[key]} {label}" for key, label in AUDIT_PROBLEMS.items() if summary.get(key)]
    legacy = [f for f in findings if f.get("code") == "LEGACY_RESIDUE"]
    sign_ins = [f for f in legacy if f.get("profileId")]
    if problems:
        report(False, name, "secrets", ", ".join(problems), f"{cli} secrets audit")
        for finding in findings:
            if finding.get("code") == "LEGACY_RESIDUE":
                continue
            where = f"{os.path.basename(str(finding.get('file') or ''))}:{finding.get('jsonPath') or ''}"
            # Only an unresolved reference's message is shown: it names the variable,
            # where another finding's could quote part of the secret.
            why = redact(str(finding.get("message") or ""), env)[:160] if finding.get("code") == "REF_UNRESOLVED" else ""
            print(f"       | {finding.get('code')} {where} {why}".rstrip())
    elif len(sign_ins) < len(legacy):
        report(None, name, "secrets", f"no plaintext secrets, every reference resolves; "
               f"{len(legacy) - len(sign_ins)} other legacy entr{'y' if len(legacy) - len(sign_ins) == 1 else 'ies'}",
               f"{cli} secrets audit")
    else:
        note = f" ({len(sign_ins)} sign-in(s) kept by OpenClaw)" if sign_ins else ""
        report(True, name, "secrets", f"no plaintext secrets, every reference resolves{note}")


def models(name, spec, env):
    # Each route of the default model. Signed in when OpenClaw calls its auth usable,
    # or, when it does not say, when it found a key or profile for the route's
    # provider. A runtime the CLI cannot load from outside the gateway
    # (owner-plugin-degraded, e.g. Codex's harness) is only a warning: the gateway
    # checks it itself.
    code, output, tail = openclaw(name, spec, env, ["models", "status", "--json"])
    cli = spec["command"]
    try:
        auth = json.loads(output[output.index("{"):output.rindex("}") + 1])["auth"]
        routes = auth.get("runtimeAuthRoutes") or []
    except (ValueError, KeyError, TypeError, AttributeError):
        report(None, name, "models", f"could not read `models status` (exit {code})", f"{cli} models status")
        show(tail)
        return
    providers = {p.get("provider"): p for p in auth.get("providers") or [] if isinstance(p, dict)}

    def signed(route):
        status = route.get("authStatus")
        if status == "usable":
            return True
        if status in ("missing", "expired", "unusable", "invalid"):
            return False
        found = providers.get(route.get("authProvider") or route.get("provider")) or {}
        if (found.get("effective") or {}).get("kind") not in (None, "", "none", "missing"):
            return True
        return None

    def fields(route):
        # Non-secret fields only (never `effective`, which carries masked key text).
        keys = ("provider", "runtime", "authStatus", "runtimeStatus", "runtimeReason")
        return ", ".join(f"{k}={route.get(k)}" for k in keys if route.get(k) is not None)

    states = [(route, signed(route)) for route in routes]
    unsigned = [route for route, ok in states if ok is False]
    unknown = [route for route, ok in states if ok is None]
    unseen = [route for route, ok in states
              if ok and route.get("runtimeStatus") not in (None, "available", "usable", "ok")]
    for route in unsigned:
        report(False, name, "models", f"{route.get('provider')} has no usable sign-in or key ({fields(route)})",
               f"`{cli} models auth login --provider {route.get('provider')} --device-code`, or add its API key")
    for route in unknown:
        report(None, name, "models", f"could not tell whether {route.get('provider')} is signed in ({fields(route)})",
               f"{cli} models status")
    for route in unseen:
        report(None, name, "models", f"signed in; the CLI cannot load the runtime for {route.get('provider')} via "
               f"{route.get('runtime')} from outside the gateway, which checks it at the first turn")
    if routes and not (unsigned or unknown or unseen):
        report(True, name, "models", f"{len(routes)} route(s) signed in")
    elif not routes:
        report(None, name, "models", "no model route configured", f"{cli} models status")


def main():
    if os.geteuid() == 0:
        print(f"openclaw-doctor: run it as {MANIFEST['user']}, not root", file=sys.stderr)
        return 1
    only = sys.argv[1:]
    for name, spec in sorted(MANIFEST["instances"].items()):
        if only and name not in only:
            continue
        env = environment(name, spec)
        gateway(name, spec)
        if env is not None:
            secrets_audit(name, spec, with_password(name, spec, env))
            models(name, spec, env)
    print("all checks passed" if not failures else f"{failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
