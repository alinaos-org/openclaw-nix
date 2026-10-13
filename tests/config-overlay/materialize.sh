# Plugin materialization in prepare-config: load paths rewritten into one copied
# set, and old sets pruned to the current one plus the most recently used other.
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
echo "config-overlay materialize: ok"
