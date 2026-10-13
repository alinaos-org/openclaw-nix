# Nix plus the Control UI: a gateway whose config Nix owns, which the Control UI
# can still change. Nix renders the base config; the gateway runs from a writable
# runtime config; before every start the overlay engine (config-overlay.py) keeps
# the Control UI's changes the policy allows (config-overlay.json) and reports the
# rest as drift (config-drift.json), then renders base plus overlay. Nix stays
# authoritative: an overlay entry the source later adopts prunes itself.
#
#   cli            the operator command, openclaw-overlay-<name>:
#                  list | drop <n|all> | promote | check | preview
#   prepareConfig  the ExecStartPre that renders the runtime config
#   sync           a nightly job folding `preview` into the instance's source
#                  config on a machine-owned git branch (never pushes or merges)
{
  lib,
  writeShellApplication,
  runCommand,
  python3,
  coreutils,
  findutils,
  jq,
  diffutils,
  gnutar,
  gzip,
  git,
  util-linux,
}: let
  engine = ./config-overlay.py;
  defaultPolicy = ./config-overlay-policy.json;
  fold = ./fold-overlay.py;

  cli = {
    name,
    stateDir,
    policy ? defaultPolicy,
  }:
    writeShellApplication {
      name = "openclaw-overlay-${name}";
      runtimeInputs = [python3];
      text = ''
        exec python3 ${engine} \
          --state ${lib.escapeShellArg stateDir} \
          --instance ${lib.escapeShellArg name} \
          --policy ${policy} "$@"
      '';
    };

  # Before every start: capture the Control UI's changes (with an overlay
  # policy), migrate state once per new package version (doctor on disposable
  # config and workspace copies; its proposals land in upgrade-*-drift.json),
  # render the Nix config through `transform`, optionally copy plugin load paths
  # out of the store, then apply the overlay and validate, falling back to the
  # pure Nix render if the result is invalid.
  prepareConfig = {
    name,
    # Distinguishes a second unit of the same instance (a strict twin).
    suffix ? "",
    stateDir,
    # The writable config the gateway runs from (its OPENCLAW_CONFIG_PATH).
    runtimeConfig,
    # The config doctor migrates from; the main runtime file, even for a twin.
    migrationSource ? runtimeConfig,
    # The gateway package whose bin/openclaw validates and migrates.
    package,
    # jq filter from the Nix render (<stateDir>/openclaw.json) to the runtime shape.
    transform ? ".",
    # An overlay policy enables the Control UI overlay; null renders Nix only.
    overlayPolicy ? null,
    migrateOnUpgrade ? false,
    # Record the start script in <stateDir>/.started-from (keep-old units).
    recordStartedFrom ? false,
    # Copy plugins.load.paths under this root (outside the store) and point the
    # config at the copies.
    materializePluginsRoot ? null,
  }: let
    overlay = overlayPolicy != null;
    overlayCli = "${cli {
      inherit name stateDir;
      policy = overlayPolicy;
    }}/bin/openclaw-overlay-${name}";
  in
    writeShellApplication {
      name = "openclaw-${name}${suffix}-prepare-config";
      runtimeInputs = [coreutils findutils jq diffutils gnutar gzip];
      text = ''
        raw_config="${stateDir}/openclaw.json"
        runtime_config="${runtimeConfig}"
        # Migrations always read the main runtime file (it exists
        # even when the declarative twin has never started).
        migration_source="${migrationSource}"
        tmp_config="$runtime_config.tmp"
        state_dir="${stateDir}"
        openclaw_bin="${package}/bin/openclaw"
        : "$state_dir" "$openclaw_bin" "$migration_source" # used only by the optional blocks below

        ${lib.optionalString recordStartedFrom ''
          # Record which generation this start uses, for fleet-health.
          printf '%s\n' "$(readlink -f "$0")" > "$state_dir/.started-from"
        ''}

        ${lib.optionalString overlay ''
          # Keep what the Control UI saved since the last start
          # (policy-filtered) before the runtime file is replaced.
          ${overlayCli} capture || \
            echo "WARN ${name}: overlay capture failed; starting from the pure Nix render" >&2
        ''}

        ${lib.optionalString migrateOnUpgrade ''
          # One-shot state migration when the package version changes
          # (9.7 lesson: schema refusals crash-looped every gateway).
          new_version="$("$openclaw_bin" --version 2>/dev/null | head -1 || true)"
          marker="$state_dir/.migrated-for-version"
          old_version="$(cat "$marker" 2>/dev/null || true)"
          if [ -n "$new_version" ] && [ "$new_version" != "$old_version" ] && [ -f "$migration_source" ]; then
            echo "${name}: package changed ($old_version -> $new_version); running state migration" >&2
            failed_marker="$state_dir/.migration-failed-for-version"
            if [ "$(cat "$failed_marker" 2>/dev/null || true)" = "$new_version" ]; then
              echo "refusing ${name}: migration to $new_version already failed once; read the newest $state_dir/backups/pre-migrate-*/doctor.log, fix, then rm $failed_marker" >&2
              exit 1
            fi
            mig_dir="$state_dir/backups/pre-migrate-$(date +%Y%m%dT%H%M%S)"
            install -d -m 0700 "$mig_dir"
            # Version-independent snapshot (the new binary may refuse
            # to open old schemas). The gateway is stopped here.
            (cd "$state_dir" && find . -path ./backups -prune -o -path ./tmp -prune -o \
                \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o -name '*.json' \) -type f -print0 \
              | tar --null -czf "$mig_dir/state-snapshot.tgz" -T -) \
              || { echo "refusing ${name}: pre-migration snapshot failed" >&2; exit 1; }
            scratch_cfg="$mig_dir/doctor-config.json"
            cp "$migration_source" "$scratch_cfg"; chmod 0600 "$scratch_cfg"
            # Workspaces are agent files (Nix-managed for prod/merlin)
            # and agent working files, not state. Doctor gets copies,
            # so a workspace migration (9.7+ merges TOOLS.md into
            # AGENTS.md) comes back as upgrade-workspace-drift.json
            # instead of rewriting them.
            ws_map="$mig_dir/workspace-map.json"
            printf '{}' > "$ws_map"
            ws_n=0
            while IFS= read -r ws; do
              [ -d "$ws" ] || continue
              ws_n=$((ws_n + 1))
              ws_copy="$mig_dir/workspaces/$ws_n"
              install -d -m 0700 "$ws_copy"
              tar -C "$ws" --exclude=./.git --exclude=./node_modules --exclude=./media -cf - . \
                | tar -C "$ws_copy" -xf -
              jq --arg from "$ws" --arg to "$ws_copy" '. + {($from): $to}' "$ws_map" > "$ws_map.tmp"
              mv "$ws_map.tmp" "$ws_map"
            done < <(jq -r '[.. | objects | .workspace? | strings] | unique | .[]' "$scratch_cfg")
            jq --slurpfile m "$ws_map" \
              'walk(if type == "object" and (.workspace | type) == "string" and $m[0][.workspace] != null then .workspace = $m[0][.workspace] else . end)' \
              "$scratch_cfg" > "$scratch_cfg.tmp"
            mv "$scratch_cfg.tmp" "$scratch_cfg"; chmod 0600 "$scratch_cfg"
            # Real state dir, disposable config copy, Nix mode off for
            # this one process only (openclaw#162259 workaround).
            if env -u OPENCLAW_CONFIG_READONLY OPENCLAW_NIX_MODE=0 \
                 OPENCLAW_CONFIG_PATH="$scratch_cfg" OPENCLAW_STATE_DIR="$state_dir" \
                 timeout 900 "$openclaw_bin" doctor --fix --non-interactive >"$mig_dir/doctor.log" 2>&1; then
              # Map the workspace copies back before comparing configs.
              jq --slurpfile m "$ws_map" \
                '($m[0] | to_entries | map({(.value): .key}) | add // {}) as $back
                 | walk(if type == "object" and (.workspace | type) == "string" and $back[.workspace] != null then .workspace = $back[.workspace] else . end)' \
                "$scratch_cfg" > "$mig_dir/doctor-config.after.json"
              ws_drift='[]'
              while IFS=$'\t' read -r ws ws_copy; do
                changes=$(diff -rq --exclude=.git --exclude=node_modules --exclude=media "$ws" "$ws_copy" 2>&1 || true)
                [ -n "$changes" ] || continue
                ws_drift=$(jq --arg ws "$ws" --arg copy "$ws_copy" --arg changes "$changes" \
                  '. + [{workspace: $ws, migratedCopy: $copy, changes: ($changes | split("\n"))}]' <<<"$ws_drift")
              done < <(jq -r 'to_entries[] | "\(.key)\t\(.value)"' "$ws_map")
              if [ "$ws_drift" != '[]' ]; then
                jq -n --argjson w "$ws_drift" --arg from "$old_version" --arg to "$new_version" \
                  '{from:$from, to:$to, note:"doctor wanted these workspace changes; they were applied to the copies only. Adopt them in the agent-file sources or reject them", workspaces:$w}' \
                  | (umask 077; ${python3}/bin/python3 ${engine} redact > "$state_dir/upgrade-workspace-drift.json")
                echo "WARN ${name}: doctor proposed workspace changes; see $state_dir/upgrade-workspace-drift.json" >&2
              fi
              if ! cmp -s "$migration_source" "$mig_dir/doctor-config.after.json"; then
                jq -n --slurpfile a "$migration_source" --slurpfile b "$mig_dir/doctor-config.after.json" \
                  --arg from "$old_version" --arg to "$new_version" \
                  '{from:$from, to:$to, note:"doctor wanted these config changes; adopt them in the Nix source", before:$a[0], after:$b[0]}' \
                  | (umask 077; ${python3}/bin/python3 ${engine} redact > "$state_dir/upgrade-config-drift.json")
                echo "WARN ${name}: doctor proposed config changes; see $state_dir/upgrade-config-drift.json" >&2
              fi
              printf '%s\n' "$new_version" > "$marker"
            else
              printf '%s\n' "$new_version" > "$failed_marker"
              echo "refusing ${name}: doctor --fix failed during upgrade migration; see $mig_dir/doctor.log (snapshot in $mig_dir)" >&2
              exit 1
            fi
          fi
        ''}

        jq ${lib.escapeShellArg transform} \
          "$raw_config" > "$tmp_config"

        ${lib.optionalString (materializePluginsRoot != null) ''
          materialized_plugins_root=${lib.escapeShellArg materializePluginsRoot}
          install -d -m 0700 "$materialized_plugins_root"

          plugin_set_id="$(jq -c '.plugins.load.paths // []' "$tmp_config" | sha256sum | cut -d' ' -f1)"
          materialized_plugin_set="$materialized_plugins_root/$plugin_set_id"

          if [ ! -d "$materialized_plugin_set" ]; then
            plugin_staging="$(mktemp -d "$materialized_plugins_root/.plugin-set-$plugin_set_id.XXXXXX")"
            while IFS= read -r plugin_source; do
              [ -n "$plugin_source" ] || continue
              plugin_basename="$(basename "$plugin_source")"
              plugin_source="$(realpath -e -- "$plugin_source")"
              if [ ! -d "$plugin_source" ]; then
                echo "refusing ${name} OpenClaw: runtime plugin source is not a directory: $plugin_source" >&2
                exit 1
              fi
              plugin_target="$plugin_staging/$plugin_basename"
              if [ -e "$plugin_target" ]; then
                echo "refusing ${name} OpenClaw: runtime plugin basename collision: $plugin_target" >&2
                exit 1
              fi
              cp -a --no-preserve=ownership --reflink=never -- "$plugin_source" "$plugin_target"
            done < <(jq -r '.plugins.load.paths[]?' "$tmp_config")
            mv "$plugin_staging" "$materialized_plugin_set"
          fi

          rewritten_config="$runtime_config.plugins.tmp"
          jq --arg root "$materialized_plugin_set" '
            .plugins.load.paths = ((.plugins.load.paths // []) | map($root + "/" + (split("/")[-1])))
          ' "$tmp_config" > "$rewritten_config"
          mv "$rewritten_config" "$tmp_config"

          expected_uid="$(id -u)"
          while IFS= read -r plugin_path; do
            [ -n "$plugin_path" ] || continue
            resolved_plugin_path="$(realpath -e -- "$plugin_path")"
            case "$resolved_plugin_path" in
              "$materialized_plugin_set"/*) ;;
              *)
                echo "refusing ${name} OpenClaw: materialized runtime plugin escaped its instance directory: $resolved_plugin_path" >&2
                exit 1
                ;;
            esac
            plugin_uid="$(stat -c %u -- "$resolved_plugin_path")"
            if [ "$plugin_uid" != "$expected_uid" ]; then
              echo "refusing ${name} OpenClaw: materialized runtime plugin has uid $plugin_uid, expected $expected_uid: $resolved_plugin_path" >&2
              exit 1
            fi
          done < <(jq -r '.plugins.load.paths[]?' "$tmp_config")
        ''}

        ${
          if overlay
          then ''
            overlay_out="$runtime_config.overlay.tmp"
            ${overlayCli} apply --base "$tmp_config" --out "$overlay_out"
            mv "$overlay_out" "$runtime_config"
            rm -f "$tmp_config"
            if ! OPENCLAW_CONFIG_PATH="$runtime_config" OPENCLAW_STATE_DIR="$state_dir" \
                 "$openclaw_bin" config validate; then
              echo "WARN ${name}: config with Control UI overlay is invalid; starting from the pure Nix render (overlay kept for inspection)" >&2
              cp "$state_dir/.nix-base.json" "$runtime_config"
              OPENCLAW_CONFIG_PATH="$runtime_config" OPENCLAW_STATE_DIR="$state_dir" "$openclaw_bin" config validate
            fi
            # Without Nix mode the gateway may fall back to
            # .last-good on a bad file; never let that be stale.
            cp "$runtime_config" "$runtime_config.last-good"
          ''
          else ''
            mv "$tmp_config" "$runtime_config"

            OPENCLAW_CONFIG_PATH="$runtime_config" \
              OPENCLAW_STATE_DIR="${stateDir}" \
              ${package}/bin/openclaw config validate
          ''
        }
      '';
    };

  sync = {
    name,
    stateDir,
    policy ? defaultPolicy,
    # The checkout the source config lives in, and the worktree the job owns.
    repo,
    worktree,
    branch ? "${name}-ui-sync",
    # The instance's source config, relative to the repository root.
    sourceFile,
    # Source paths that differ from the runtime shape: a list of
    # {from = [...]; to = [...];}, applied where `to` exists in the source.
    renames ? [],
    # Path prefixes kept in the overlay and never folded: state the Control UI
    # owns (its sidebar, for example) rather than configuration.
    exclude ? [],
    baseBranch ? "main",
  }: let
    renamesFile = builtins.toFile "openclaw-${name}-ui-sync-renames.json" (builtins.toJSON renames);
    excludeFile = builtins.toFile "openclaw-${name}-ui-sync-exclude.json" (builtins.toJSON exclude);
  in
    writeShellApplication {
      name = "openclaw-${name}-ui-sync";
      runtimeInputs = [git python3 coreutils util-linux];
      text = ''
        exec 9>"''${XDG_RUNTIME_DIR:-/tmp}/openclaw-ui-sync.lock"
        flock 9
        # Live view, not the last start's capture.
        overlay=$(mktemp)
        trap 'rm -f "$overlay"' EXIT
        python3 ${engine} --state ${lib.escapeShellArg stateDir} --instance ${lib.escapeShellArg name} \
          --policy ${policy} preview > "$overlay"
        repo=${lib.escapeShellArg repo}
        wt=${lib.escapeShellArg worktree}
        if [ ! -s "$overlay" ] || [ "$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1])).get("entries",[])))' "$overlay")" = 0 ]; then
          echo "${name}-ui-sync: overlay empty; nothing to sync"; exit 0
        fi
        if ! git -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
          git -C "$repo" worktree add -q -B ${lib.escapeShellArg branch} "$wt" ${lib.escapeShellArg baseBranch}
        fi
        # Machine-owned branch: rebuilt from the base branch every night.
        git -C "$wt" checkout -q ${lib.escapeShellArg branch}
        git -C "$wt" reset -q --hard ${lib.escapeShellArg baseBranch}
        summary=$(python3 ${fold} "$overlay" "$wt"/${lib.escapeShellArg sourceFile} ${renamesFile} ${excludeFile})
        if git -C "$wt" diff --quiet; then
          echo "${name}-ui-sync: overlay already matches ${baseBranch}"; exit 0
        fi
        git -C "$wt" add ${lib.escapeShellArg sourceFile}
        git -C "$wt" commit -q -m "${name}-ui-sync: fold Control UI overlay into ${name} source ($(date +%F))" -m "$summary" \
          -m "Generated by openclaw-${name}-ui-sync. Review, then merge into ${baseBranch} and activate; the overlay entries prune themselves at the next ${name} start."
        echo "${name}-ui-sync: committed $(git -C "$wt" rev-parse --short HEAD) on ${branch}"
      '';
    };

  # The engine's own tests: capture/apply policy, and that no drift report keeps
  # a credential (redaction is independent of why a change was refused).
  test = runCommand "openclaw-config-overlay-test" {nativeBuildInputs = [python3];} ''
    # The test finds the tool and policy next to itself.
    cp ${engine} config-overlay.py
    cp ${defaultPolicy} config-overlay-policy.json
    cp ${./config-overlay-test.py} config-overlay-test.py
    python3 config-overlay-test.py
    touch "$out"
  '';
in {
  inherit engine defaultPolicy fold cli prepareConfig sync test;
}
