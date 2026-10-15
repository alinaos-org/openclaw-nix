#!/usr/bin/env python3
"""openclaw-doctor: what this machine's OpenClaw gateways still need, and how to fix it.

Run it as the desktop user. Per instance it checks:
- environment: each variable in requiredEnvironment is set in the instance's env
  files, not empty and not a placeholder, and not removed by the unit;
- gateway: the user unit is active and /readyz answers ready;
- secrets: `openclaw secrets audit --check` (no plaintext secrets, no unresolved refs);
- models: `openclaw models status --check` (the default route's sign-in or key).
It reads secret values only to see whether they are set and never prints one.
Exit 0 when everything passes, 1 otherwise.
"""
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


def secrets_audit(name, spec, env):
    code, _, output = openclaw(name, spec, env, ["secrets", "audit", "--check"])
    cli = spec["command"]
    if code == 0:
        report(True, name, "secrets", "no plaintext secrets, every reference resolves")
        return
    if code == 1:
        report(False, name, "secrets", "plaintext secrets in the config or auth stores", f"{cli} secrets audit")
    elif code == 2:
        report(False, name, "secrets", "unresolved secret references", f"{cli} secrets audit")
    else:
        report(None, name, "secrets", f"audit did not finish (exit {code})", f"{cli} secrets audit")
    show(output)


def models(name, spec, env):
    # Each route of the default model: its sign-in or key (authStatus) decides; a
    # runtime the CLI cannot load from outside the gateway (owner-plugin-degraded,
    # e.g. Codex's harness) is only a warning, since the gateway checks it itself.
    code, output, tail = openclaw(name, spec, env, ["models", "status", "--json"])
    cli = spec["command"]
    try:
        routes = json.loads(output[output.index("{"):output.rindex("}") + 1])["auth"]["runtimeAuthRoutes"]
    except (ValueError, KeyError, TypeError):
        report(None, name, "models", f"could not read `models status` (exit {code})", f"{cli} models status")
        show(tail)
        return
    unsigned = [r for r in routes if r.get("authStatus") != "usable"]
    unseen = [r for r in routes if r.get("authStatus") == "usable" and r.get("runtimeStatus") not in (None, "available", "usable")]
    if unsigned:
        for route in unsigned:
            report(False, name, "models", f"{route.get('provider')} has no usable sign-in or key ({route.get('authStatus')})",
                   f"`{cli} models auth login --provider {route.get('provider')} --device-code`, or add its API key")
    elif unseen:
        detail = ", ".join(f"{r.get('provider')} via {r.get('runtime')}" for r in unseen)
        report(None, name, "models", f"signed in; the CLI cannot load the runtime for {detail} "
               "from outside the gateway, which checks it at the first turn")
    else:
        report(True, name, "models", f"{len(routes)} route(s) signed in" if routes else "no model route configured")


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
            secrets_audit(name, spec, env)
            models(name, spec, env)
    print("all checks passed" if not failures else f"{failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
