# Fixture tests for decide.jq (run at build time).
set -euo pipefail
dir=$1
expect() { [ "$1" = "$2" ] || { echo "expected [$2], got [$1]" >&2; exit 1; }; }

idle=$'<!-- idle lane -->\n\n# HEARTBEAT.md\n'
checklists=$(jq -cn --arg idle "$idle" '{
  "/ws/main-work": {source: "/nix/store/a-main-work-HEARTBEAT.md", content: $idle},
  "/ws/modeler": {source: "/nix/store/b-HEARTBEAT-idle.md", content: "# HEARTBEAT.md\n"}
}')
agents='{"agents":[{"id":"main-work","workspace":"/ws/main-work"},{"id":"modeler","workspace":"/ws/modeler"},{"id":"studio","workspace":"/ws/studio"}]}'
hb() { jq -cn --arg id "$1" --arg agent "$2" --argjson enabled "$3" \
  '{id: $id, agentId: $agent, enabled: $enabled, payload: {kind: "heartbeat"}, schedule: {kind: "every", everyMs: 2700000}}'; }
jobs=$(jq -cn --argjson a "$(hb j1 main-work true)" --argjson b "$(hb j2 modeler true)" \
  --argjson c "$(hb j3 studio true)" --argjson d "$(hb j4 main false)" \
  '[$a, $b, $c, $d, {id: "j5", agentId: "main-work", enabled: true, payload: {kind: "agentTurn"}}]')
on='{"enabled":true}'
reply() { jq -cn --arg content "$1" --argjson rev "$2" '{scratch: {content: $content, revision: $rev, updatedAtMs: 1791759467488}, currentRevision: $rev, maxBytes: 262144}'; }
absent='{"scratch":null,"currentRevision":0,"maxBytes":262144}'
# decide <phase> <cron> <jobs> <scratch> [agents]: the tool's stdin, assembled.
decide() {
  printf '{"cron":%s,"jobs":%s,"agents":%s,"scratch":%s,"checklists":%s}' "$2" "$3" "${5:-$agents}" "$4" "$checklists" \
    | jq -c --arg phase "$1" --arg inst merlin -f "$dir/decide.jq"
}
verdict() { local s=$1; shift; decide verdict "$on" "$jobs" "$s" | jq -c "$@"; }

# Only enabled heartbeat jobs tick, and none while the scheduler is off.
expect "$(decide ticking "$on" "$jobs" '{}')" '["j1","j2","j3"]'
expect "$(decide ticking '{"enabled":false}' "$jobs" '{}')" '[]'
expect "$(decide ticking '{}' "$jobs" '{}')" '[]'

# merlin today: every declared checklist matches; nothing to write or report.
scratch=$(jq -cn --argjson a "$(reply "$idle" 1)" --argjson b "$(reply $'# HEARTBEAT.md\n' 1)" --argjson c "$(reply 'studio notes' 3)" \
  '{j1: $a, j2: $b, j3: $c}')
expect "$(verdict "$scratch" '[.[] | [.agentId, .status, .finding]]')" \
  '[["main-work","match",null],["modeler","match",null],["studio","undeclared",null]]'

# An agent or operator rewrite is drift, down to a missing trailing newline.
drifted=$(jq -c --argjson a "$(reply "${idle%$'\n'}" 4)" '.j1 = $a' <<<"$scratch")
expect "$(verdict "$drifted" --arg w "$idle" '.[0] | [.status, .revision, .want == $w]')" '["drift",4,true]'
expect "$(verdict "$drifted" -r '.[0].finding')" \
  "merlin: main-work's heartbeat checklist is not its Nix file (scratch rev 4, changed 2026-10-11T22:57:47Z); the next gateway start puts the Nix file back, so make a lasting change in its HEARTBEAT.md source"

# Declared but never written: each tick runs the generic prompt.
missing=$(jq -c --argjson a "$absent" '.j1 = $a' <<<"$scratch")
expect "$(verdict "$missing" '.[0] | [.status, .current, .revision]')" '["missing",null,0]'

# Undeclared with no scratch: a model turn on the generic prompt every tick.
generic=$(jq -c --argjson a "$absent" '.j3 = $a' <<<"$scratch")
expect "$(verdict "$generic" '.[2].status')" '"generic"'
expect "$(verdict "$generic" -r '.[2].finding')" \
  "merlin: studio's heartbeat ticks every 45m with no checklist, so each tick is a model turn on the generic prompt; give /ws/studio a Nix HEARTBEAT.md or disable the heartbeat"

# A failed read is reported, never treated as absent or matching.
expect "$(verdict "$(jq -c 'del(.j2)' <<<"$scratch")" '.[1] | [.status, .finding]')" \
  "[\"unread\",\"merlin: modeler's heartbeat scratch could not be read\"]"
expect "$(verdict "$(jq -c '.j2 = {"error": "boom"}' <<<"$scratch")" '.[1].status')" '"unread"'

# Two heartbeat jobs for one agent: neither is written.
dupes=$(jq -c --argjson e "$(hb j6 modeler false)" '. + [$e]' <<<"$jobs")
expect "$(decide verdict "$on" "$dupes" "$scratch" | jq -c '[.[] | .status]')" '["match","duplicate","undeclared"]'

# An agent missing from agents.list has no workspace, so no checklist.
expect "$(decide verdict "$on" "$jobs" "$scratch" '{"agents":[]}' | jq -c '[.[] | .status]')" \
  '["undeclared","undeclared","undeclared"]'
echo "heartbeat checklist jq program: all fixtures pass"
