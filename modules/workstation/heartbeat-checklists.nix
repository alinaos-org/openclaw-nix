# Heartbeat checklists, Nix-managed.
#
# Until a 9.x release OpenClaw read an agent's heartbeat checklist from
# <workspace>/HEARTBEAT.md. It now reads the scratch of the agent's heartbeat
# cron job (doctor copied each file in once), so a HEARTBEAT.md that agentFiles
# delivers steers nothing on its own, and editing one changes nothing. This
# module puts the files back in charge: the checklist of a heartbeat is the Nix
# HEARTBEAT.md of its agent's workspace, the file OpenClaw used to read. After
# every start of a gateway, openclaw-<instance>-heartbeat-checklists writes it
# into the scratch of each heartbeat that ticks there; `tool`'s check mode
# reports drift in between.
#
# What the scratch does since 2026.10.1 (src/infra/heartbeat-runner-prompt.ts):
# - A scheduled tick appends it to the prompt. Comments, headers and blank
#   lines only: the tick is skipped before any model call
#   (empty-heartbeat-file). No scratch at all: the generic heartbeat prompt
#   runs, a model turn every tick.
# - A wake (system, cron or exec event) never shows it, but the agent may
#   replace it through heartbeat_respond. On a disabled heartbeat it is only
#   the agent's notes, so it is left alone. On a ticking one a rewrite changes
#   what every tick runs and bills, so the next sync puts the Nix file back and
#   keeps the replaced text under
#   ~/.local/share/openclaw/retired-heartbeat-scratch/<date>/.
{optionPath}: {
  config,
  lib,
  pkgs,
  ...
}: let
  workstation = lib.getAttrFromPath optionPath config;
  cfg = workstation.heartbeatChecklists;
  inherit (workstation) instances user home;
  interactive = workstation.interactiveInstance;
  env = workstation.sharedEnvironmentFile;
  stateDirFor = name: instances.${name}.stateDir;
  gatewayUnitFor = name: instances.${name}.unitName;
  retiredRoot = "${home}/.local/share/openclaw/retired-heartbeat-scratch";

  # {workspace dir: {source, content}}, read at build time. A checklist goes to
  # the gateway as an argument, so it is held well under the 128 KiB argument
  # limit (and the 256 KiB scratch limit).
  checklistsJson = pkgs.runCommand "openclaw-heartbeat-checklists.json" {nativeBuildInputs = [pkgs.jq];} ''
    echo '{}' > "$out"
    ${lib.concatStrings (lib.mapAttrsToList (workspace: source: ''
        if [ "$(stat -c %s ${lib.escapeShellArg "${source}"})" -gt 65536 ]; then
          echo "heartbeat checklist for ${workspace} is over 64 KiB" >&2
          exit 1
        fi
        jq --arg w ${lib.escapeShellArg workspace} --arg s ${lib.escapeShellArg "${source}"} \
          --rawfile c ${lib.escapeShellArg "${source}"} '.[$w] = {source: $s, content: $c}' "$out" > "$out.tmp"
        mv "$out.tmp" "$out"
      '')
      cfg.workspaces)}
  '';
  decide = ./heartbeat-checklists/decide.jq;
  tests = pkgs.runCommand "openclaw-heartbeat-checklists-tests" {nativeBuildInputs = [pkgs.jq];} ''
    bash ${./heartbeat-checklists/test.sh} ${./heartbeat-checklists}
    touch "$out"
  '';

  # The CLI against one instance. The interactive instance has no oc-<name>
  # wrapper: its gateway token resolves from the environment or the shared env
  # file, never from argv.
  packageFor = name: config.home-manager.users.${user}.programs.openclaw.instances.${name}.package;
  tokenFromEnvFile = lib.optionalString (env != null) "$(sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p' ${env} 2>/dev/null | tr -d '\"' | head -1 || true)";
  cliCase = name:
    if name == interactive
    then ''
      ${name})
        token=''${OPENCLAW_GATEWAY_TOKEN:-${tokenFromEnvFile}}
        unset OPENCLAW_GATEWAY_TOKEN
        cli() {
          OPENCLAW_GATEWAY_TOKEN="$token" OPENCLAW_NIX_MODE=1 OPENCLAW_STATE_DIR=${stateDirFor name} \
            OPENCLAW_CONFIG_PATH=${workstation.interactiveConfigPath} \
            timeout 60 ${packageFor name}/bin/openclaw "$@"
        }
        ;;
    ''
    else ''
      ${name}) cli() { timeout 60 /etc/profiles/per-user/${user}/bin/oc-${name} "$@"; } ;;
    '';

  tool = pkgs.writeShellApplication {
    name = "openclaw-heartbeat-checklists";
    runtimeInputs = with pkgs; [coreutils gnugrep gnused jq];
    text = ''
      umask 077
      mode=''${1:-} inst=''${2:-}
      case "$mode" in
        sync | check) ;;
        *)
          echo "usage: openclaw-heartbeat-checklists sync|check <instance>" >&2
          exit 2
          ;;
      esac
      case "$inst" in
        ${lib.concatStrings (map cliCase (lib.attrNames instances))}
        *)
          echo "openclaw-heartbeat-checklists: unknown instance '$inst'" >&2
          exit 2
          ;;
      esac

      # rpc <method> [params]: one gateway call; its stderr only on failure.
      rpc() {
        local params=''${2:-} err out
        [ -n "$params" ] || params='{}'
        err=$(mktemp)
        if out=$(cli gateway call "$1" --json --timeout 30000 --params "$params" 2>"$err"); then
          rm -f "$err"
          printf '%s\n' "$out"
        else
          echo "$inst: $1 failed: $(grep -v -e DeprecationWarning -e trace-deprecation "$err" | tail -n 3 || true)" >&2
          rm -f "$err"
          return 1
        fi
      }

      if [ "$mode" = sync ]; then
        # Started with the gateway: wait until it answers.
        ready=
        for _ in $(seq 1 60); do
          if cli gateway call health --json --timeout 5000 >/dev/null 2>&1; then
            ready=1
            break
          fi
          sleep 5
        done
        if [ -z "$ready" ]; then
          echo "$inst: the gateway did not answer within 6 minutes" >&2
          exit 1
        fi
      fi

      cron=$(rpc cron.status)
      # Only the heartbeat jobs, so prod's long job list never becomes an argument.
      jobs='[]'
      offset=0
      while :; do
        page=$(rpc cron.list "$(jq -cn --argjson o "$offset" '{includeDisabled: true, limit: 200, offset: $o}')")
        more=$(jq -c '[(.jobs // [])[] | select(.payload.kind == "heartbeat") | {id, agentId, enabled, schedule, payload: {kind: .payload.kind}}]' <<<"$page")
        jobs=$(jq -c --argjson more "$more" '. + $more' <<<"$jobs")
        [ "$(jq -r '.hasMore // false' <<<"$page")" = true ] || break
        offset=$(jq -r '.nextOffset' <<<"$page")
      done
      agents=null
      scratch='{}'
      decide() {
        printf '{"cron":%s,"jobs":%s,"agents":%s,"scratch":%s,"checklists":%s}' \
          "$cron" "$jobs" "$agents" "$scratch" "$(cat ${checklistsJson})" \
          | jq -c --arg phase "$1" --arg inst "$inst" -f ${decide}
      }

      mapfile -t ticking < <(decide ticking | jq -r '.[]')
      if [ "''${#ticking[@]}" -eq 0 ]; then
        [ "$mode" = check ] || echo "$inst: no heartbeat ticks (scheduler $(jq -r 'if .enabled == true then "on" else "off" end' <<<"$cron"))"
        exit 0
      fi
      agents=$(rpc agents.list)
      replies=()
      for id in "''${ticking[@]}"; do
        reply=$(rpc cron.scratch.get "$(jq -cn --arg id "$id" '{id: $id}')") || reply=null
        replies+=("$(jq -c --arg id "$id" '{($id): .}' <<<"$reply")")
      done
      scratch=$(printf '%s\n' "''${replies[@]}" | jq -cs 'add // {}')
      verdicts=$(decide verdict)

      if [ "$mode" = check ]; then
        jq -r '.[] | .finding // empty' <<<"$verdicts"
        exit 0
      fi

      failed=0
      while IFS= read -r v; do
        agent=$(jq -r .agentId <<<"$v")
        rev=$(jq -r .revision <<<"$v")
        case "$(jq -r .status <<<"$v")" in
          match) echo "$inst/$agent: matches its Nix checklist (scratch rev $rev)" ;;
          undeclared) echo "$inst/$agent: no Nix checklist for $(jq -r .workspace <<<"$v"); its scratch is left as is" ;;
          generic) jq -r .finding <<<"$v" >&2 ;;
          duplicate | unread)
            jq -r .finding <<<"$v" >&2
            failed=1
            ;;
          drift | missing)
            if [ "$(jq -r '.current != null' <<<"$v")" = true ]; then
              dir=${retiredRoot}/$(date +%F)
              mkdir -p "$dir"
              kept="$dir/$inst-$agent-rev$rev.md"
              [ ! -e "$kept" ] || kept="$kept.$(date +%s)"
              jq -j .current <<<"$v" > "$kept"
              echo "$inst/$agent: kept the scratch it replaces (rev $rev) at $kept"
            fi
            if ! res=$(rpc cron.scratch.set "$(jq -c '{id, content: .want, expectedRevision: .revision}' <<<"$v")"); then
              failed=1
            elif [ "$(jq -r .ok <<<"$res")" = true ]; then
              echo "$inst/$agent: wrote its Nix checklist $(jq -r .source <<<"$v") (scratch rev $rev -> $(jq -r .currentRevision <<<"$res"))"
            else
              echo "$inst/$agent: the scratch changed while syncing (rev $rev -> $(jq -r .currentRevision <<<"$res")); left for the next start" >&2
              failed=1
            fi
            ;;
        esac
      done < <(jq -c '.[]' <<<"$verdicts")
      exit "$failed"
    '';
  };
