#!/usr/bin/env bash
# Get a release's compile onto this host the faster way: compile it here when its pnpm
# dependency set is already local, otherwise fetch it from the cache.
#
#   fetch-or-compile.sh [--compile | --fetch] [<log>]
#
# Run from the host's candidate worktree after `nix flake update openclaw-nix`, before
# building the host's packages. It resolves openclaw-nix's own gateway through the host's
# locked input (`--inputs-from .`), the exact compile a `sharedBuild` host uses.
#
# - Already in the store: nothing to do.
# - pnpm dependency set in the store (the release kept its hash) and nothing but the
#   source and the compile left to build: compile here with substitution off. About 5
#   minutes on 8 cores, and the same store path CI pushed. The cached compile is a large
#   download (2026.10.3: 880 MB compressed, 2.9 GB unpacked) that a slow link turns into
#   hours, and Nix restarts it from zero after five dropped connections.
# - Otherwise: fetch from the cache, where the dependency download is the real saving.
#
# --compile or --fetch forces a branch. The build runs through build-capped.sh, with
# OPENCLAW_UPGRADE_COMPILE_MAX (16G) and OPENCLAW_UPGRADE_COMPILE_CORES (8).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mode=auto
case "${1:-}" in
  --compile) mode=compile; shift ;;
  --fetch) mode=fetch; shift ;;
  -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
esac
log=${1:-${TMPDIR:-/tmp}/fetch-or-compile-$(date +%Y%m%dT%H%M%S).log}
max=${OPENCLAW_UPGRADE_COMPILE_MAX:-16G}
cores=${OPENCLAW_UPGRADE_COMPILE_CORES:-8}

evalraw() { nix eval --raw --inputs-from . "openclaw-nix#$1"; }
gw_out=$(evalraw gateway.outPath)
gw_drv=$(evalraw gateway.drvPath)
deps=$(evalraw gateway.pnpmDeps.outPath)
echo "compile: $gw_out"

if nix-store --check-validity "$gw_out" 2>/dev/null; then
  echo "already in the store; nothing to do"
  exit 0
fi

if [ "$mode" = auto ]; then
  if ! nix-store --check-validity "$deps" 2>/dev/null; then
    echo "pnpm dependency set not local ($deps): fetching from the cache"
    mode=fetch
  else
    # With substitution off, anything missing besides the source and the compile would be
    # built from source too (a toolchain, say). Compile only when nothing else is missing.
    plan=$(nix build --dry-run --option substitute false "$gw_drv^out" 2>&1 || true)
    others=$(printf '%s\n' "$plan" | sed -n '/will be built:/,/will be fetched/p' | grep '\.drv$' \
      | grep -v -F -e "$gw_drv" | grep -v -c -e '-source\.drv$' || true)
    if [ "$others" -gt 0 ]; then
      echo "pnpm set is local, but $others other derivation(s) would build without the cache: fetching"
      printf '%s\n' "$plan" | sed -n '/will be built:/,/will be fetched/p' | sed 's/^/  /'
      mode=fetch
    else
      echo "pnpm dependency set is local and only the source and the compile are missing: compiling here"
      mode=compile
    fi
  fi
fi

case "$mode" in
  compile) exec "$here/build-capped.sh" "$log" --max "$max" --cores "$cores" --option substitute false --print-out-paths "$gw_drv^out" ;;
  fetch) exec "$here/build-capped.sh" "$log" --max "$max" --cores "$cores" --print-out-paths "$gw_drv^out" ;;
esac
