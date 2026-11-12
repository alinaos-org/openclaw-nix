#!/usr/bin/env python3
"""Add an OpenClaw stable release: releases.nix entry + release.nix `current`.

    new-release.py <version> [--repo <checkout>]
                   [--skip-pnpm | --icon-picker-only [--verdict-file <file>]
                    | --icon-picker-off <build step> | --pnpm-only | --desktop-only]

Steps, each verified:
  1. Resolve tag v<version> on openclaw/openclaw and peel it to a commit; the
     release notes' "release SHA" line must name the same commit.
  2. Source hash: NAR hash of the GitHub archive (what fetchFromGitHub checks),
     and the pnpm version upstream pins in package.json.
  3. Add the releases.nix entry (pnpmDepsHash starts as a fake hash), with the
     hash of the release's amd64 desktop .deb (packages/desktop); a release
     without one is refused.
  4. Set release.nix `current`, keeping the previous release in `accepted`.
  5. Session icon picker: dry-run openclaw-nix's picker patch (the one the
     gateway would apply) on the pristine release source, as the build applies
     it. When it no longer applies, set `sessionIconPicker = false;` in the
     entry: the release builds with OpenClaw's own picker until the patch is
     re-ported. Every other patch still fails the build. With --skip-pnpm this
     step is left to --icon-picker-only (release-watch runs it as its own step);
     --verdict-file appends PICKER_VERDICT=applies|stock|stale to a file (stale:
     the entry is off, but the patch applies again). --icon-picker-off sets the
     line for a patch that applies but fails the named build step (CI's fallback,
     scripts/stock-icon-picker.sh).
  6. pnpm deps hash: build the gateway's pnpmDeps and take the hash Nix reports
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
    ap.add_argument("--icon-picker-only", action="store_true",
                    help="only check that the session icon picker patch applies (step 5)")
    ap.add_argument("--verdict-file", help="with --icon-picker-only: append PICKER_VERDICT=<verdict> here")
    ap.add_argument("--icon-picker-off", metavar="STEP",
                    help="only set sessionIconPicker = false: the patch fails this build step")
    a = ap.parse_args()
    v = a.version
    root = pathlib.Path(a.repo).resolve()
    table = root / "releases.nix"
    rel = root / "release.nix"
    if a.pnpm_only:
        return pnpm_hash(root, table)
    if a.desktop_only:
        return desktop_only(table, v)
    if a.icon_picker_only:
        verdict = icon_picker(root, table, v)
        if a.verdict_file:
            with open(a.verdict_file, "a") as f:
                f.write(f"PICKER_VERDICT={verdict}\n")
        return
    if a.icon_picker_off:
        return set_picker_off(table, v, picker_off_build(a.icon_picker_off))
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
    deb = desktop_hash(v)
    if deb:
        entry = with_desktop_hash(entry, deb)
    else:
        # No desktopDebHash: packages/desktop stays on the newest release that has one.
        entry = re.sub(r'    desktopDebHash\.x86_64-linux = "[^"]+";\n', "", entry)
    # Each release tries the picker patch afresh (step 5).
    entry = PICKER_OFF_RE.sub("", entry)
    table.write_text(table_text.replace(m.group(1), entry + "\n" + m.group(1), 1))

    # 4. release.nix: new current; the previous release stays accepted.
    acc = re.search(r"accepted = \[(.*?)\];", rel_text, re.S)
    if f'"{v}"' not in acc.group(1):
        rel_text = rel_text.replace(acc.group(0), acc.group(0)[:-2] + f' "{v}"];')
    rel_text = rel_text.replace(f'current = "{cur}";', f'current = "{v}";')
    rel.write_text(rel_text)
    print(f"release.nix: current {cur} -> {v}")

    if a.skip_pnpm:
        print("pnpmDepsHash left as the fake hash (--skip-pnpm); "
              "finish with --icon-picker-only, then --pnpm-only")
        return
    icon_picker(root, table, v)
    pnpm_hash(root, table)


def desktop_hash(v):
    """SRI hash of the release's amd64 desktop .deb, as fetchurl checks it, or None
    when the release has no .deb (2026.11.3 shipped none): the gateway still follows
    the release, and packages/desktop stays on the newest release that has one."""
    name = f"OpenClaw-{v}-amd64.deb"
    assets = json.loads(gh(f"repos/{REPO}/releases/tags/v{v}", "[.assets[].name]"))
    if name not in assets:
        print(f"warning: v{v} has no {name}; the desktop app stays on the newest release with one")
        return None
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
    deb = desktop_hash(v)
    if not deb:
        sys.exit(f"v{v} has no desktop .deb yet")
    table.write_text(text.replace(m.group(1), with_desktop_hash(m.group(1), deb), 1))


PICKER_OFF = (
    "    # The session icon picker patch does not apply to this release: it builds\n"
    "    # with OpenClaw's own picker until the patch is re-ported (README,\n"
    "    # \"Session icons\"). The re-port deletes these lines.\n"
    "    sessionIconPicker = false;\n"
)


def picker_off_build(step):
    """The line for a patch that applies but fails a build step (CI's fallback)."""
    if not re.fullmatch(r"[\w :.,()/+-]{1,120}", step):
        sys.exit(f"not a build step name: {step!r}")
    return (
        "    # The session icon picker patch applies to this release, but the gateway\n"
        "    # build fails with it, at this step:\n"
        f"    #   {step}\n"
        "    # It builds with OpenClaw's own picker until the patch is re-ported\n"
        "    # (README, \"Session icons\"). The re-port deletes these lines.\n"
        "    sessionIconPicker = false;\n"
    )


# The field however it is written (indentation, spacing, a trailing comment),
# and the comment lines right above it.
PICKER_OFF_RE = re.compile(r"^(?:[ \t]*#[^\n]*\n)*[ \t]*sessionIconPicker[ \t]*=[ \t]*false[ \t]*;[^\n]*\n", re.M)


def set_picker_off(table, v, lines):
    text = table.read_text()
    m = re.search(r'\n(  "' + re.escape(v) + r'" = \{\n.*?\n)(  \};\n)', text, re.S)
    if not m:
        sys.exit(f"no releases.nix entry for {v}")
    if PICKER_OFF_RE.search(m.group(1)):
        sys.exit(f"releases.nix entry {v} already has sessionIconPicker = false")
    table.write_text(text.replace(m.group(0), "\n" + m.group(1) + lines + m.group(2), 1))
    print(f"session icon picker: sessionIconPicker = false for {v}; it builds with OpenClaw's own picker")


def icon_picker(root, table, v):
    """5. Does the session icon picker patch apply to the release, as the build applies it?

    patch exits 1 when a hunk or file fails (a moved hook, a missing file, an
    upstream file where the patch creates one): the release builds with the stock
    picker. Anything else (a malformed patch, an evaluation error) stops here.
    Returns the verdict: applies, stock (it does not apply, the entry is off) or
    stale (the entry is off, but the patch applies again).
    """
    cur = re.search(r'current = "([^"]+)";', (root / "release.nix").read_text()).group(1)
    if cur != v:
        sys.exit(f"release.nix is at {cur}, not {v}: the gateway evaluates release.nix's current")

    def ev(attr):
        return run("nix", "eval", "--raw", "--accept-flake-config", f".#gateway.passthru.{attr}", cwd=root)

    on = run("nix", "eval", "--json", "--accept-flake-config", ".#gateway.passthru.sessionIconPicker",
             cwd=root) == "true"
    src = run("nix", "build", "--no-link", "--print-out-paths", "--accept-flake-config",
              ".#gateway.passthru.upstreamSource", cwd=root)
    patch_path = ev("sessionIconPickerPatch")
    # The build's flags (packages/gateway: -p1, zero fuzz), without writing.
    with open(patch_path, "rb") as patch_file:
        proc = subprocess.run(["patch", "-d", src, "-p1", "--batch", "--forward", "--dry-run", "-F0"],
                              stdin=patch_file, capture_output=True, text=True)
    if proc.returncode not in (0, 1):
        sys.stderr.write(proc.stdout[-3000:] + proc.stderr[-3000:])
        sys.exit(f"patch could not check the session icon picker patch (exit {proc.returncode})")
    applies = proc.returncode == 0
    if not on:
        if applies:
            print(f"session icon picker: off for {v}, but {patch_path} applies again: "
                  "delete `sessionIconPicker = false;` from its releases.nix entry")
            return "stale"
        print(f"session icon picker: off for {v} (the patch still does not apply)")
        return "stock"
    if applies:
        print("session icon picker: the patch applies")
        return "applies"
    print(f"session icon picker: {patch_path} does not apply to {v}:")
    print("\n".join(line for line in (proc.stdout + proc.stderr).splitlines()
                    if line.strip() and not line.startswith("checking file ")
                    and not line.endswith(" is read-only; trying to patch anyway")))
    set_picker_off(table, v, PICKER_OFF)
    return "stock"


def pnpm_hash(root, table):
    """6. pnpm deps hash from the fixed-output build's mismatch report."""
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
