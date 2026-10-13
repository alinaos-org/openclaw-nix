#!/usr/bin/env bash
# Build flake attributes in a memory-capped user scope with a watchdog.
#
#   build-capped.sh <log> [--max <size>] [--cores <n>] <attr>...
#
# Runs from the current directory (a worktree). Extra arguments go to `nix build`
# (for example --override-input). One scope per call: batch attributes that share an
# evaluation, and split heavy evaluations (a host's toplevel and its image or installer
# checks) into separate calls. The watchdog stops the scope when the host runs low,
# counting half of the ZFS ARC above its floor as available where there is one (the
# ARC shrinks under pressure; MemAvailable does not count it). --cores (default 2) is
# per build job; raise it for one large derivation, such as the gateway's source build
# (it peaks around 15 GB: --max 16G --cores 8), together with --max. systemd-run
# expands ${VAR} in its arguments, so pass Nix expressions without `${`.
#
# The 2026.10.1 "process group remained active" failure in plugins:assets:build had
# two demonstrated causes: missing ps in the build sandbox (procps in openclaw-nix
# packages/gateway) and esbuild stop() returning before its unreferenced service
# child was reaped (packages/gateway/fix-esbuild-shutdown.mjs). Keep the upstream
# process-group guard intact.
# Retries are disabled by default so regressions cannot be hidden by timing.
# BUILD_FLAKY_RETRIES can explicitly opt into bounded retries for investigation;
# a retry success alone does not establish that either cause has been repaired.
set -uo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <log> [--max <size>] [--cores <n>] <attr>..." >&2; exit 64; }
log=$1; shift
max=6500M
cores=2
while :; do
  case "${1:-}" in
    --max) max=$2; shift 2 ;;
    --cores) cores=$2; shift 2 ;;
    *) break ;;
  esac
done
: > "$log"
flaky='Managed command exited while its process group remained active'
retries=${BUILD_FLAKY_RETRIES:-0}
attempt=0
while :; do
  attempt=$((attempt + 1))
  unit=openclaw-build-$$-$attempt
  mark=$(wc -l < "$log")
  (
    while sleep 5; do
      systemctl --user is-active --quiet "$unit.scope" || break
      arc=$(awk '$1=="size"{s=$3} $1=="c_min"{m=$3} END{v=(s-m)/2/1048576; print (v>0?int(v):0)}' /proc/spl/kstat/zfs/arcstats 2>/dev/null || echo 0)
      avail=$(( $(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo) + arc ))
      if [ "$avail" -lt 2500 ]; then
        echo "WATCHDOG: about ${avail} MB available, stopping build" >> "$log"
        systemctl --user stop "$unit.scope"
        break
      fi
    done
  ) &
  start=$(date +%s)
  systemd-run --user --scope --quiet --unit="$unit" -p MemoryHigh="$max" -p MemoryMax="$max" -p MemorySwapMax=0 \
    env NIX_CONFIG="max-jobs = 1
cores = $cores" nix build --no-link --print-out-paths --accept-flake-config --keep-going "$@" >> "$log" 2>&1
  rc=$?
  echo "EXIT $rc after $(( $(date +%s) - start ))s" >> "$log"
  this_run=$(tail -n +"$((mark + 1))" "$log")
  if [ "$rc" -ne 0 ] && [ "$attempt" -le "$retries" ] && grep -qF "$flaky" <<<"$this_run" && ! grep -q '^WATCHDOG' <<<"$this_run"; then
    echo "RETRY $attempt: explicitly requested asset process-group retry; inspect sandbox/lifecycle evidence" >> "$log"
    continue
  fi
  break
done
grep -E "^EXIT|WATCHDOG|^RETRY" "$log"
grep -A12 "^error:" "$log" | grep -v "^building\|^copying" | head -20
exit $rc
