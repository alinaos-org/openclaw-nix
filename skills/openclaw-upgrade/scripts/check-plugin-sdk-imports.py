#!/usr/bin/env python3
"""Check every host plugin's `openclaw/plugin-sdk/*` imports against a built gateway.

    check-plugin-sdk-imports.py <gateway package> [--repo <host checkout>]
        [--dir <repo dir>]... [--input <flake input>]... [extra roots...]

A release can drop plugin SDK subpaths or named exports even while its changelog lists
them as "removal-pending" (2026.10.1 removed eight subpaths, infra-runtime among them).
A plugin importing a missing one fails at gateway start, after activation. This reads
the built `dist/plugin-sdk/<subpath>.js` export lists of the candidate (use the patched
package the gateway will run) and checks every static named import and dynamic import
under the repo's plugin directories (--dir, default the whole repo), the source of the
host's plugin flake inputs (--input) and any extra roots. Defaults for --dir and
--input come from OPENCLAW_UPGRADE_PLUGIN_DIRS and OPENCLAW_UPGRADE_PLUGIN_INPUTS
(space-separated), in the environment or in host.env beside this script. Exit 1 lists
each problem.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys


def host_setting(name):
    """A space-separated setting from the environment, else host.env beside this script."""
    if name in os.environ:
        return os.environ[name].split()
    env = pathlib.Path(__file__).resolve().parent / "host.env"
    if env.is_file():
        for line in env.read_text(encoding="utf8").splitlines():
            key, sep, value = line.strip().removeprefix("export ").partition("=")
            if sep and key == name:
                return value.strip().strip("'\"").split()
    return []


STATIC = re.compile(r'import\s*(type\s*)?\{([^}]*)\}\s*from\s*["\']openclaw/plugin-sdk/([\w./-]+)["\']')
DYNAMIC = re.compile(r'import\(\s*["\']openclaw/plugin-sdk/([\w./-]+)["\']\s*\)')


def input_sources(repo, inputs):
    meta = json.loads(subprocess.run(["nix", "flake", "metadata", "--json", str(repo)],
                                     check=True, capture_output=True, text=True).stdout)
    nodes = meta["locks"]["nodes"]
    for name in inputs:
        node = nodes["root"]["inputs"].get(name)
        if not isinstance(node, str):
            continue
        locked = nodes[node]["locked"]
        if locked["type"] == "github":
            ref = f"github:{locked['owner']}/{locked['repo']}/{locked['rev']}"
        elif locked["type"] == "git":
            ref = f"git+{locked['url']}?rev={locked['rev']}"
        else:
            continue
        out = subprocess.run(["nix", "flake", "prefetch", "--json", ref], capture_output=True, text=True)
        if out.returncode == 0:
            yield name, json.loads(out.stdout)["storePath"]
        else:
            print(f"warning: could not fetch {name}; not checked", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--dir", action="append", dest="dirs")
    ap.add_argument("--input", action="append", dest="inputs")
    ap.add_argument("roots", nargs="*")
    a = ap.parse_args()
    dirs = a.dirs or host_setting("OPENCLAW_UPGRADE_PLUGIN_DIRS") or ["."]
    inputs = a.inputs or host_setting("OPENCLAW_UPGRADE_PLUGIN_INPUTS")
    repo = pathlib.Path(a.repo).resolve()
    sdk = pathlib.Path(a.package) / "lib/openclaw/dist/plugin-sdk"
    if not sdk.is_dir():
        sys.exit(f"{sdk} is not a built plugin SDK")
    cache = {}

    def exports(sub):
        if sub not in cache:
            f = sdk / f"{sub}.js"
            if not f.exists():
                cache[sub] = None
            else:
                text = f.read_text(encoding="utf8")
                names = {part.strip().split(" as ")[-1].strip()
                         for block in re.findall(r"export\s*\{([^}]*)\}", text)
                         for part in block.split(",") if part.strip()}
                names |= set(re.findall(r"export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)", text))
                if re.search(r"export\s*\*\s*from", text):
                    names.add("*")
                cache[sub] = names
        return cache[sub]

    roots = [repo / d for d in dirs]
    roots += [pathlib.Path(p) for _, p in input_sources(repo, inputs)]
    roots += [pathlib.Path(r) for r in a.roots]
    problems, checked, files = [], 0, set()
    for root in roots:
        for dirpath, _, names in os.walk(root):
            if "node_modules" in dirpath or "/.git" in dirpath:
                continue
            for name in names:
                if not name.endswith((".js", ".mjs", ".cjs", ".ts")) or name.endswith(".d.ts"):
                    continue
                path = os.path.join(dirpath, name)
                try:
                    text = open(path, encoding="utf8").read()
                except (OSError, UnicodeDecodeError):
                    continue
                for m in STATIC.finditer(text):
                    checked += 1
                    files.add(path)
                    sub, available = m.group(3), exports(m.group(3))
                    if available is None:
                        problems.append(f"missing subpath {sub}: {path}")
                        continue
                    if m.group(1) or "*" in available:
                        continue
                    for part in m.group(2).split(","):
                        part = part.strip()
                        if part and not part.startswith("type ") and part.split(" as ")[0].strip() not in available:
                            problems.append(f"missing export {sub}.{part.split(' as ')[0].strip()}: {path}")
                for m in DYNAMIC.finditer(text):
                    checked += 1
                    files.add(path)
                    if exports(m.group(1)) is None:
                        problems.append(f"missing subpath (dynamic import) {m.group(1)}: {path}")
    print(f"checked {checked} plugin SDK imports in {len(files)} files against {sdk}")
    for problem in problems:
        print("  " + problem)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
