#!/usr/bin/env python3
"""Add an OpenClaw stable release: releases.nix entry + release.nix `current`.

    new-release.py <version> [--repo <checkout>] [--skip-pnpm | --pnpm-only | --desktop-only]

Steps, each verified:
  1. Resolve tag v<version> on openclaw/openclaw and peel it to a commit; the
     release notes' "release SHA" line must name the same commit.
  2. Source hash: NAR hash of the GitHub archive (what fetchFromGitHub checks),
     and the pnpm version upstream pins in package.json.
  3. Add the releases.nix entry (pnpmDepsHash starts as a fake hash), with the
     hash of the release's amd64 desktop .deb (packages/desktop); a release
     without one is refused.
  4. Set release.nix `current`, keeping the previous release in `accepted`.
  5. pnpm deps hash: build the gateway's pnpmDeps and take the hash Nix reports
     (inside a memory-capped systemd scope when one is available).
Exits non-zero on any mismatch; `git diff` shows what changed.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

REPO = "openclaw/openclaw"
FAKE = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw).stdout.strip()


def gh(path, jq=None):
    return run(*(["gh", "api", path] + (["--jq", jq] if jq else [])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--skip-pnpm", action="store_true")
    ap.add_argument("--pnpm-only", action="store_true", help="only replace the fake pnpmDepsHash")
    ap.add_argument("--desktop-only", action="store_true", help="only set desktopDebHash on an existing entry")
    a = ap.parse_args()
    v = a.version
    root = pathlib.Path(a.repo).resolve()
    table = root / "releases.nix"
    rel = root / "release.nix"
    if a.pnpm_only:
        return pnpm_hash(root, table)
    if a.desktop_only:
        return desktop_only(table, v)
    table_text, rel_text = table.read_text(), rel.read_text()
    cur = re.search(r'current = "([^"]+)";', rel_text).group(1)
    if cur == v:
        sys.exit(f"release.nix already at {v}")
    if f'"{v}" = {{' in table_text:
        sys.exit(f"releases.nix already has {v}")

    # 1. tag -> commit, cross-checked against the published release notes.
    obj = json.loads(gh(f"repos/{REPO}/git/ref/tags/v{v}", ".object"))
    sha = obj["sha"]
    if obj["type"] == "tag":
        sha = gh(f"repos/{REPO}/git/tags/{sha}", ".object.sha")
    rel_obj = json.loads(gh(f"repos/{REPO}/releases/tags/v{v}"))
    if rel_obj.get("prerelease") or rel_obj.get("draft"):
        sys.exit(f"v{v} is a prerelease or draft; stable releases only")
    m = re.search(r"release SHA: `([0-9a-f]{40})`", rel_obj.get("body") or "")
    if not m or m.group(1) != sha:
        sys.exit(f"tag v{v} peels to {sha}, release notes say {m.group(1) if m else 'nothing'}")
    stamp = gh(f"repos/{REPO}/commits/{sha}", ".commit.committer.date")
    print(f"v{v}: commit {sha}, committed {stamp}")

    # 2. source hash, as fetchFromGitHub computes it, and upstream's pnpm pin.
    b32, src_path = run("nix-prefetch-url", "--unpack", "--print-path", "--type", "sha256",
                        f"https://github.com/{REPO}/archive/{sha}.tar.gz").splitlines()[-2:]
    src_hash = run("nix", "hash", "convert", "--hash-algo", "sha256", "--to", "sri", b32)
    print(f"sourceHash {src_hash}")
    manager = json.loads((pathlib.Path(src_path) / "package.json").read_text()).get("packageManager", "")
    pm = re.match(r"pnpm@([0-9][0-9.]*)", manager)
    if not pm:
        sys.exit(f"package.json packageManager is {manager!r}, not a pinned pnpm")
    print(f"pnpm {pm.group(1)}")

    # 3. releases.nix entry, copied from the current release's.
    m = re.search(r'\n(  "' + re.escape(cur) + r'" = \{\n.*?\n  \};\n)', table_text, re.S)
    if not m:
        sys.exit(f"no releases.nix entry for current release {cur}")
    entry = m.group(1).replace(f'"{cur}"', f'"{v}"')
    entry = re.sub(r'rev = "[0-9a-f]{40}";', f'rev = "{sha}";', entry)
    entry = re.sub(r'sourceHash = "[^"]+";', f'sourceHash = "{src_hash}";', entry)
    entry = re.sub(r'buildTimestamp = "[^"]+";', f'buildTimestamp = "{stamp}";', entry)
    entry = re.sub(r'pnpmBootstrapVersion = "[^"]+";', f'pnpmBootstrapVersion = "{pm.group(1)}";', entry)
    entry, n = re.subn(r'(pnpmDepsHash\.x86_64-linux = ")[^"]+(";)', rf"\g<1>{FAKE}\g<2>", entry)
    if n != 1:
        sys.exit("could not find the pnpmDepsHash field in the copied entry")
    entry = with_desktop_hash(entry, desktop_hash(v))
    table.write_text(table_text.replace(m.group(1), entry + "\n" + m.group(1), 1))

    # 4. release.nix: new current; the previous release stays accepted.
    acc = re.search(r"accepted = \[(.*?)\];", rel_text, re.S)
    if f'"{v}"' not in acc.group(1):
        rel_text = rel_text.replace(acc.group(0), acc.group(0)[:-2] + f' "{v}"];')
    rel_text = rel_text.replace(f'current = "{cur}";', f'current = "{v}";')
    rel.write_text(rel_text)
    print(f"release.nix: current {cur} -> {v}")

    if a.skip_pnpm:
        print("pnpmDepsHash left as the fake hash (--skip-pnpm); finish with --pnpm-only")
        return
    pnpm_hash(root, table)


def desktop_hash(v):
    """SRI hash of the release's amd64 desktop .deb, as fetchurl checks it."""
    name = f"OpenClaw-{v}-amd64.deb"
    assets = json.loads(gh(f"repos/{REPO}/releases/tags/v{v}", "[.assets[].name]"))
    if name not in assets:
        sys.exit(f"v{v} has no {name}; the desktop app cannot follow this release")
    b32 = run("nix-prefetch-url", "--type", "sha256",
              f"https://github.com/{REPO}/releases/download/v{v}/{name}").splitlines()[-1]
    sri = run("nix", "hash", "convert", "--hash-algo", "sha256", "--to", "sri", b32)
    print(f"desktopDebHash {sri}")
    return sri


