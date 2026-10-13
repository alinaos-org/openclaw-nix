# fold-overlay.py: roster entries, renames where the source has them, plain
# paths, deletes, and what it refuses. Run by the config-overlay-fold check: $fold.
set -euo pipefail
cat > source.json <<'JSON'
{"agents": {"defaults": {"memorySearch": {"provider": "a"}, "thinkingDefault": "low"},
            "list": [{"id": "main", "model": "x"}]},
 "talk": {"voice": "old"}}
JSON
cat > overlay.json <<'JSON'
{"entries": [
  {"path": ["agents", "entries", "main", "model"], "op": "set", "value": "y"},
  {"path": ["agents", "entries", "ghost", "model"], "op": "set", "value": "z"},
  {"path": ["agents", "entries", "main"], "op": "set", "value": {}},
  {"path": ["memory", "search", "provider"], "op": "set", "value": "b"},
  {"path": ["agents", "defaults", "thinkingDefault"], "op": "set", "value": "high"},
  {"path": ["talk", "voice"], "op": "delete"},
  {"path": ["messages", "ackReaction"], "op": "set", "value": "+"}
]}
JSON
echo '[{"from": ["memory", "search"], "to": ["agents", "defaults", "memorySearch"]}]' > renames.json
python3 "$fold" overlay.json source.json renames.json | tee summary
jq -e '.agents.list[0].model == "y"' source.json
jq -e '.agents.defaults.memorySearch.provider == "b" and (has("memory") | not)' source.json
jq -e '.agents.defaults.thinkingDefault == "high"' source.json
jq -e '.talk | has("voice") | not' source.json
jq -e '.messages.ackReaction == "+"' source.json
grep -q 'agent ghost not in' summary
grep -q 'whole-agent replacement' summary

# A delete the source cannot carry (the render adds the key), an excluded
# subtree, and nothing else: reported, and the hand-formatted file is left
# byte for byte, so the nightly sync has nothing to commit.
printf '%s\n' '{"agents": {"list": [{"id": "studio", "skills": ["a"]}]}, "tools": {"alsoAllow": ["x__*"]}}' > compact.json
cp compact.json compact.orig
cat > overlay2.json <<'JSON'
{"entries": [
  {"path": ["talk"], "op": "delete"},
  {"path": ["agents", "entries", "studio", "heartbeat"], "op": "delete"},
  {"path": ["ui", "prefs", "sidebarEntries"], "op": "set", "value": ["route:cron"]}
]}
JSON
echo '[["ui"]]' > exclude.json
python3 "$fold" overlay2.json compact.json renames.json exclude.json | tee summary2
cmp compact.json compact.orig
grep -q 'Folded 0' summary2
grep -q 'talk (deleted, but the source does not set it' summary2
grep -q 'agents.entries.studio.heartbeat (deleted, but the source does not set it' summary2
grep -q 'Kept in the overlay (1' summary2
grep -q -- '- ui.prefs.sidebarEntries' summary2
echo "config-overlay fold: ok"
