#!/usr/bin/env bash
# Run the gateway hotfix layer's own installPhase against a scratch copy and report
# every failing command, not just the first.
#
#   scratch-patch-chain.sh [<flake attr of the hotfix package>] [<workdir>]
#
# Default attr: OPENCLAW_UPGRADE_HOTFIX_ATTR from host.env beside this script (the
# host's hotfixed gateway package), else `.#gateway-hotfixed` (run from an
# openclaw-nix checkout; packages/hotfix/default.nix).
# A Nix build stops at the first patch whose anchors moved and takes a minute or more
# per round; 2026.10.1 broke five patches at once. The base package must already be
# built: when the layer fails in a real build, it is. Each command runs in order with
# errexit off, so a later patch is still tried after an earlier one fails. A patch
# that failed may have written part of its change, so when re-running one patch use a
# fresh copy (this script makes one per run). The copy is about 2.6 GB on /home and is
# deleted at the end unless KEEP=1. Assumes one command per line, as the hotfix layer
# writes them.
set -uo pipefail
here=$(dirname "$(readlink -f "$0")")
# shellcheck source=/dev/null
[ ! -f "$here/host.env" ] || . "$here/host.env"
attr=${1:-${OPENCLAW_UPGRADE_HOTFIX_ATTR:-.#gateway-hotfixed}}
work=${2:-${OPENCLAW_UPGRADE_BACKUP_ROOT:-$HOME/openclaw-backups}/scratch-patch-chain}
phase=$(nix eval --raw "$attr.installPhase") || { echo "cannot evaluate $attr.installPhase" >&2; exit 2; }
base=$(grep -oE '^cp -a /nix/store/[^ ]+/\.' <<<"$phase" | head -1 | sed 's|^cp -a ||; s|/\.$||')
[ -n "$base" ] && [ -d "$base" ] || { echo "base package ${base:-?} is not built; build the gateway first" >&2; exit 2; }
rm -rf "$work"
mkdir -p "$work"
export out="$work"
fails=0 n=0
while IFS= read -r cmd; do
  [ -n "${cmd// }" ] || continue
  n=$((n + 1))
  short=$(sed -E 's|/nix/store/[a-z0-9]{32}-||g' <<<"$cmd" | cut -c1-140)
  if output=$(bash -c "$cmd" 2>&1); then
    echo "ok   $short"
  else
    fails=$((fails + 1))
    echo "FAIL $short"
    grep -vE '^\s+at |^Node\.js|^\s*$|triggerUncaught|run_main|^\s+\^$' <<<"$output" | head -6 | sed 's/^/       /'
  fi
done <<<"$phase"
[ "${KEEP:-0}" = 1 ] || rm -rf "$work"
echo "$n commands, $fails failed"
[ "$fails" = 0 ]
