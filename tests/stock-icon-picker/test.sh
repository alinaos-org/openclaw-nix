# scripts/stock-icon-picker.sh (failed-step, mark, fallback) and new-release.py's
# `sessionIconPicker = false;` line, with stand-ins for gh and nix (./gh, ./nix)
# and a local git origin.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
scripts=${scripts:-$here/../../scripts}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
expect() {
  [ "$1" = "$2" ] || { printf 'expected %s\n     got %s\n' "$2" "$1" >&2; exit 1; }
}
fails() {
  if "$@" > "$work/out" 2>&1; then
    echo "expected a failure: $*" >&2; cat "$work/out" >&2; exit 1
  fi
}

# The scripts and stand-ins run from $work, on this bash (the build sandbox has
# no /usr/bin/env).
mkdir -p "$work/bin" "$work/scripts"
for f in "$here/gh" "$here/nix"; do
  { echo "#!$BASH"; tail -n +2 "$f"; } > "$work/bin/$(basename "$f")"
done
{ echo "#!$BASH"; tail -n +2 "$scripts/stock-icon-picker.sh"; } > "$work/scripts/stock-icon-picker.sh"
cp "$scripts/new-release.py" "$work/scripts/new-release.py"
chmod +x "$work/bin/"* "$work/scripts/"*
export PATH="$work/bin:$PATH"
picker=$work/scripts/stock-icon-picker.sh

# failed-step: the step the log stopped in, or nothing when every step finished.
cat > "$work/ui-test.log" <<'LOG'
>> [timing] ui:build...
vite v7 building for production...
>> [timing] ui:build: 41s
>> [timing] test: openclaw-nix Control UI changes...
>> [timing] test: openclaw-nix Control UI changes: 63s
openclaw-nix: warning: ui/src/components/session-menu.test.ts has no test named "x": ownUiTestExclusions is stale (README, Session icons)
>> [timing] test: upstream Control UI session-menu.test.ts...
 FAIL  ui/src/components/session-menu.test.ts > leaves custom entry on Escape
LOG
expect "$("$picker" failed-step < "$work/ui-test.log")" "test: upstream Control UI session-menu.test.ts"
printf '>> [timing] build: tsdown...\nerror TS2307\n' > "$work/tsdown.log"
expect "$("$picker" failed-step < "$work/tsdown.log")" "build: tsdown"
printf '>> [timing] pnpm prune --prod...\n>> [timing] pnpm prune --prod: 9s\nbroken symlink\n' > "$work/install.log"
expect "$("$picker" failed-step < "$work/install.log")" ""

# new-release.py's line: written once per entry, and recognised (to drop it from
# the next release's copied entry) however it is written.
python3 - "$work/scripts/new-release.py" <<'PY'
import importlib.machinery, sys
nr = importlib.machinery.SourceFileLoader("new_release", sys.argv[1]).load_module()
keep = '  "2026.11.2" = {\n    # The tag.\n    rev = "abc";\n    desktopDebHash = "sha256-x";\n'
for written in [
    nr.PICKER_OFF,
    nr.picker_off_build("test: upstream Control UI session-menu.test.ts"),
    "    sessionIconPicker = false; # breaks tsgo on 2026.11.1\n",
    "    # off by hand\n      sessionIconPicker=false ;\n",
]:
    entry = keep + written + "  };\n"
    assert nr.PICKER_OFF_RE.search(entry), written
    assert nr.PICKER_OFF_RE.sub("", entry) == keep + "  };\n", (written, nr.PICKER_OFF_RE.sub("", entry))
assert not nr.PICKER_OFF_RE.search(keep + "    sessionIconPicker = true;\n  };\n")
for bad in ["ui:build\n    sessionIconPicker = true;", "a`b", ""]:
    try:
        nr.picker_off_build(bad)
    except SystemExit:
        continue
    raise AssertionError(f"accepted step {bad!r}")
PY

# A release checkout: release.nix, a releases.nix entry, and an origin whose
# release branch has release-watch's commit on main.
bot="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
as() {
  local name=$1 email=$2
  shift 2
  GIT_AUTHOR_NAME=$name GIT_AUTHOR_EMAIL=$email GIT_COMMITTER_NAME=$name GIT_COMMITTER_EMAIL=$email git "$@"
}
fixture() {
  rm -rf "$work/origin.git" "$work/seed" "$work/co"
  git init -q --bare -b main "$work/origin.git"
  git init -q -b main "$work/seed"
  cd "$work/seed"
  printf '{\n  current = "2026.10.10";\n  accepted = ["2026.10.10"];\n}\n' > release.nix
  printf '{\n  "2026.10.10" = {\n    rev = "a";\n  };\n}\n' > releases.nix
  as Matt matt@example.com add -A
  as Matt matt@example.com commit -q -m main
  git push -q "$work/origin.git" main
  git switch -q -c release-2026.11.1
  printf '{\n  current = "2026.11.1";\n  accepted = ["2026.10.10" "2026.11.1"];\n}\n' > release.nix
  printf '{\n  "2026.11.1" = {\n    rev = "b";\n  };\n  "2026.10.10" = {\n    rev = "a";\n  };\n}\n' > releases.nix
  as "github-actions[bot]" "$bot" commit -q -am "openclaw: 2026.11.1"
  git push -q "$work/origin.git" release-2026.11.1
  git clone -q "$work/origin.git" "$work/co"
  cd "$work/co"
  git checkout -q --detach origin/release-2026.11.1
  export GH_STATE=$work/gh.json
  echo '{"labels": [], "issues": [], "prs": [{"number": 7, "head": "release-2026.11.1", "title": "openclaw: 2026.11.1", "labels": [], "comments": []}], "runs": []}' > "$GH_STATE"
}
gh_state() { jq -r "$1" "$GH_STATE"; }

