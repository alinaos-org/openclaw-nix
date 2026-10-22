#!/usr/bin/env bash
# Generate the official runtime-plugin lock set for an OpenClaw release:
#
#   scripts/generate-plugin-locks.sh <version>
#
# Every plugin OpenClaw's catalogs list (official external plugins, channels and
# providers), at the release: pins/runtime-plugin-locks/, one .nix lock per plugin,
# package-lock.json files for the plugins that ship one, and report.json (what was
# supported or skipped, and why). It runs the generator of this flake's
# nix-openclaw input (nix/scripts/update-openclaw-runtime-plugin-locks.mjs),
# the version whose builder (nix/lib/openclaw-runtime-plugin.nix) builds the plugins, against the release's
# exact source from releases.nix. release-watch runs it for every new release, so
# no plugin is ever older than the gateway.
#
# It downloads each plugin and, for those with a lockfile, their whole dependency
# tree: minutes on a CI runner, much longer on a slow link.
set -euo pipefail
version=${1:?usage: generate-plugin-locks.sh <version>}
repo=$(cd "$(dirname "$0")/.." && pwd)
out=$repo/pins/runtime-plugin-locks

entry=$(nix eval --json --file "$repo/releases.nix" --apply "r: r.\"$version\"")
rev=$(jq -r .rev <<<"$entry")
hash=$(jq -r .sourceHash <<<"$entry")
upstream=$(nix flake archive --json "$repo" | jq -r '.inputs["nix-openclaw"].path')
# OpenClaw publishes official plugins at its package version: the release itself,
# or for a correction release (v2026.7.1-2) usually its base version. The
# generator checks the source's package.json against this and refuses anything else.
plugin_version=$(curl -fsSL "https://raw.githubusercontent.com/openclaw/openclaw/$rev/package.json" | jq -r .version)
case "$plugin_version" in
  "$version" | "${version%-[1-9]*}") ;;
  *) echo "OpenClaw $version's package.json says $plugin_version" >&2; exit 1 ;;
esac

work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT
cp -r "$upstream/." "$work/"
chmod -R u+w "$work"

# Point the generator at this release; it reads nothing else from the file.
python3 - "$work/nix/sources/openclaw-source.nix" "$version" "$plugin_version" "$rev" "$hash" <<'EOF'
import re, sys
from pathlib import Path
path, version, plugin_version, rev, hash_ = sys.argv[1:]
p = Path(path)
s = p.read_text()
for key, value in {"releaseTag": f"v{version}", "releaseVersion": version,
                   "runtimePluginVersion": plugin_version, "rev": rev, "hash": hash_}.items():
    s, n = re.subn(rf'(\n  {key} = )"[^"]*";', rf'\g<1>"{value}";', s)
    if n != 1:
        sys.exit(f"{path}: no single {key} field")
p.write_text(s)
EOF

(cd "$work" && nix develop "path:$work" --command node nix/scripts/update-openclaw-runtime-plugin-locks.mjs)

generated=$work/nix/generated/openclaw-runtime-plugins
got=$(jq -r .openclawVersion "$generated/report.json")
[ "$got" = "$version" ] || { echo "generated locks are for $got, not $version" >&2; exit 1; }
mkdir -p "$out"
rsync -a --delete "$generated/" "$out/"
# In this repository's style, so the formatting check holds for every release.
nix run --inputs-from "$repo" nixpkgs#alejandra -- -q "$out"
jq -r '"\(.openclawVersion): \(.supported | length) plugins locked, \(.skipped | length) skipped"' "$out/report.json"
jq -r '.skipped[] | "  skipped \(.id // .name): \(.reason // .skipReason // "")"' "$out/report.json"
