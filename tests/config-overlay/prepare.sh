# The prepare-config chain against a scratch state, with a stub openclaw whose
# `config validate` rejects thinkingDefault "bogus". Run by the
# config-overlay-prepare check: $prepare, $state.
set -euo pipefail
nix_render=$state/openclaw.json
runtime=$state/openclaw-runtime.json
mkdir -p "$state"
render() { printf '%s\n' "$1" > "$nix_render"; }
start() { "$prepare"; }

echo "first start renders the Nix config"
render '{"agents":{"defaults":{"thinkingDefault":"low"}},"gateway":{"port":1}}'
start
jq -e '.agents.defaults.thinkingDefault == "low" and .gateway.port == 1' "$runtime"

echo "a Control UI change to an allowed path survives a restart; a denied one is reverted and reported"
jq '.agents.defaults.thinkingDefault = "high" | .gateway.port = 2' "$runtime" > "$runtime.edit"
mv "$runtime.edit" "$runtime"
start
jq -e '.agents.defaults.thinkingDefault == "high"' "$runtime"
jq -e '.gateway.port == 1' "$runtime"
jq -e '[.. | strings | select(test("gateway"))] | length > 0' "$state/config-drift.json"
jq -e '.entries | length == 1' "$state/config-overlay.json"

echo "the first start on a new package version migrated once"
test -s "$state/.migrated-for-version"
ls "$state"/backups/pre-migrate-*/state-snapshot.tgz

echo "an overlay entry the Nix source adopts prunes itself"
render '{"agents":{"defaults":{"thinkingDefault":"high"}},"gateway":{"port":1}}'
start
jq -e '.entries | length == 0' "$state/config-overlay.json"
jq -e '.agents.defaults.thinkingDefault == "high"' "$runtime"

echo "a merged config the gateway rejects falls back to the pure Nix render, keeping the overlay"
jq '.agents.defaults.thinkingDefault = "bogus"' "$runtime" > "$runtime.edit"
mv "$runtime.edit" "$runtime"
start
jq -e '.agents.defaults.thinkingDefault == "high"' "$runtime"
jq -e '.entries | length == 1' "$state/config-overlay.json"
cmp "$runtime" "$runtime.last-good"
echo "config-overlay prepare chain: ok"
