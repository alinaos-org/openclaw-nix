#!/usr/bin/env bash
# Release evidence for the gateway this checkout builds:
#
#   scripts/release-evidence.sh <out-dir>
#
# - gateway-npm.{cdx,spdx}.json: SBOM of the gateway's npm dependency tree (syft over
#   the installed node_modules), where nearly all of its third-party code is;
# - gateway-nix.{cdx,spdx}.json: SBOM of its Nix runtime closure (sbomnix: Node,
#   OpenSSL, glibc, ...);
# - gateway-{npm,nix}.vulns.json: grype's matches for each SBOM, and vulnerabilities.md,
#   a summary by severity;
# - store-paths.json: the store paths the cache serves (the source build and its pnpm
#   dependency set) with their NAR hashes, which a consumer compares with
#   `nix path-info --json` after substituting.
#
# The tools come from this flake's locked nixpkgs (`--inputs-from .`). The scan reports
# and never fails the release: the findings are upstream's dependencies, and a release
# that waits on them never ships its own fixes.
set -euo pipefail
out=${1:?usage: release-evidence.sh <out-dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)

tool() { echo "$(nix build --no-link --print-out-paths --inputs-from . "nixpkgs#$1")/bin/$1"; }
syft=$(tool syft)
grype=$(tool grype)
sbomnix=$(tool sbomnix)

version=$(nix eval --raw -f release.nix current)
gateway=$(nix build --no-link --print-out-paths .#gateway)
deps=$(nix build --no-link --print-out-paths .#gateway.pnpmDeps)
echo "gateway: $gateway"

"$syft" scan "dir:$gateway" -q \
  --select-catalogers +javascript-package-cataloger \
  --source-name openclaw-gateway --source-version "$version" \
  -o cyclonedx-json="$out/gateway-npm.cdx.json" -o spdx-json="$out/gateway-npm.spdx.json"

# Metadata enrichment would evaluate all of nixpkgs; names, versions and CPEs suffice.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
(cd "$scratch" && "$sbomnix" "$gateway" --exclude-meta \
  --cdx "$out/gateway-nix.cdx.json" --spdx "$out/gateway-nix.spdx.json" --csv "$scratch/sbom.csv")

"$grype" db update
for sbom in npm nix; do
  "$grype" "sbom:$out/gateway-$sbom.cdx.json" -q -o json --file "$out/gateway-$sbom.vulns.json"
done

# Format 1: an object keyed by store path, with SRI NAR hashes.
nix path-info --json --json-format 1 "$gateway" "$deps" \
  | jq --arg version "$version" '
      {openclaw: $version, paths: (to_entries | map({path: .key, narHash: .value.narHash, narSize: .value.narSize}))}' \
  > "$out/store-paths.json"

{
  echo "## Vulnerability scan (grype)"
  echo
  echo "OpenClaw $version, \`$(basename "$gateway")\`. Findings are in upstream's dependencies;"
  echo "\"fixed in\" is the first fixed version where one exists."
  for sbom in npm nix; do
    echo
    echo "### ${sbom} ($(jq '.components | length' "$out/gateway-$sbom.cdx.json") components)"
    echo
    jq -r '
      [.matches[] | .vulnerability.severity] | group_by(.) | map("\(.[0]): \(length)")
      | if length == 0 then "No matches." else join(", ") end' "$out/gateway-$sbom.vulns.json"
    jq -r '
      [.matches[] | select(.vulnerability.severity == "Critical" or .vulnerability.severity == "High")
        | "| \(.vulnerability.severity) | \(.artifact.name) \(.artifact.version) | \(.vulnerability.id) | \(.vulnerability.fix.versions | join(", ")) |"]
      | unique
      | if length == 0 then empty
        else "", "| Severity | Package | Vulnerability | Fixed in |", "|---|---|---|---|", .[] end' \
      "$out/gateway-$sbom.vulns.json"
  done
} > "$out/vulnerabilities.md"
cat "$out/vulnerabilities.md"
