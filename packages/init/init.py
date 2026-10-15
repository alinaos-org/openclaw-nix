#!/usr/bin/env python3
"""Generate one person's OpenClaw laptop flake from openclaw-nix's starter template.

    nix run github:alinaos-org/openclaw-nix#init -- ./laptop

Asks for what only you can decide (your user, this machine's name, your model
provider), copies the template, fills it in, brings over this machine's
hardware-configuration.nix, and creates secrets/openclaw.yaml encrypted for this
machine's SSH host key and your own age key. Secrets never touch the command line
or the disk unencrypted. --template takes another flake's template (a team's).
"""
import argparse
import getpass
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
from pathlib import Path

PROVIDERS = {
    # provider: (API-key variable, default model)
    "openai": ("OPENAI_API_KEY", "openai/gpt-6-astra"),
    "anthropic": ("ANTHROPIC_API_KEY", "anthropic/claude-sonnet-5"),
    "google": ("GEMINI_API_KEY", "google/gemini-3.1-pro"),
}
TOKEN = re.compile(r"@([A-Z][A-Z0-9_]*)@")
NAME = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
HOST = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")


def die(message):
    print(f"init: {message}", file=sys.stderr)
    sys.exit(1)


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def ask(args, key, prompt, default=None, choices=None, check=None):
    value = getattr(args, key)
    while value is None:
        if not args.interactive:
            if default is None:
                die(f"--{key.replace('_', '-')} is required without a terminal")
            value = default
            break
        shown = f" [{default}]" if default else ""
        options = f" ({'/'.join(choices)})" if choices else ""
        value = input(f"{prompt}{options}{shown}: ").strip() or default
    if choices and value not in choices:
        die(f"{key}: choose one of {', '.join(choices)}")
    if check and not check.match(value):
        die(f"{key}: {value!r} is not valid")
    return value


def default_full_name(user):
    try:
        import pwd
        return pwd.getpwnam(user).pw_gecos.split(",")[0] or user
    except (KeyError, ImportError):
        return user


def default_time_zone():
    try:
        return str(Path("/etc/localtime").resolve()).split("/zoneinfo/", 1)[1]
    except (IndexError, OSError):
        return "UTC"


def default_state_version():
    try:
        return ".".join(run(["nixos-version"]).split(".")[:2])
    except (OSError, subprocess.CalledProcessError):
        return None


def latest_release():
    # The newest release tag (2026.10.3-r3), so the flake pins a release, not main.
    try:
        out = run(["git", "ls-remote", "--tags", "--refs", "https://github.com/alinaos-org/openclaw-nix"])
    except (OSError, subprocess.CalledProcessError):
        return None
    tags = [line.split("refs/tags/", 1)[1] for line in out.splitlines() if "refs/tags/" in line]
    tags = [t for t in tags if re.fullmatch(r"\d{4}\.\d+\.\d+-r\d+", t)]
    key = lambda t: [int(x) for x in re.split(r"[.-]r?", t)]
    return max(tags, key=key) if tags else None


def template_path(ref):
    if ref is None:
        return Path(os.environ["OPENCLAW_NIX_TEMPLATE"])
    if os.path.isdir(ref):
        return Path(ref)
    flake, _, name = ref.partition("#")
    name = name or "default"
    return Path(run(["nix", "eval", "--raw", f"{flake}#templates.{name}.path"]))


def fill(target, values):
    unknown = set()
    for path in target.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            text = path.read_text()
        except UnicodeDecodeError:
            continue
        def sub(match):
            if match.group(1) in values:
                return values[match.group(1)]
            unknown.add(match.group(1))
            return match.group(0)
        new = TOKEN.sub(sub, text)
        if new != text:
            path.write_text(new)
    return unknown


def hardware(target, source):
    dest = target / "hardware-configuration.nix"
    if source:
        shutil.copyfile(source, dest)
        return f"copied {source}"
    if Path("/etc/nixos/hardware-configuration.nix").is_file():
        shutil.copyfile("/etc/nixos/hardware-configuration.nix", dest)
        return "copied /etc/nixos/hardware-configuration.nix"
    try:
        dest.write_text(run(["nixos-generate-config", "--show-hardware-config"]) + "\n")
        return "generated with nixos-generate-config"
    except (OSError, subprocess.CalledProcessError):
        return "NOT SET: copy this machine's hardware-configuration.nix in before building"


def age_recipients(args):
    if args.host_age_recipient:
        host = args.host_age_recipient
    else:
        pub = Path(args.host_key)
        if not pub.is_file():
            die(f"{pub} not found: run init on the machine itself, or pass --host-age-recipient")
        host = run(["ssh-to-age", "-i", str(pub)])
    key_file = Path(os.path.expanduser(args.age_key_file))
    if not key_file.is_file():
        if args.interactive and input(f"Create your age key at {key_file}? [Y/n]: ").strip().lower() not in ("", "y", "yes"):
            die("an age key is needed to edit your secrets; pass --age-key-file")
        key_file.parent.mkdir(parents=True, exist_ok=True)
        old = os.umask(0o077)
        try:
            subprocess.run(["age-keygen", "-o", str(key_file)], check=True, capture_output=True)
        finally:
            os.umask(old)
        print(f"  created your age key {key_file}: back it up, it decrypts your secrets")
    user = run(["age-keygen", "-y", str(key_file)])
    return host, user, key_file


