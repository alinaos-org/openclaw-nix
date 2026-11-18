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
# decide <phase> <cron> <jobs> <scratch> [agents] [declared]: the tool's stdin, assembled.
decide() {
  printf '{"cron":%s,"jobs":%s,"agents":%s,"scratch":%s,"checklists":%s,"declared":%s}' \
    "$2" "$3" "${5:-$agents}" "$4" "$checklists" "${6:-null}" \
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

# 2026.11.5: doctor converts each heartbeat job into an ordinary agentTurn job
# with skipIfScratchEmpty and no declarationKey, keeping its id and the name
# heartbeat-<agent>, and creates "Proactive check (<agent>)" for an agent that
# only had a HEARTBEAT.md. A cron.list page keeps those, projected, and drops
# every other agentTurn job.
turn() { jq -cn --arg id "$1" --arg agent "$2" --argjson enabled "$3" --arg name "$4" --argjson skip "$5" \
  '{id: $id, agentId: $agent, name: $name, enabled: $enabled, sessionTarget: "isolated", wakeMode: "now",
    payload: {kind: "agentTurn", message: "check in", skipIfScratchEmpty: $skip},
    schedule: {kind: "every", everyMs: 2700000, anchorMs: 1346075}, state: {}}'; }
page=$(jq -cn \
  --argjson a "$(turn j1 main-work true heartbeat-main-work true)" \
  --argjson b "$(turn j2 modeler true heartbeat-modeler true)" \
  --argjson c "$(turn j7 modeler-personal false 'Proactive check (modeler-personal)' true)" \
  --argjson d "$(turn j8 main-work true 'apartment search' true)" \
  --argjson e "$(turn j9 main-work true heartbeat-main-work false)" \
  --argjson f "$(turn j10 main-work true heartbeat-main-work true | jq -c '.declarationKey = "nix:heartbeat-main-work"')" \
  --argjson g "$(turn j11 modeler true heartbeat-main-work true)" \
  --argjson h "$(hb j3 studio true)" \
  '{jobs: [$a, $b, $c, $d, $e, $f, $g, $h], hasMore: false}')
converted=$(jq -c --arg phase page --arg inst merlin -f "$dir/decide.jq" <<<"$page")
expect "$(jq -c '[.[] | .id]' <<<"$converted")" '["j1","j2","j7","j3"]'
expect "$(jq -c '.[0]' <<<"$converted")" \
  '{"id":"j1","agentId":"main-work","name":"heartbeat-main-work","declarationKey":null,"enabled":true,"schedule":{"kind":"every","everyMs":2700000,"anchorMs":1346075},"payload":{"kind":"agentTurn","skipIfScratchEmpty":true}}'
expect "$(jq -c --arg phase page --arg inst merlin -f "$dir/decide.jq" <<<'{}')" '[]'

# Converted jobs tick, match and drift exactly as heartbeat jobs did (rescue's
# 2026.11.4 heartbeat job, j3, beside them).
expect "$(decide ticking "$on" "$converted" '{}')" '["j1","j2","j3"]'
expect "$(decide verdict "$on" "$converted" "$scratch" | jq -c '[.[] | [.agentId, .status]]')" \
  '[["main-work","match"],["modeler","match"],["studio","undeclared"]]'
expect "$(decide verdict "$on" "$converted" "$drifted" | jq -c '.[0] | [.id, .status, .revision]')" '["j1","drift",4]'

# The declared ticking set (heartbeatChecklists.ticking.<instance>): nothing
# to report when it matches, when Nix declares nothing, or with the scheduler off.
expect "$(decide declared "$on" "$converted" '{}' "$agents" '["main-work","modeler","studio"]')" '[]'
expect "$(decide declared "$on" "$converted" '{}' "$agents")" '[]'
expect "$(decide declared '{"enabled":false}' "$converted" '{}' "$agents" '[]')" '[]'
# A ticking check Nix declares off, and a declared agent with none ticking.
expect "$(decide declared "$on" "$converted" '{}' "$agents" '["main-work","studio","rescue"]' | jq -r '.[]')" \
  "merlin: modeler's proactive check ticks every 45m but Nix declares it off
merlin: rescue is declared to tick but has no enabled proactive check"
# prod: every check disabled and none declared; then one switched on.
expect "$(decide declared "$on" "$(jq -c 'map(.enabled = false)' <<<"$converted")" '{}' "$agents" '[]')" '[]'
expect "$(decide declared "$on" "$(jq -c '[.[2] | .enabled = true]' <<<"$converted")" '{}' "$agents" '[]' | jq -r '.[]')" \
  "merlin: modeler-personal's proactive check ticks every 45m but Nix declares it off"
echo "heartbeat checklist jq program: all fixtures pass"
