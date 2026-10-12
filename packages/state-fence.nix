# A gateway whose `openclaw` entrypoint refuses to touch protected state.
#
# Wrap the final gateway tree (after hotfixes and any plugin graft): `lib` is
# a link to that tree, so nothing may change it afterwards. The fence costs one
# small derivation per host identity instead of a rebuild.
#
# The entrypoint requires explicit OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH
# (OpenClaw would otherwise open and migrate ~/.openclaw before dispatching a
# command), and refuses any state or config path inside `protectedStateDirs`
# unless the host is `hostname` and both paths are under `stateDir`. So a
# candidate or recovery binary run by hand cannot migrate production state.
{
  lib,
  stdenvNoCC,
  bashNonInteractive,
  coreutils,
  gateway,
  # Host allowed to use `stateDir`; null allows none.
  hostname ? null,
  # The state directory this gateway owns on `hostname`.
  stateDir,
  # State directories nothing but this host/state pair may open.
  protectedStateDirs ? [stateDir],
}: let
  node = gateway.passthru.node;
in
  stdenvNoCC.mkDerivation {
    pname = "${gateway.pname or "openclaw-gateway"}-fenced";
    inherit (gateway) version;
    dontUnpack = true;
    phases = ["installPhase"];
    installPhase = ''
      mkdir -p $out/bin
      for entry in ${gateway}/*; do
        [ "$(basename "$entry")" = bin ] || ln -s "$entry" "$out/$(basename "$entry")"
      done
      cat >"$out/bin/openclaw" <<'EOF'
      #!${bashNonInteractive}/bin/bash
      set -euo pipefail

      if [[ -z "''${OPENCLAW_STATE_DIR:-}" || -z "''${OPENCLAW_CONFIG_PATH:-}" ]]; then
        echo "refusing candidate OpenClaw: OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH must both be explicit" >&2
        exit 78
      fi

      state_resolved="$(${coreutils}/bin/realpath -m -- "$OPENCLAW_STATE_DIR")"
      config_resolved="$(${coreutils}/bin/realpath -m -- "$OPENCLAW_CONFIG_PATH")"
      intended_root="$(${coreutils}/bin/realpath -m -- ${lib.escapeShellArg stateDir})"
      intended_hostname=${lib.escapeShellArg (
        if hostname == null
        then ""
        else hostname
      )}
      current_hostname="$(${coreutils}/bin/cat /proc/sys/kernel/hostname)"
      intended_paths=0
      if [[ -n "$intended_hostname" && "$current_hostname" == "$intended_hostname" && "$state_resolved" == "$intended_root" ]]; then
        case "$config_resolved" in
          "$intended_root"|"$intended_root"/*) intended_paths=1 ;;
        esac
      fi

      production_overlap=0
      for production_candidate in ${lib.concatMapStringsSep " " lib.escapeShellArg protectedStateDirs}; do
        production_root="$(${coreutils}/bin/realpath -m -- "$production_candidate")"
        for candidate in "$state_resolved" "$config_resolved"; do
          case "$candidate" in
            "$production_root"|"$production_root"/*) production_overlap=1 ;;
          esac
          case "$production_root" in
            "$candidate"|"$candidate"/*) production_overlap=1 ;;
          esac
        done
      done

      if [[ "$production_overlap" == 1 && "$intended_paths" != 1 ]]; then
        echo "refusing candidate OpenClaw: protected production paths do not match the declared host/state identity" >&2
        exit 78
      fi

      export OPENCLAW_NIX_MODE="''${OPENCLAW_NIX_MODE:-1}"
      export OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY="''${OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY:-1}"
      exec ${node}/bin/node ${gateway}/lib/openclaw/dist/index.js "$@"
      EOF
      chmod 0555 "$out/bin/openclaw"
    '';
    passthru =
      (gateway.passthru or {})
      // {
        stateFence = {
          inherit hostname stateDir protectedStateDirs;
          requiresExplicitPaths = true;
        };
        unfencedGateway = gateway;
      };
    meta = gateway.meta or {};
  }