# mark: label, title, one comment and the issue; a second run changes nothing.
fixture
expect "$(RUN_URL=https://ci/run/1 "$picker" mark 2026.11.1 "the patch does not apply")" "#1"
expect "$(gh_state '.prs[0].title')" "openclaw: 2026.11.1 (stock session icon picker)"
expect "$(gh_state '.prs[0].labels | join(",")')" "stock-icon-picker"
expect "$(gh_state '.prs[0].comments | length')" 1
expect "$(gh_state '.issues | length')" 1
gh_state '.issues[0].body' | grep -qF "<!-- stock-icon-picker: 2026.11.1 -->"
gh_state '.issues[0].body' | grep -qF "the patch does not apply (https://ci/run/1)"
expect "$("$picker" mark 2026.11.1 "again")" "#1"
expect "$(gh_state '[.prs[0].comments, .issues[0].comments] | map(length) | add')" 1
# A later release on the same open issue: a comment there, its title suffixed
# inside the parentheses it has.
jq '.prs += [{"number": 8, "head": "release-2026.11.2", "title": "openclaw: 2026.11.2 (pinning failed at the runtime plugin locks)", "labels": [], "comments": []}]' \
  "$GH_STATE" > "$GH_STATE.new" && mv "$GH_STATE.new" "$GH_STATE"
expect "$("$picker" mark 2026.11.2 "its releases.nix entry has it")" "#1"
expect "$(gh_state '.issues[0].comments | length')" 1
expect "$(gh_state '.prs[1].title')" "openclaw: 2026.11.2 (pinning failed at the runtime plugin locks; stock session icon picker)"
expect "$("$picker" mark 2026.11.2 "its releases.nix entry has it")" "#1"
expect "$(gh_state '.issues[0].comments | length')" 1

# fallback: a Control UI test step that fails with the picker, a build that
# passes without it: the line is committed to the branch as the bot, the pull
# request is marked, and CI runs on the new commit.
fixture
export NIX_LOG=$work/ui-test.log
"$picker" fallback 2026.11.1 > "$work/out" 2>&1 || { cat "$work/out" >&2; exit 1; }
git -C "$work/origin.git" show release-2026.11.1:releases.nix > "$work/pushed.nix"
grep -qxF '    #   test: upstream Control UI session-menu.test.ts' "$work/pushed.nix"
expect "$(grep -c 'sessionIconPicker = false;' "$work/pushed.nix")" 1
expect "$(git -C "$work/origin.git" log -1 --format='%ae %s' release-2026.11.1)" "$bot openclaw: 2026.11.1 with the stock session icon picker"
expect "$(git -C "$work/origin.git" rev-list --count main..release-2026.11.1)" 2
expect "$(gh_state '.runs | join(",")')" "release-2026.11.1"
expect "$(gh_state '.prs[0].labels | join(",")')" "stock-icon-picker"
grep -q '^::warning::OpenClaw 2026.11.1 falls back to the stock session icon picker' "$work/out"
# Already off: nothing more to fall back from.
git checkout -q --detach origin/release-2026.11.1 && git fetch -q origin && git checkout -q --detach origin/release-2026.11.1
fails "$picker" fallback 2026.11.1

# Left alone: a failure in a step the picker does not change, outside every step,
# a branch someone else committed to, a branch that moved on, and a gateway that
# fails without the patch too. Nothing is pushed in any of them.
untouched() {
  expect "$(git -C "$work/origin.git" rev-list --count main..release-2026.11.1)" 1
  expect "$(gh_state '.runs | length')" 0
  git diff --quiet
}
fixture
NIX_LOG=$work/tsdown.log fails "$picker" fallback 2026.11.1
grep -qF 'failed at `build: tsdown`, a step the session icon picker does not change' "$work/out"
untouched
NIX_LOG=$work/install.log fails "$picker" fallback 2026.11.1
untouched
NIX_LOG='' fails "$picker" fallback 2026.11.1
untouched
STOCK_BUILD=fail fails "$picker" fallback 2026.11.1
grep -qF 'fails without the session icon picker patch too' "$work/out"
untouched
as Matt matt@example.com commit -q --allow-empty -m "re-port attempt"
git push -q origin HEAD:refs/heads/release-2026.11.1
fails "$picker" fallback 2026.11.1
grep -qF 'commits besides release-watch' "$work/out"
git checkout -q --detach HEAD~1
fails "$picker" fallback 2026.11.1
grep -qF "is not release-2026.11.1's head" "$work/out"
expect "$(gh_state '.runs | length')" 0
echo "stock session icon picker: ok"
