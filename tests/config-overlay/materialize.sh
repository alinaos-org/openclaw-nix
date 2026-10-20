# Plugin materialization in prepare-config: load paths rewritten into one copied
# set, and old sets pruned to the current one plus the most recently used other.
# A set is reused only when its manifest names this plugin list and every plugin
# is there; anything else under its name is moved aside and rebuilt.
# Run by the config-overlay-prepare check: $prepare, $state.
set -euo pipefail
root=$state/runtime-plugins
mkdir -p "$state" plugins
# Read-only sources, like store paths, so pruning has to make copies writable.
mk() {
  mkdir -p "plugins/$1"
  echo "{\"id\":\"$1\"}" > "plugins/$1/openclaw.plugin.json"
  chmod -R a-w "plugins/$1"
}
mk a
mk b
mk c
render() {
  printf '%s\n' "$@" | jq -R --arg dir "$PWD/plugins/" '$dir + .' | jq -s '{gateway: {port: 1}, plugins: {load: {paths: .}}}' \
    > "$state/openclaw.json"
}
sets() {
  find "$root" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{64}' | wc -l
}
runtime=$state/openclaw-runtime.json

echo "load paths point into one materialized set"
render a
"$prepare"
jq -e --arg r "$root/" '.plugins.load.paths | length == 1 and (.[0] | startswith($r))' "$runtime"
test -f "$(jq -r '.plugins.load.paths[0]' "$runtime")/openclaw.plugin.json"
first=$(jq -r '.plugins.load.paths[0] | split("/")[-2]' "$runtime")
test "$(sets)" = 1
jq -e --arg a "$PWD/plugins/a" '. == [$a]' "$root/$first/.openclaw-nix-plugin-set.json"

echo "a new plugin list keeps the previous set"
sleep 1
render a b
"$prepare"
test "$(sets)" = 2
test -d "$root/$first"

echo "a third keeps only the current set and the one before it"
sleep 1
render a b c
"$prepare"
test "$(sets)" = 2
test ! -e "$root/$first"
jq -e '.plugins.load.paths | length == 3' "$runtime"

echo "old staging goes; anything else under the root stays"
mkdir -p "$root/.plugin-set-x.ABCDEF" "$root/notes"
touch -d '2 hours ago' "$root/.plugin-set-x.ABCDEF"
"$prepare"
test ! -e "$root/.plugin-set-x.ABCDEF"
test -d "$root/notes"

echo "a partial set staged under the next list's id is moved aside and rebuilt"
render a c
id=$(jq -c '.plugins.load.paths // []' "$state/openclaw.json" | sha256sum | cut -d' ' -f1)
# One plugin and no manifest: what a hand-staged set looks like (2026-10-19).
mkdir -p "$root/$id/c"
"$prepare"
test "$(jq -r '.plugins.load.paths[0] | split("/")[-2]' "$runtime")" = "$id"
test -f "$root/$id/a/openclaw.plugin.json"
test -f "$root/$id/c/openclaw.plugin.json"
test -f "$root/$id/.openclaw-nix-plugin-set.json"
untrusted=$(find "$root" -mindepth 1 -maxdepth 1 -type d -name ".untrusted-plugin-set-$id-*")
test -n "$untrusted" && test -d "$untrusted/c" && test ! -e "$untrusted/a"

echo "a complete set is reused, not copied again"
before=$(stat -c %i "$root/$id/a")
"$prepare"
test "$(stat -c %i "$root/$id/a")" = "$before"
test "$(find "$root" -mindepth 1 -maxdepth 1 -type d -name '.untrusted-plugin-set-*' | wc -l)" = 1

echo "a week-old untrusted set goes"
touch -d '8 days ago' "$untrusted"
"$prepare"
test ! -e "$untrusted"
echo "config-overlay materialize: ok"
