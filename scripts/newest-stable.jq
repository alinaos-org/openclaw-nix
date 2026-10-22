# The newest stable OpenClaw release in a GitHub releases listing, compared with
# release.nix's `current` ($current):
#
#   gh api 'repos/openclaw/openclaw/releases?per_page=100' \
#     | jq -c --arg current 2026.10.5 -f scripts/newest-stable.jq
#
# prints {"version", "published_at", "newer"}, or nothing when the listing has no
# stable release. Releases are ordered by version, not by GitHub's "latest" flag
# or by publication: OpenClaw publishes backports of older lines after newer ones
# (2026.9.33 after 2026.10.4) and correction releases (v2026.7.1-2) that sort
# after their base. Betas, drafts and non-version tags (linux-stable) never count.
def key:
  ltrimstr("v")
  | capture("^(?<y>[0-9]+)\\.(?<m>[0-9]+)\\.(?<n>[0-9]+)(-(?<c>[1-9][0-9]*))?$")
  | [.y, .m, .n, (.c // "0")]
  | map(tonumber);

($current | key) as $cur
| [.[]
    | select((.draft | not) and (.prerelease | not))
    | select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+(-[1-9][0-9]*)?$"))]
| max_by(.tag_name | key)
| select(. != null)
| {version: (.tag_name | ltrimstr("v")), published_at, newer: ((.tag_name | key) > $cur)}
