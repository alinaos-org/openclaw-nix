#!/usr/bin/env bash
# A release that builds with OpenClaw's own session icon picker, for the workflows:
#
#   scripts/stock-icon-picker.sh mark <version> <why>
#   scripts/stock-icon-picker.sh fallback <version>
#   scripts/stock-icon-picker.sh failed-step < <gateway build log>
#
# mark: a release whose releases.nix entry has `sessionIconPicker = false;` is
# labelled stock-icon-picker. Its open release pull request gets the label,
# "stock session icon picker" in its title and a comment saying why, and the
# open re-port issue with the label gets a comment for the release (or is
# opened with the re-port's checklist). It changes nothing the second time for
# the same release. Prints the issue's reference. release-watch runs it when its
# dry run turns the picker off, CI's eval job whenever a release branch evaluates
# it off (a line set by hand, an orphaned branch's pull request).
#
# fallback: CI's build job on a release branch whose gateway build failed. When
# the build stopped in a step the picker patch changes (the Control UI build or
# its tests: an upstream test renamed or added, a hook that applies but no longer
# compiles) and the gateway builds without the patch, it sets the line
# (new-release.py --icon-picker-off), pushes that commit to the branch, caches
# the stock build, marks the release and dispatches CI on the new commit. Any
# other failure is left as it is (exit 1), and so is a branch anyone besides
# release-watch has committed to.
#
# failed-step: the gateway-build.sh step a build log stopped in (its last
# ">> [timing] <step>..." line, with no finish after it), or nothing.
#
# Environment: GH_TOKEN; RUN_URL, this run's page, for the notes; for fallback,
# CACHIX_CACHE and CACHIX_AUTH_TOKEN to cache the stock build.
set -euo pipefail

label=stock-icon-picker
bot="41898282+github-actions[bot]@users.noreply.github.com"
here=$(cd "$(dirname "$0")" && pwd)

die() {
  echo "stock-icon-picker: $*" >&2
  exit 1
}

failed_step() {
  local last
  last=$(sed -n 's/^>> \[timing\] //p' | tail -n 1)
  case $last in
    *...) echo "${last%...}" ;;
  esac
}

