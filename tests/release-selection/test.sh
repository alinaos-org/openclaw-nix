# scripts/newest-stable.jq against a GitHub releases listing shaped like
# openclaw/openclaw's: betas, a draft, a non-version tag, a backport published after
# the newest release, and correction releases.
set -euo pipefail
here=$(dirname "$0")
select=${select:-$here/../../scripts/newest-stable.jq}
fixture=${fixture:-$here/releases.json}
pick() { jq -c --arg current "$1" -f "$select" "${2:-$fixture}"; }
expect() {
  [ "$1" = "$2" ] || { printf 'expected %s\n     got %s\n' "$2" "$1" >&2; exit 1; }
}

# The newest by version, although a backport was published after it and the draft
# and the beta are newer.
expect "$(pick 2026.10.4)" '{"version":"2026.10.5","published_at":"2026-10-18T21:47:25Z","newer":true}'
expect "$(pick 2026.10.5)" '{"version":"2026.10.5","published_at":"2026-10-18T21:47:25Z","newer":false}'
# Never older than current, and 10 sorts after 9 (numbers, not strings).
expect "$(pick 2026.10.10 | jq -r .newer)" false
expect "$(pick 2026.9.40 | jq -r .newer)" true

# A correction release sorts after its base, and a later correction after an earlier one.
corrections=$(mktemp)
trap 'rm -f "$corrections"' EXIT
jq '[.[] | select(.tag_name == "v2026.10.5")] + [{"tag_name": "v2026.10.5-1", "draft": false, "prerelease": false, "published_at": "2026-10-19T09:00:00Z"}]' \
  "$fixture" > "$corrections"
expect "$(pick 2026.10.5 "$corrections" | jq -c '[.version, .newer]')" '["2026.10.5-1",true]'
expect "$(pick 2026.10.5-1 "$corrections" | jq -r .newer)" false
expect "$(pick 2026.10.5-2 "$corrections" | jq -r .newer)" false

# No stable release at all: nothing.
expect "$(echo '[{"tag_name": "v2026.11.1-beta.1", "draft": false, "prerelease": true, "published_at": null}]' \
  | jq -c --arg current 2026.10.5 -f "$select")" ""
echo "release selection: ok"
