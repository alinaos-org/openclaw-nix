#!/usr/bin/env bash
# Generate the typed OpenClaw config options for a release:
#
#   scripts/generate-config-options.sh <version>
#
# pins/openclaw-config-options.nix: nix-openclaw's generator
# (nix/scripts/generate-config-options.ts, at this flake's nix-openclaw input) run
# against the release's own schema (src/config/zod-schema.ts at the commit
# releases.nix pins). nix-openclaw's Home Manager module types every instance's
# config with it (the openclawConfigOptionsFile module argument), so a key the
# release added is accepted and one it removed is rejected. release-watch runs it
# for every release, beside generate-plugin-locks.sh.
#
# It installs the release's source dependencies (pnpm install), so it is a CI job:
# minutes on a runner, much longer on a slow link.
#
# The output stays as the generator writes it: alejandra spends many minutes at full
# CPU on its nesting (still running after 4 on nova), so the formatting check skips it.
set -euo pipefail
version=${1:?usage: generate-config-options.sh <version>}
repo=$(cd "$(dirname "$0")/.." && pwd)
out=$repo/pins/openclaw-config-options.nix

entry=$(nix eval --json --file "$repo/releases.nix" --apply "r: r.\"$version\"")
rev=$(jq -r .rev <<<"$entry")
hash=$(jq -r .sourceHash <<<"$entry")
pnpm_major=$(jq -r '.pnpmBootstrapVersion | split(".")[0]' <<<"$entry")
upstream=$(nix flake archive --json "$repo" | jq -r '.inputs["nix-openclaw"].path')
src=$(nix eval --raw --impure --expr \
  "(builtins.fetchTree {type = \"github\"; owner = \"openclaw\"; repo = \"openclaw\"; rev = \"$rev\"; narHash = \"$hash\";}).outPath")

work=$(mktemp -d)
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT
cp -r "$src/." "$work/src"
chmod -R u+w "$work/src"

shell=(nix shell --inputs-from "$repo" nixpkgs#nodejs_24 "path:$upstream#pnpm_$pnpm_major" --command)
"${shell[@]}" bash -c "cd '$work/src' && PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false pnpm install --frozen-lockfile --ignore-scripts"
mkdir -p "$(dirname "$out")"
"${shell[@]}" bash -c "cd '$work/src' && PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS=false OPENCLAW_SCHEMA_REV='$rev' pnpm exec tsx '$upstream/nix/scripts/generate-config-options.ts' --repo . --out '$out'"
grep -q "$rev" "$out" || { echo "$out does not name $rev" >&2; exit 1; }
echo "$version: typed config options from $rev ($(wc -l < "$out") lines)"