mark() {
  local v=$1 why=$2 marker issue url pr number title run
  run=${RUN_URL:+ ($RUN_URL)}
  # The issue and comments carry it, so a second run finds the release there.
  marker="<!-- stock-icon-picker: $v -->"
  gh label create "$label" --color fbca04 --force \
    --description "Builds with OpenClaw's own session icon picker; openclaw-nix's patch needs a re-port" >/dev/null
  issue=$(gh issue list --state open --label "$label" --json number --jq '.[0].number // empty')
  if [ -n "$issue" ]; then
    if ! gh issue view "$issue" --json body,comments --jq '[.body, .comments[].body] | join("\n")' | grep -qF -- "$marker"; then
      gh issue comment "$issue" --body "OpenClaw $v builds with the stock session icon picker too: $why$run. Re-port on its release.
$marker" >/dev/null
    fi
  else
    url=$(gh issue create --label "$label" --title "Re-port the session icon picker (OpenClaw $v)" --body-file - <<BODY
OpenClaw $v builds with OpenClaw's own session icon picker: $why$run. Its \`releases.nix\` entry has \`sessionIconPicker = false;\`, so the release builds and ships without openclaw-nix's picker patch (\`packages/gateway/patches/session-icon-picker.patch\`) and its tests. Sessions keep their saved icons and still show them.

- [ ] Re-port the hook in a scratch repository of the release source (\`nix build .#gateway.passthru.upstreamSource\`) and regenerate the patch with \`git diff\`; or, when the patch applies and an upstream Control UI test fails, update \`ownUiTestExclusions\` (\`packages/gateway/default.nix\`) and \`session-icon-menu.test.ts\`.
- [ ] A changed patch keeps the previous one as \`patches/<previous release>/session-icon-picker.patch\`, chosen with \`lib.versionOlder\` in \`packages/gateway/default.nix\`.
- [ ] Delete \`sessionIconPicker = false;\` and its comment from the release's entry (\`scripts/new-release.py <release> --icon-picker-only\` says when the patch applies again). If the release was already tagged, bump \`localRevision\` in \`packages/gateway/default.nix\`.
- [ ] The build's Control UI tests pass (CI \`build\`), \`ownUiTestExclusions\` included, with no \`openclaw-nix: warning:\` in its log.
- [ ] After the merge, dispatch \`tag-release\` for the fix release (\`<release>-r2\` or later).

$marker
BODY
    )
    issue=${url##*/}
  fi
  pr=$(gh pr list --state open --head "release-$v" --json number,title,labels --jq '.[0] // empty')
  if [ -n "$pr" ] && ! jq -e --arg l "$label" 'any(.labels[]; .name == $l)' <<<"$pr" >/dev/null; then
    number=$(jq -r .number <<<"$pr")
    title=$(jq -r .title <<<"$pr")
    case $title in
      *"stock session icon picker"*) ;;
      *")") title="${title%)}; stock session icon picker)" ;;
      *) title="$title (stock session icon picker)" ;;
    esac
    gh pr edit "$number" --add-label "$label" --title "$title" >/dev/null
    gh pr comment "$number" --body "This release builds with OpenClaw's own session icon picker: $why$run. Sessions keep their saved icons and still show them; the re-port is #$issue." >/dev/null
  fi
  echo "#$issue"
}

fallback() {
  local v=$1 branch="release-$1" head remote others drv log step gateway issue
  [ "$(nix eval --raw -f release.nix current)" = "$v" ] || die "release.nix's current is not $v"
  head=$(git rev-parse HEAD)
  remote=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
  [ "$head" = "$remote" ] || die "this build is not $branch's head ($head; $branch is at ${remote:-nothing}): not falling back"
  [ "$(git rev-parse --is-shallow-repository)" = false ] || git fetch --quiet --unshallow origin
  git fetch --quiet origin main
  others=$(git log --format=%ae origin/main..HEAD | grep -vxF "$bot" || true)
  [ -z "$others" ] || die "$branch has commits besides release-watch's: not falling back (set the line by hand there)"
  [ "$(nix eval --json .#gateway.passthru.sessionIconPicker)" = true ] ||
    die "$v already builds with the stock picker: the failure is not the picker's"
  drv=$(nix eval --raw .#gateway.drvPath)
  log=$(nix log "$drv" 2>/dev/null) || die "no build log for $drv: the gateway build itself did not run"
  step=$(failed_step <<<"$log")
  case $step in
    "ui:build" | "test: openclaw-nix Control UI changes" | "test: upstream Control UI "*) ;;
    "") die "the gateway build failed outside its build steps: not the session icon picker's" ;;
    *) die "the gateway build failed at \`$step\`, a step the session icon picker does not change" ;;
  esac
  echo "the gateway build failed at \`$step\`: building $v without the session icon picker patch"
  python3 "$here/new-release.py" "$v" --icon-picker-off "$step"
  if ! gateway=$(nix build -L --max-jobs 1 --no-link --print-out-paths .#gateway); then
    git checkout -- releases.nix
    die "the gateway fails without the session icon picker patch too: not the picker's"
  fi
  if [ -n "${CACHIX_CACHE:-}" ] && [ -n "${CACHIX_AUTH_TOKEN:-}" ]; then
    cachix push "$CACHIX_CACHE" "$(nix eval --raw .#gateway.pnpmDeps.outPath)" "$gateway"
  fi
  git -c user.name="github-actions[bot]" -c user.email="$bot" commit --quiet releases.nix \
    -m "openclaw: $v with the stock session icon picker" \
    -m "The session icon picker patch applies to $v, but the gateway build fails at \`$step\` with it and passes without it${RUN_URL:+ ($RUN_URL)}."
  git push --quiet origin "HEAD:refs/heads/$branch"
  # Its own process, so a failed gh call stops it (errexit is off in `||`).
  issue=$("$here/stock-icon-picker.sh" mark "$v" "the patch applies, but the gateway build fails at \`$step\` with it and passes without it") ||
    { issue=""; echo "::warning::could not label the release or open the session icon picker re-port issue"; }
  echo "::warning::OpenClaw $v falls back to the stock session icon picker (the build failed at \`$step\`): $(git rev-parse --short HEAD) is pushed to $branch; re-port: ${issue:-see the issues labelled $label}"
  # Last: the new run cancels this one (the workflow's concurrency group).
  gh workflow run ci.yml --ref "$branch"
}

case ${1:-} in
  mark) [ $# -eq 3 ] || die "usage: stock-icon-picker.sh mark <version> <why>"; mark "$2" "$3" ;;
  fallback) [ $# -eq 2 ] || die "usage: stock-icon-picker.sh fallback <version>"; fallback "$2" ;;
  failed-step) failed_step ;;
  *) die "usage: stock-icon-picker.sh mark <version> <why> | fallback <version> | failed-step < <log>" ;;
esac
