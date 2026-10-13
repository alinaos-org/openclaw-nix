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
echo "config-overlay fold: ok"