def with_desktop_hash(entry, sri):
    field = f'    desktopDebHash.x86_64-linux = "{sri}";\n'
    entry, n = re.subn(r'    desktopDebHash\.x86_64-linux = "[^"]+";\n', field, entry)
    if n == 0:
        entry, n = re.subn(r'(    pnpmDepsHash\.x86_64-linux = "[^"]+";\n)', lambda m: m.group(1) + field, entry)
    if n != 1:
        sys.exit("could not place desktopDebHash in the releases.nix entry")
    return entry


def desktop_only(table, v):
    text = table.read_text()
    m = re.search(r'\n(  "' + re.escape(v) + r'" = \{\n.*?\n  \};\n)', text, re.S)
    if not m:
        sys.exit(f"no releases.nix entry for {v}")
    table.write_text(text.replace(m.group(1), with_desktop_hash(m.group(1), desktop_hash(v)), 1))


def pnpm_hash(root, table):
    """5. pnpm deps hash from the fixed-output build's mismatch report."""
    if FAKE not in table.read_text():
        sys.exit("no fake pnpmDepsHash to replace")
    cmd = ["nix", "build", "--no-link", "--accept-flake-config", ".#gateway.pnpmDeps"]
    if shutil.which("systemd-run"):
        cmd = ["systemd-run", "--user", "--scope", "--quiet", "-p", "MemoryMax=8G", "-p", "MemorySwapMax=0"] + cmd
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True)
    got = re.search(r"got:\s+(sha256-[A-Za-z0-9+/=]+)", proc.stderr)
    if not got:
        sys.stderr.write(proc.stderr[-3000:])
        sys.exit("pnpm deps build did not report a hash mismatch; see the output above")
    text = table.read_text()
    assert text.count(FAKE) == 1
    table.write_text(text.replace(FAKE, got.group(1)))
    print(f"pnpmDepsHash {got.group(1)}")


if __name__ == "__main__":
    main()