in {
  options = lib.setAttrByPath (optionPath ++ ["heartbeatChecklists"]) {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Keep the scratch of every ticking heartbeat equal to its Nix checklist:
        a user unit per gateway writes it after each start. On a host whose
        gateways share state with another host, enable it on only one.
      '';
    };

    workspaces = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = {};
      description = ''
        Heartbeat checklist per agent workspace: absolute directory to file. A
        heartbeat's checklist is the one declared for its agent's workspace, as
        the gateway's agents.list resolves it. Includes every agentFiles
        workspace that declares a HEARTBEAT.md.
      '';
    };

    tool = lib.mkOption {
      type = lib.types.package;
      internal = true;
      readOnly = true;
      description = "openclaw-heartbeat-checklists sync|check <instance>: check prints one line per heartbeat whose scratch is not its checklist, for a host's health report.";
    };
  };

  config = lib.mkMerge [
    (lib.setAttrByPath (optionPath ++ ["heartbeatChecklists"]) {
      inherit tool;
      workspaces = lib.mkIf workstation.agentFiles.enable (lib.listToAttrs (lib.concatMap (
        entry: lib.optional (entry.files ? "HEARTBEAT.md") (lib.nameValuePair entry.workspace entry.files."HEARTBEAT.md")
      ) (lib.attrValues workstation.agentFiles.workspaces)));
    })
    (lib.mkIf cfg.enable {
      system.checks = [tests];
      # A home-manager unit, so an activation that changes a checklist restarts
      # it. Type=simple: activation does not wait for the gateway to answer.
      #
      # One unit per gateway unit: the overlay gateway and its declarative
      # twin Conflict, so a unit PartOf both gets a stop (from the twin being
      # stopped) and a restart (from the gateway) in the same transaction, and
      # systemd refuses the whole restart. Each runs the same sync; the
      # inactive twin's unit stays stopped.
      home-manager.users.${user}.systemd.user.services = lib.concatMapAttrs (name: inst: let
        unit = suffix: gateway:
          lib.nameValuePair "openclaw-${name}${suffix}-heartbeat-checklists" {
            Unit = {
              Description = "Write the Nix heartbeat checklists into OpenClaw gateway ${name}'s heartbeat scratch${lib.optionalString (suffix != "") " (declarative twin)"}";
              After = [gateway];
              PartOf = [gateway];
            };
            Service = {
              Type = "simple";
              RemainAfterExit = true;
              ExecStart = "${tool}/bin/openclaw-heartbeat-checklists sync ${name}";
            };
            Install.WantedBy = [gateway];
          };
      in
        lib.listToAttrs (
          [(unit "" "${gatewayUnitFor name}.service")]
          ++ lib.optional inst.declarativeTwin.enable (unit "-declarative" "${gatewayUnitFor name}-declarative.service")
        ))
      instances;
    })
  ];
}