def provider_key(args, variable):
    if args.provider_key_stdin:
        return sys.stdin.readline().strip()
    if args.interactive:
        return getpass.getpass(f"{variable} (input hidden; empty to add it later with sops): ").strip()
    return ""


def write_secrets(target, values, key_file):
    plain = {"openclaw_gateway_token": secrets.token_hex(32)}
    if values["PROVIDER_KEY_VARIABLE"]:
        # An empty key stays a visible placeholder that openclaw-doctor reports.
        plain["provider_api_key"] = values.pop("_provider_key") or "REPLACE-ME"
    env = dict(os.environ, SOPS_AGE_KEY_FILE=str(key_file))
    subprocess.run(
        ["sops", "--encrypt", "--filename-override", "secrets/openclaw.yaml",
         "--input-type", "json", "--output-type", "yaml", "--output", "secrets/openclaw.yaml", "/dev/stdin"],
        input=json.dumps(plain), text=True, check=True, cwd=target, env=env, capture_output=True,
    )
    return sorted(plain)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("directory", help="where to create the flake (must not exist, or be empty)")
    parser.add_argument("--template", help="FLAKE#NAME or a directory (default: openclaw-nix's workstation)")
    parser.add_argument("--user")
    parser.add_argument("--full-name")
    parser.add_argument("--hostname")
    parser.add_argument("--time-zone")
    parser.add_argument("--provider", choices=sorted(PROVIDERS))
    parser.add_argument("--auth", choices=["subscription", "api-key"])
    parser.add_argument("--model")
    parser.add_argument("--state-version")
    parser.add_argument("--openclaw-nix-ref", help="release tag to pin (default: the newest)")
    parser.add_argument("--hardware-config", help="file to use as hardware-configuration.nix")
    parser.add_argument("--host-key", default="/etc/ssh/ssh_host_ed25519_key.pub")
    parser.add_argument("--host-age-recipient", help="this machine's age recipient, instead of --host-key")
    parser.add_argument("--age-key-file", default="~/.config/sops/age/keys.txt")
    parser.add_argument("--provider-key-stdin", action="store_true", help="read the provider API key from stdin")
    parser.add_argument("--no-secrets", action="store_true", help="leave secrets/ and .sops.yaml to do by hand")
    parser.add_argument("--no-git", action="store_true")
    parser.add_argument("--non-interactive", dest="interactive", action="store_false")
    args = parser.parse_args()
    args.interactive = args.interactive and sys.stdin.isatty()

    target = Path(args.directory)
    if target.exists() and any(target.iterdir()):
        die(f"{target} exists and is not empty")
    source = template_path(args.template)

    user = ask(args, "user", "Your user name", os.environ.get("USER"), check=NAME)
    values = {
        "USER": user,
        "FULL_NAME": ask(args, "full_name", "Your full name", default_full_name(user)),
        "HOSTNAME": ask(args, "hostname", "This machine's name", socket.gethostname().split(".")[0], check=HOST),
        "TIME_ZONE": ask(args, "time_zone", "Time zone", default_time_zone()),
        "STATE_VERSION": ask(args, "state_version", "NixOS state version (your installed release)", default_state_version()),
    }
    provider = ask(args, "provider", "Model provider", "openai", choices=sorted(PROVIDERS))
    auth = ask(args, "auth", "Sign in with", "subscription", choices=["subscription", "api-key"])
    variable, model = PROVIDERS[provider]
    values["MODEL"] = ask(args, "model", "Default model", model)
    values["PROVIDER_KEY_VARIABLE"] = variable if auth == "api-key" else ""
    values["OPENCLAW_NIX_REF"] = args.openclaw_nix_ref or latest_release() or "main"

    shutil.copytree(source, target, dirs_exist_ok=True)
    for path in [target, *target.rglob("*")]:
        path.chmod(path.stat().st_mode | stat.S_IWUSR | (stat.S_IXUSR if path.is_dir() else 0))
    print(f"init: {target} from {args.template or 'openclaw-nix#workstation'}, openclaw-nix {values['OPENCLAW_NIX_REF']}")
    print(f"  hardware-configuration.nix: {hardware(target, args.hardware_config)}")

    if args.no_secrets:
        print("  secrets: skipped (--no-secrets); fill .sops.yaml and create secrets/openclaw.yaml")
    else:
        host, recipient, key_file = age_recipients(args)
        values["HOST_AGE_RECIPIENT"], values["USER_AGE_RECIPIENT"] = host, recipient
        fill(target, values)
        if values["PROVIDER_KEY_VARIABLE"]:
            values["_provider_key"] = provider_key(args, variable)
        (target / "secrets").mkdir(exist_ok=True)
        names = write_secrets(target, values, key_file)
        print(f"  secrets/openclaw.yaml: {', '.join(names)}, encrypted for this machine and {key_file}")
    unknown = fill(target, values)
    if unknown - ({"HOST_AGE_RECIPIENT", "USER_AGE_RECIPIENT"} if args.no_secrets else set()):
        die(f"the template uses tokens init does not know: {', '.join(sorted(unknown))}")

    if not args.no_git:
        run(["git", "init", "-q"], cwd=target)
        run(["git", "add", "-A"], cwd=target)
    print(f"""
Next, in {target}:
  review host.nix, openclaw.nix and openclaw/main.json
  sudo nixos-rebuild switch --flake .#{values['HOSTNAME']}
  openclaw-doctor""")
    if auth == "subscription":
        print(f"  oc-main models auth login --provider {provider} --device-code")


if __name__ == "__main__":
    main()
