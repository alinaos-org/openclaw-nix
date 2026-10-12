#!/usr/bin/env python3
"""Pin the npm runtime plugins to an OpenClaw release: pins/runtime-plugins.json.

    pin-runtime-plugins.py <version> [--repo <checkout>] [--add <id>=<npm package>]...

The plugin list is the existing pins file's (add one with --add). For each
plugin it records the registry tarball, npm integrity and shasum, the Nix
flat-file hash, and the published dependencies. A plugin whose dependencies or
bundled dependencies changed since the previous pins is reported and makes the
script exit 2: check that the plugin still builds (overlay.nix `pinnedLock`).
"""
import argparse
import json
import pathlib
import subprocess
import sys
import urllib.request


def registry(package, version):
    url = f"https://registry.npmjs.org/{package.replace('/', '%2F')}/{version}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--add", action="append", default=[], metavar="ID=PACKAGE")
    a = ap.parse_args()
    root = pathlib.Path(a.repo).resolve()
    out = root / "pins/runtime-plugins.json"
    old = json.loads(out.read_text()) if out.exists() else {"plugins": {}}
    plugins = {pid: pin["package"] for pid, pin in old["plugins"].items()}
    for spec in a.add:
        pid, _, package = spec.partition("=")
        if not pid or not package:
            sys.exit(f"--add expects ID=PACKAGE, got {spec!r}")
        plugins[pid] = package
    pins, changed = {}, []
    for pid, package in sorted(plugins.items()):
        meta = registry(package, a.version)
        dist = meta["dist"]
        nix_hash = json.loads(subprocess.run(
            ["nix", "store", "prefetch-file", "--json", "--hash-type", "sha256", dist["tarball"]],
            check=True, capture_output=True, text=True).stdout)["hash"]
        pin = {
            "package": package,
            "tarballUrl": dist["tarball"],
            "npmIntegrity": dist["integrity"],
            "npmShasum": dist["shasum"],
            "nixHash": nix_hash,
            "dependencies": meta.get("dependencies") or {},
            "bundleDependencies": meta.get("bundleDependencies") or meta.get("bundledDependencies") or [],
        }
        prev = old["plugins"].get(pid)
        if prev and (prev["dependencies"], prev["bundleDependencies"]) != (pin["dependencies"], pin["bundleDependencies"]):
            changed.append(f"{pid}: dependencies {prev['dependencies']} -> {pin['dependencies']}, "
                           f"bundled {prev['bundleDependencies']} -> {pin['bundleDependencies']}")
        pins[pid] = pin
        print(f"{pid} {a.version} {nix_hash}")
    out.write_text(json.dumps({"version": a.version, "plugins": pins}, indent=2, sort_keys=True) + "\n")
    print(f"wrote {out.relative_to(root)}")
    if changed:
        print("Dependencies changed; check that each plugin still builds:", *changed, sep="\n  ")
        sys.exit(2)


if __name__ == "__main__":
    main()
