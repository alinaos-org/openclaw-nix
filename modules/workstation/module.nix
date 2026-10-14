# Gateways on a workstation: OpenClaw instances as systemd *user* units of one
# desktop user, over nix-openclaw's Home Manager module, with every package from
# openclaw-nix's single-release package set. The server counterpart, one system
# service per instance, is nixosModules.openclaw.
#
# A NixOS module (it sets Home Manager config for `user`, plus linger, the
# firewall and checks). lib.mkWorkstationModule {optionPath} puts the options at
# another path, for a host that already has its own namespace.
{
  self,
  nix-openclaw,
  optionPath,
}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = lib.getAttrFromPath optionPath config;
  stateFenceType = lib.types.submodule {
    options = {
      hostname = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        description = "Host allowed to use `stateDir`; null allows none.";
      };
      stateDir = lib.mkOption {
        type = lib.types.str;
        description = "The production state directory this host owns.";
      };
      protectedStateDirs = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "State directories only the hostname/stateDir pair may open.";
      };
    };
  };
  # One env file (VAR=value lines) shared by all instances (sharedEnvironmentFile),
  # layered onto the generated systemd user units via EnvironmentFile below.
  openclawEnv = cfg.sharedEnvironmentFile;
  hasOpenclawEnv = openclawEnv != null;

  upstreamInstanceNameFor = name: name;
  unitNameFor = name: cfg.instances.${name}.unitName;
  stateDirFor = name: cfg.instances.${name}.stateDir;

  runtimeConfigPathFor = name: cfg.instances.${name}.runtimeConfigPath;
  materializedRuntimePluginsRootFor = name: "${stateDirFor name}/runtime-plugins";

  interactiveInstance = cfg.interactiveInstance;
  interactiveInstanceConfig =
    if interactiveInstance != null && builtins.hasAttr interactiveInstance cfg.instances
    then cfg.instances.${interactiveInstance}
    else null;
  interactiveConfigPath =
    if interactiveInstanceConfig == null
    then null
    else if interactiveInstanceConfig.runtimeConfigJqFilter != null
    then runtimeConfigPathFor interactiveInstance
    else "${stateDirFor interactiveInstance}/openclaw.json";

  # --- bundled-tool freshness --------------------------------------------
  # nix-openclaw resolves toolchain names (nix/tools/extended.nix) against the
  # nix-openclaw-tools flake FIRST and only falls back to nixpkgs. That flake
  # arrives transitively through nix-openclaw, pinned at 4c1cee3c
  # (2026-05-01), where gogcli is 0.15.0 and sonoscli is 0.2.0 — while nixpkgs
  # carries 0.29.0 and 0.3.4.
  #
  # Both copies land on PATH: the home-manager module builds each instance's
  # runtime profile from plain `pkgs` (so it contributes the nixpkgs versions),
  # then the batteries bundle's own wrapper prepends its tools *inside* that,
  # innermost — so the stale copies win every lookup. Measured 2026-07-28:
  # `gog --version` reported v0.15.0 with 0.29.0 sitting five PATH entries
  # further down, i.e. every gog call any agent has made since the NixOS
  # cutover ran 14 minor versions behind.
  #
  # Fix: drop just these two from the bundle. The runtime profile still puts
  # the nixpkgs builds on PATH, so each tool ends up with exactly one copy
  # rather than a shadowed pair. Only names present in BOTH nixpkgs and the
  # tools flake belong here — summarize/camsnap have no nixpkgs equivalent and
  # excluding them would remove them outright.
  # Verify after activation: `gog --version` => 0.29.x, and
  # `echo $PATH | tr : '\n' | grep -c gogcli` => 1.
  staleBundledTools = ["gogcli" "sonoscli"];
  openclawFresh =
    (pkgs.openclawPackages.withTools {excludeToolNames = staleBundledTools;}).openclaw;

  # --- keyed-store trust graft -------------------------------------------
  # OpenClaw 2026.7.1 gates api.runtime.state.openKeyedStore to bundled or
  # trusted-official-install plugins, with no config escape hatch
  # (openclaw#99260, openclaw#92516). nix-openclaw wires runtime plugins via
  # plugins.load.paths, which is neither — so any load-path plugin that
  # touches the keyed store fails to register. Bit us 2026-07-22: the secret
  # migration moved codex OAuth into the keyed store and every codex-runtime
  # model (sol, gpt-*) went dead on the next gateway boot.
  # Fix: stage affected plugins inside the gateway package at
  # dist-runtime/extensions/<id> — the exact mechanism upstream already uses
  # to bundle acpx — so the loader classifies them origin=bundled (trusted).
  # Ids listed here are automatically REMOVED from each instance's
  # runtimePlugins load-path list: a config-origin duplicate outranks the
  # bundled copy and would resurrect the bug.
  # Symptom key: "openKeyedStore is only available for trusted plugins" in
  # gateway logs => add that plugin id to bundledRuntimePlugins.
  graftIds = cfg.bundledRuntimePlugins;
  # The release's lock set and builder (openclaw-nix overlay), not nix-openclaw's own.
  runtimePluginLocks = pkgs.openclawNix.runtimePluginLocks;
  buildGraftPlugin = pkgs.openclawNix.buildRuntimePlugin {openclawPackage = null;};
  graftPluginFor = id:
    if builtins.hasAttr id cfg.bundledRuntimePluginPackages
    then cfg.bundledRuntimePluginPackages.${id}
    else buildGraftPlugin runtimePluginLocks.${id};
  graftGateway = gateway: excludedGraftIds: let
    upstreamBundledRuntimePlugins = gateway.passthru.upstreamBundledRuntimePlugins or [];
    effectiveGraftIds = lib.subtractLists (upstreamBundledRuntimePlugins ++ excludedGraftIds) graftIds;
    hotfixTests = gateway.passthru.hotfixTests or {};
    graft =
      lib.concatMapStrings (id: ''
        # Mirror custom plugins into both trusted built trees: OpenClaw prefers
        # dist-runtime/extensions whenever that directory exists.
        graft_root="$out/lib/openclaw/dist/extensions/${id}"
        runtime_graft_root="$out/lib/openclaw/dist-runtime/extensions/${id}"
        rm -rf "$graft_root"
        mkdir -p "$(dirname "$graft_root")"
        # COPY, do not symlink: the loader realpaths plugin roots before
        # classifying origin, so a symlink to another store path lands
        # outside the gateway package and stays untrusted (verified live
        # 2026-07-22; same symlink-hostility as nix-openclaw#111).
        cp -a ${graftPluginFor id} "$graft_root"
        chmod -R u+w "$graft_root"
        # Keep any plugin OpenClaw ships itself; Fusion has no runtime-tree
        # entry, so add one there.
        if [ ! -e "$runtime_graft_root" ]; then
          mkdir -p "$(dirname "$runtime_graft_root")"
          cp -a ${graftPluginFor id} "$runtime_graft_root"
          chmod -R u+w "$runtime_graft_root"
        fi
        # Mirror the manifest into the manifest-only index dir the install
        # script builds from dist/extensions (it ran before this graft).
        mkdir -p "$out/lib/openclaw/extensions/${id}"
        cp "$graft_root/openclaw.plugin.json" "$out/lib/openclaw/extensions/${id}/openclaw.plugin.json"
      '')
      effectiveGraftIds
      # Cloud workers pack this final grafted tree, not the tree the hotfix
      # layer tested: rerun the hotfix tests on it.
      + lib.concatMapStrings (test: ''
        ${pkgs.nodejs_24}/bin/node ${test} "$out/lib/openclaw"
      '') (lib.attrValues hotfixTests);
  in
    if effectiveGraftIds == []
    then gateway
    # A copy layer (customize, hotfix) is already a copy: graft into it.
    # Anything else (the compiled gateway) gets its own copy rather than a
    # rebuild.
    else if gateway ? passthru.copyLayerOf
    then
      gateway.overrideAttrs (prev: {
        installPhase = prev.installPhase + "\n" + graft;
      })
    else
      pkgs.stdenvNoCC.mkDerivation {
        pname = "${gateway.pname or "openclaw-gateway"}-grafted";
        inherit (gateway) version;
        dontUnpack = true;
        phases = ["installPhase"];
        installPhase =
          ''
            cp -a ${gateway}/. "$out"
            chmod -R u+w "$out"
          ''
          + graft;
        passthru = gateway.passthru or {};
        meta = gateway.meta or {};
      };
  gatewayFor = inst:
    if inst.gatewayPackage == null
    then pkgs.openclaw-gateway
    else inst.gatewayPackage;
  # The tree the instance's gateway process actually runs
  # (runtimeGatewayPackages).
  selectedGatewayFor = inst: let
    # Graft the explicitly selected host packages into every gateway,
    # including reviewed custom candidates; their ids are subtracted from the
    # load-path plugins below, so omitting the graft would drop them.
    grafted = graftGateway (gatewayFor inst) inst.excludedBundledRuntimePlugins;
  in
    # The fence wraps the final tree (its lib/ links to it), so it comes last.
    if inst.stateFence == null
    then grafted
    else pkgs.openclawNix.stateFence ({gateway = grafted;} // inst.stateFence);
  packageFor = name: inst: let
    gateway = gatewayFor inst;
    selectedGateway = selectedGatewayFor inst;
    bundle = openclawFresh.override {
      openclaw-gateway = selectedGateway;
      version = lib.getVersion gateway;
    };
    customBundle = bundle.overrideAttrs (old: {
      # Every instance bundle exposes bin/openclaw. Keep the production CLI
      # authoritative in the shared Home Manager profile; other instances stay
      # reachable through their named wrapper/service.
      meta = (old.meta or {}) // {priority = 10;};
    });
  in
    if inst.gatewayPackage == null
    then bundle
    else customBundle;

  profilePackageFor = name: inst: let
    runtimePackage = packageFor name inst;
  in
    if inst.profileCliName == null
    # Upstream installs the instance packages, not the global package option.
    # Select the interactive CLI here so prod-only hotfixes do not collide
    # with an unpatched sibling's bin/openclaw at the same priority.
    then
      if name == interactiveInstance
      then lib.hiPrio runtimePackage
      else runtimePackage
    else
      pkgs.runCommand "openclaw-${name}-named-cli" {
        passthru = {inherit runtimePackage;};
      } ''
        mkdir -p "$out/bin"
        ln -s ${runtimePackage}/bin/openclaw "$out/bin/${inst.profileCliName}"
      '';

  # The Control UI overlay (alinaos-org/openclaw-nix packages/config-overlay):
  # engine, policy, the per-instance operator command and prepare-config.
  configOverlay = pkgs.openclawNix.configOverlay;
  # One wrapper per instance with the state dir and policy baked in; also
  # installed for the operator as `openclaw-overlay-<name> list|promote|drop|check`.
  overlayToolFor = name: inst:
    configOverlay.cli {
      inherit name;
      stateDir = stateDirFor name;
      policy = inst.uiOverlay.policyFile;
    };

  # `openclaw-<name>-mode writable|declarative|status` — swap between the
  # overlay-enabled unit and its strict-Nix twin (one restart, ~1-3 min).
  modeToolFor = name: _inst:
    pkgs.writeShellApplication {
      name = "openclaw-${name}-mode";
      runtimeInputs = [pkgs.coreutils pkgs.gnugrep pkgs.systemd];
      text = ''
        main=${unitNameFor name}.service
        twin=${unitNameFor name}-declarative.service
        # LESSONS 2026-07-27: a lane inside this gateway must never restart it.
        if grep -q "openclaw-gateway" /proc/self/cgroup 2>/dev/null; then
          echo "refusing: running inside an OpenClaw gateway cgroup; run it from a terminal outside the gateway" >&2
          exit 78
        fi
        state() { systemctl --user is-active "$1" 2>/dev/null || true; }
        case "''${1:-status}" in
          status)
            echo "writable (overlay):    $(state "$main")"
            echo "declarative (strict):  $(state "$twin")"
            ;;
          declarative)
            echo "stopping $main, starting $twin (strict Nix render, overlay ignored)"
            systemctl --user start "$twin"
            systemctl --user is-active --quiet "$twin" && echo "declarative mode active. An activation that restarts $main ends it."
            ;;
          writable)
            echo "stopping $twin, starting $main (Nix render + Control UI overlay)"
            systemctl --user start "$main"
            systemctl --user is-active --quiet "$main" && echo "writable mode active"
            ;;
          *) echo "usage: openclaw-${name}-mode status|declarative|writable" >&2; exit 2 ;;
        esac
      '';
    };

  passwordLauncherFor = name: inst:
    if inst.gatewayPasswordFile != null
    then
      pkgs.writeShellApplication {
        name = "openclaw-gateway-${name}";
        runtimeInputs = [pkgs.coreutils];
        text = ''
          password_file="''${CREDENTIALS_DIRECTORY:?systemd credential directory is required}/gateway-password"
          if [ ! -r "$password_file" ]; then
            echo "refusing ${name} OpenClaw: gateway password credential is unavailable" >&2
            exit 78
          fi
          export OPENCLAW_GATEWAY_PASSWORD
          OPENCLAW_GATEWAY_PASSWORD="$(${pkgs.coreutils}/bin/head -n 1 "$password_file")"
          if [ -z "$OPENCLAW_GATEWAY_PASSWORD" ]; then
            echo "refusing ${name} OpenClaw: gateway password credential is empty" >&2
            exit 78
          fi
          unset password_file OPENCLAW_GATEWAY_TOKEN
          exec ${packageFor name inst}/bin/openclaw gateway --port ${toString inst.gatewayPort}
        '';
      }
    else if !hasOpenclawEnv
    then throw "OpenClaw instance ${name} requires either gatewayPasswordFile or sharedEnvironmentFile"
    else
      pkgs.writeShellApplication {
        name = "openclaw-gateway-${name}";
        runtimeInputs = [pkgs.coreutils pkgs.gnused];
        text = ''
          ${derivedGatewayPasswordFor name}
          exec ${packageFor name inst}/bin/openclaw gateway --port ${toString inst.gatewayPort}
        '';
      };

  # The per-instance gateway password derived from the shared gateway token.
  # Shared by the launcher above and the oc-<name> CLI below so they agree.
  derivedGatewayPasswordFor = name: ''
    base_token="$(${pkgs.gnused}/bin/sed -n 's/^OPENCLAW_GATEWAY_TOKEN=//p' ${lib.escapeShellArg openclawEnv} | ${pkgs.coreutils}/bin/head -n 1)"
    base_token="''${base_token#\"}"
    base_token="''${base_token%\"}"
    if [ -z "$base_token" ]; then
      echo "refusing ${name} OpenClaw: gateway token source is empty" >&2
      exit 78
    fi
    export OPENCLAW_GATEWAY_PASSWORD
    OPENCLAW_GATEWAY_PASSWORD="$(printf '%s\0%s' "$base_token" ${lib.escapeShellArg name} | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d ' ' -f 1)"
    unset base_token OPENCLAW_GATEWAY_TOKEN'';

  # `oc-<name>`: the OpenClaw CLI for a non-default gateway. Interactive shells
  # export the default instance's OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and
  # gateway token, so the bare named CLIs (openclaw-rescue,
  # openclaw-studio-gateway, ...) act on that instance. This runs the
  # gateway's own release against its own state, config and environment, with
  # its password in the environment (never argv) and the default token cleared.
  instanceCliFor = name: inst:
    pkgs.writeShellApplication {
      name = "oc-${name}";
      runtimeInputs = [pkgs.coreutils pkgs.gnused];
      text = ''
        ${lib.concatStrings (lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg value}\n") (removeAttrs inst.environment ["PATH"]))}
        export OPENCLAW_STATE_DIR=${lib.escapeShellArg (stateDirFor name)}
        export OPENCLAW_CONFIG_PATH=${lib.escapeShellArg "${stateDirFor name}/openclaw-runtime.json"}
        export OPENCLAW_NIX_MODE=${
          if inst.uiOverlay.enable
          then "0"
          else "1"
        }
        unset OPENCLAW_GATEWAY_TOKEN
        # Without its config the CLI falls back to the default port (18789),
        # usually another gateway's; refuse instead of misrouting.
        if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
          echo "oc-${name}: $OPENCLAW_CONFIG_PATH does not exist yet; start openclaw-gateway-${name} once to render it" >&2
          exit 1
        fi
        ${
          if inst.gatewayPasswordFile != null
          then ''
            export OPENCLAW_GATEWAY_PASSWORD
            OPENCLAW_GATEWAY_PASSWORD="$(head -n 1 ${lib.escapeShellArg inst.gatewayPasswordFile})"''
          else if inst.deriveGatewayPassword && hasOpenclawEnv
          then derivedGatewayPasswordFor name
          else ""
        }
        exec ${packageFor name inst}/bin/openclaw "$@"
      '';
    };
  # `openclaw-<name>-restore list|restore <snapshot|latest>`: roll the state back
  # to a pre-migration snapshot (configOverlay.restoreState) with the gateway
  # stopped. Run the one from the generation being rolled back to; switching to
  # that generation starts the gateway (README, "Upgrade and rollback").
  restoreToolFor = name: inst: let
    unit = "${unitNameFor name}.service";
    tool = configOverlay.restoreState {
      inherit name;
      stateDir = stateDirFor name;
      package = packageFor name inst;
    };
  in
    pkgs.writeShellApplication {
      name = "openclaw-${name}-restore";
      runtimeInputs = [pkgs.systemd];
      text = ''
        case "''${1:-}" in
          list) exec ${tool}/bin/openclaw-${name}-restore-state list ;;
          restore)
            if systemctl --user is-active --quiet ${unit}; then
              echo "refusing: ${unit} is running; stop it first (systemctl --user stop ${unit})" >&2
              exit 1
            fi
            ${tool}/bin/openclaw-${name}-restore-state "$@"
            echo "Now switch the system to the generation this command came from; that starts ${unit}." >&2
            echo "(If the system already runs it: systemctl --user start ${unit}.)" >&2
            ;;
          *)
            echo "usage: openclaw-${name}-restore list | restore <pre-migrate-...|latest> [--force]" >&2
            exit 64
            ;;
        esac
      '';
    };

  # A scheduled canary: one real agent turn through the instance's own CLI, with
  # the result in <stateDir>/hooks-state/canary.json for a health check to read.
  canaryFor = name: inst:
    pkgs.writeShellApplication {
      name = "openclaw-${name}-canary";
      runtimeInputs = [pkgs.coreutils pkgs.gnugrep pkgs.jq];
      text = ''
        out=${stateDirFor name}/hooks-state/canary.json
        mkdir -p "$(dirname "$out")"
        started=$(date -Is)
        rc=0
        res=$(timeout 300 ${instanceCliFor name inst}/bin/oc-${name} agent --agent ${lib.escapeShellArg inst.canary.agent} \
          --session-key ${lib.escapeShellArg "agent:${inst.canary.agent}:canary"} \
          -m ${lib.escapeShellArg inst.canary.message} --json 2>&1) || rc=$?
        status=$(jq -r '.status // empty' <<<"$res" 2>/dev/null || true)
        reply=$(jq -r '.result.payloads[0].text // empty' <<<"$res" 2>/dev/null || true)
        model=$(jq -r '((.result.meta.agentMeta.provider // "") + "/" + (.result.meta.agentMeta.model // ""))' <<<"$res" 2>/dev/null || true)
        ok=false
        if [ "$rc" -eq 0 ] && [ "$status" = ok ] && grep -qiw ok <<<"$reply"; then ok=true; fi
        jq -n --arg ts "$started" --argjson ok "$ok" --argjson rc "$rc" --arg model "$model" \
          --arg reply "$(head -c 200 <<<"$reply")" \
          '{ts: $ts, ok: $ok, rc: $rc, model: $model, reply: $reply}' > "$out.tmp"
        mv "$out.tmp" "$out"
        [ "$ok" = true ]
      '';
    };
  canaryInstances = lib.filterAttrs (_: inst: inst.canary.enable) cfg.instances;

  # The units' PATH: the user's local bin and Nix profiles, then the system's.
  unitPath = "PATH=${cfg.home}/.local/bin:/run/wrappers/bin:${cfg.home}/.nix-profile/bin:/nix/profile/bin:${cfg.home}/.local/state/nix/profile/bin:/etc/profiles/per-user/${cfg.user}/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin";
in {
  # The workspace files, their heartbeat checklists and the nightly UI sync, at
  # <optionPath>.{agentFiles,heartbeatChecklists,uiSync}.
  imports = map (file: import file {inherit optionPath;}) [
    ./agent-files.nix
    ./heartbeat-checklists.nix
    ./ui-sync.nix
  ];

  options = lib.setAttrByPath optionPath {
    user = lib.mkOption {
      type = lib.types.str;
      description = "The user whose systemd user manager runs the gateways (Home Manager user).";
    };
    home = lib.mkOption {
      type = lib.types.str;
      default = "/home/${cfg.user}";
      defaultText = lib.literalExpression ''"/home/''${user}"'';
      description = "That user's home directory; instances keep their state in <home>/.openclaw-<name>.";
    };
    sharedEnvironmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        An env file (VAR=value lines) layered onto every instance that keeps
        useSharedEnvironmentFile, for example a sops-nix secret. The gateway token
        derivation (deriveGatewayPassword) reads OPENCLAW_GATEWAY_TOKEN from it.
      '';
    };
    extraUnitEnvironment = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = ["GOG_KEYRING_BACKEND=file"];
      description = "KEY=value entries placed first in every gateway unit's environment.";
    };
    instanceDefaults = {
      memoryHigh = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default memoryHigh for instances.";
      };
      memoryMax = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Default memoryMax for instances.";
      };
      stopTimeout = lib.mkOption {
        type = lib.types.str;
        default = "360s";
        description = "Default stopTimeout for instances.";
      };
    };
    skipBootstrap = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Set agents.defaults.skipBootstrap in every instance: the gateway no longer
        seeds missing workspace files. Turn it on only after agentFiles (or
        something else) has delivered every workspace's complete file set and
        openclaw-agent-files-audit passes.
      '';
    };
    skills = {
      baseline = lib.mkOption {
        type = with lib.types; listOf str;
        default = [];
        description = "Skill names every agent can see (agents.defaults.skills).";
      };
      agents = lib.mkOption {
        type = with lib.types; attrsOf (listOf str);
        default = {};
        description = ''
          Extra skills per agent id, merged as baseline ++ extras into that
          agent's skills (agents.entries.<id>.skills, or agents.list[].skills in
          the older roster shape). Ids an instance does not have are ignored.
        '';
      };
    };
    stateFence = lib.mkOption {
      type = lib.types.nullOr stateFenceType;
      default = null;
      description = "Default `instances.<name>.stateFence` for every instance.";
    };
    interactiveInstance = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        Instance targeted by unqualified interactive CLI commands such as
        `openclaw status`. When that instance has a runtime config transform,
        the CLI consumes the same generated runtime config as its gateway.
        Leave null when operators must select an instance explicitly.
      '';
    };
    interactiveConfigPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      description = ''
        Absolute path to the config the interactive instance's gateway actually
        loads — set by the nix-openclaw module, never by a host.

        Read this instead of writing a literal. The path moves with
        the instance's state directory (`~/.openclaw-<name>`) and with
        `runtimeConfigJqFilter` (`openclaw.json` vs `openclaw-runtime.json`),
        so any hardcoded copy is correct on at most one host and silently stale
        everywhere else.
      '';
    };
    interactiveUnit = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      description = ''
        systemd --user unit for the interactive instance's gateway, including
        the `.service` suffix — set by the nix-openclaw module, never by a host.

        Same rule as `interactiveConfigPath`: the unit is the instance's
        `unitName` (`openclaw-gateway-<name>.service`), so a literal targets a
        unit that does not exist when the interactive instance changes. `systemctl restart` on a missing unit fails
        loudly but only in whatever log the caller happens to keep.
      '';
    };
    runtimeGatewayPackages = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      readOnly = true;
      description = ''
        The exact gateway tree each instance runs, after the runtime-plugin
        graft — set by the nix-openclaw module, never by a host.

        Code that is imported into a running gateway (the hook shims in
        modules/openclaw/openclaw-hooks.nix) must import from this tree. A
        module from any other store path, even the same OpenClaw version
        before the graft, loads a second copy of the module graph whose
        runtime context the gateway never initialised; boot-md and
        session-memory failed that way ("reading 'getStore'") from 2026-09-24.
      '';
    };
    instances = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule ({name, ...}: {
        options = {
          # Where the instance lives, for every module that needs its paths
          # (cron, workflow-control, the config guard, heartbeat checklists).
          stateDir = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "${cfg.home}/.openclaw-${name}";
            description = "The instance's state directory.";
          };
          unitName = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "openclaw-gateway-${name}";
            description = "The gateway's systemd user unit, without `.service`.";
          };
          renderedConfigPath = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "${cfg.home}/.openclaw-${name}/openclaw.json";
            description = "The Nix render of the instance's config.";
          };
          runtimeConfigPath = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "${cfg.home}/.openclaw-${name}/openclaw-runtime.json";
            description = "The config the gateway runs from when it has a runtimeConfigJqFilter.";
          };
          configFile = lib.mkOption {
            type = lib.types.path;
            description = ''
              Sanitized OpenClaw config JSON (secrets referenced via
              secretref-env:* / {source = "env"} shapes only). Imported with
              lib.importJSON into programs.openclaw.instances.<name>.config.
            '';
          };
          runtimePlugins = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            example = ["discord" "codex"];
            description = ''
              OpenClaw runtime plugin ids for this instance, built at the
              release (openclaw-nix pins/runtime-plugin-locks/report.json lists
              them, and why any were skipped).
            '';
          };
          deniedSkills = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = ''
              Skill names removed from this instance's default and per-agent
              visibility after the shared skill matrix is merged.
            '';
          };
          configTransform = lib.mkOption {
            type = lib.types.functionTo lib.types.attrs;
            default = lib.id;
            description = ''
              Function applied to the imported profile JSON before the
              skills matrix merge. Lets hosts graft toggled config blocks
              (e.g. a failover channel) onto a profile
              without forking the JSON file.
            '';
          };
          memoryHigh = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = cfg.instanceDefaults.memoryHigh;
            description = "systemd MemoryHigh for the gateway unit (it also sizes Node's heap).";
          };
          memoryMax = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = cfg.instanceDefaults.memoryMax;
            description = "systemd MemoryMax for the gateway unit.";
          };
          stopTimeout = lib.mkOption {
            type = lib.types.str;
            default = cfg.instanceDefaults.stopTimeout;
            description = ''
              TimeoutStopSec. The gateway drains active work before it exits, with a
              hard-exit watchdog at about 327 s, so a shorter limit cuts that drain.
            '';
          };
          gatewayPort = lib.mkOption {
            type = lib.types.int;
            default = 18789;
            description = "Gateway port for this instance.";
          };
          gatewayPackage = lib.mkOption {
            type = lib.types.nullOr lib.types.package;
            default = null;
            description = ''
              Optional gateway package for this instance. The normal
              batteries/tool bundle and trusted-plugin graft are retained,
              allowing an isolated instance to test another OpenClaw build
              without replacing the production package.
            '';
          };
          stateFence = lib.mkOption {
            type = lib.types.nullOr stateFenceType;
            default = cfg.stateFence;
            defaultText = lib.literalExpression "<optionPath>.stateFence";
            description = ''
              Host identity the instance's `openclaw` entrypoint enforces
              (openclaw-nix state-fence.nix), applied to the final gateway
              tree after hotfixes and the trusted-plugin graft. Null leaves the
              entrypoint unfenced.
            '';
          };
          profileCliName = lib.mkOption {
            type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9._+-]+");
            default = null;
            description = ''
              Install only a named CLI shim for this instance instead of its
              unqualified bin/openclaw. Use this when an independently pinned
              package would otherwise collide with the interactive instance.
            '';
          };
          openFirewall = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Open the gateway port in the host firewall.";
          };
          autoStart = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = "Enable this instance in the systemd user default target.";
          };
          deriveGatewayPassword = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Derive this instance's trusted-proxy fallback password at service
              start from the shared gateway token and the instance name.
            '';
          };
          gatewayPasswordFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Optional file containing this instance's trusted-proxy fallback
              password. systemd loads it as a private service credential; the
              gateway receives only the password value, never the source file
              or the host-wide SOPS environment bundle.
            '';
          };
          environment = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = {};
            description = ''
              Non-secret environment variables appended to this gateway's
              systemd user unit. Secret material belongs in the shared SOPS
              EnvironmentFile, never in this option or the Nix store.
            '';
          };
          unsetEnvironment = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = ''
              Environment variable names removed from this gateway after its
              shared SOPS EnvironmentFile is loaded. Use this to enforce
              per-instance credential boundaries without copying secrets into
              the Nix store.
            '';
          };
          useSharedEnvironmentFile = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Attach sharedEnvironmentFile to this instance. Disable this for
              isolated gateways that must not receive the shared credentials.
            '';
          };
          environmentFile = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Optional instance-scoped SOPS EnvironmentFile. Use this for an
              isolated gateway that needs a narrow credential subset without
              inheriting sharedEnvironmentFile.
            '';
          };
          unsetOpenAIApiKey = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Whether to strip OPENAI_API_KEY after EnvironmentFile processing.
              Keep this enabled for normal gateways so OAuth/subscription auth
              cannot silently fall through to metered Platform billing. Disable
              only for an isolated gateway with an explicit instance-scoped API
              fallback key.
            '';
          };
          inaccessiblePaths = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = ''
              Paths hidden from this gateway's systemd mount namespace. Use
              this when removing a variable from the process environment is
              insufficient because child processes can read its source file.
            '';
          };
          readOnlyPaths = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = ''
              Paths mounted read-only inside this gateway's systemd namespace.
              This is intended for diagnostic access to sibling instance state
              without granting state-mutation authority.
            '';
          };
          excludedBundledRuntimePlugins = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = ''
              Host-selected bundled runtime plugin grafts omitted from this
              instance's package. Use when an independently pinned gateway
              does not enable a version-coupled host plugin.
            '';
          };
          runtimeConfigJqFilter = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = null;
            description = ''
              Optional jq filter applied to the rendered config immediately
              before service start. Intended for isolated cross-version
              compatibility testing; the filtered config is validated by the
              selected gateway package before the service may start.
            '';
          };
          materializeRuntimePlugins = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Copy configured load-path plugins into an instance-owned runtime
              directory and point the generated runtime config at those copies.
              Enable this when the gateway's user-service sandbox maps
              root-owned Nix store paths to an untrusted overflow uid.
            '';
          };
          uiOverlay = {
            enable = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Let the Control UI save settings on a Nix-managed gateway.

                The gateway runs WITHOUT OPENCLAW_NIX_MODE, against a writable
                openclaw-runtime.json. Before every start, prepare-config diffs
                the last rendered Nix base against the runtime file and keeps
                the changes whose paths `policyFile` allows in
                <state>/config-overlay.json; everything else (fences, plugins,
                channels, gateway, exec, secrets) is discarded and logged to
                <state>/config-drift.json. The new Nix base is then rendered
                with the surviving overlay on top. Nix stays authoritative:
                an overlay entry that the repo later adopts is pruned
                automatically, and `openclaw-overlay <instance> drop all`
                returns the instance to the pure Nix render.

                Requires runtimeConfigJqFilter (the runtime file must be a
                regular file rendered at start).
              '';
            };
            policyFile = lib.mkOption {
              type = lib.types.path;
              # openclaw-nix's packages/config-overlay/config-overlay-policy.json
              default = pkgs.openclawNix.configOverlay.defaultPolicy;
              defaultText = lib.literalExpression "pkgs.openclawNix.configOverlay.defaultPolicy";
              description = "JSON {allow, deny} path patterns for persisted Control UI edits. Deny wins.";
            };
          };
          declarativeTwin.enable = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Also generate `openclaw-gateway-<name>-declarative`: the same
              gateway (state dir, port, package, secrets, fences) rendered
              from the Nix source alone, in strict Nix mode, with no Control
              UI overlay. It is never started automatically and conflicts
              with the main unit, so exactly one of them runs. Switch with
              `openclaw-<name>-mode declarative|writable|status`. An
              activation that restarts the main unit ends declarative mode;
              to make it permanent set uiOverlay.enable = false instead.
            '';
          };
          keepRunningOnActivation = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Keep the running gateway on its current generation when an
              activation changes its unit (sd-switch X-SwitchMethod=keep-old);
              it adopts the new generation only on an explicit restart or a
              reboot. Meant for the rescue gateway, so a bad build or config
              cannot take it down together with the others. The prepare step
              records the generation it started from in <state>/.started-from
              so fleet-health can report when it lags the installed one.
            '';
          };
          cleanEnvironment = {
            enable = lib.mkEnableOption ''
              a clean environment: the prepare step and the gateway start from only the
              variables the unit declares, `pass` and CREDENTIALS_DIRECTORY, not what
              the user manager hands down (D-Bus, SSH agent, Wayland, ambient keys);
              the overlay engine also runs without credentials. Needs a password
              launcher (gatewayPasswordFile or deriveGatewayPassword)
            '';
            pass = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [];
              description = "Variables from the unit's env files the gateway still receives.";
            };
          };
          credentialFiles = lib.mkOption {
            type = lib.types.attrsOf (lib.types.submodule {
              options = {
                path = lib.mkOption {
                  type = lib.types.str;
                  description = "The file systemd loads (LoadCredential).";
                };
                variable = lib.mkOption {
                  type = lib.types.str;
                  description = "The variable that receives the credential's path.";
                };
              };
            });
            default = {};
            description = "Credentials the gateway reads as files: each one's path is exported in `variable`.";
          };
          serviceConfig = lib.mkOption {
            type = lib.types.attrs;
            default = {};
            example = {
              UMask = "0077";
              NoNewPrivileges = true;
            };
            description = "Extra [Service] settings for the gateway unit, applied last.";
          };
          canary = {
            enable = lib.mkEnableOption ''
              a scheduled canary: one real agent turn through the instance's own CLI
              (oc-<name>), with the result in <stateDir>/hooks-state/canary.json. The
              CLI clears the shared gateway token, so the instance needs a password
              (gatewayPasswordFile or deriveGatewayPassword)
            '';
            agent = lib.mkOption {
              type = lib.types.str;
              description = "The agent the canary turn runs.";
            };
            message = lib.mkOption {
              type = lib.types.str;
              default = "Canary check. Reply with exactly: OK";
              description = "The canary prompt; the reply must contain the word OK.";
            };
            onCalendar = lib.mkOption {
              type = lib.types.str;
              default = "weekly";
              description = "systemd OnCalendar for the canary timer.";
            };
          };
          migrateStateOnUpgrade = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              When the gateway package version differs from the last version
              that started on this state directory, run the new package's
              `doctor --fix --non-interactive` (safe migrations only) against
              the real state directory and a disposable copy of the runtime
              config, after a verified `backup create`. State-schema
              migrations (agent DBs, auth stores, cron store, heartbeat scratch)
              land; config migrations the doctor would have made are written
              to <state>/upgrade-config-drift.json for the repo to adopt,
              instead of being applied. Prevents the 2026-09-30 crash loop
              (9.7 refused schema-23 agent DBs and Nix mode blocked doctor).
            '';
          };
        };
      }));
      default = {};
      description = "OpenClaw gateway instances for this host.";
    };
    bundledRuntimePlugins = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      example = ["acpx" "codex"];
      description = ''
        Runtime plugin ids to stage INSIDE the gateway package
        (dist-runtime/extensions/<id>) so OpenClaw classifies them
        origin=bundled and grants keyed-store access. Use for plugins that
        fail to register with "openKeyedStore is only available for trusted
        plugins". Ids here are stripped from every instance's runtimePlugins
        load-path wiring automatically.
      '';
    };
    bundledRuntimePluginPackages = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      default = {};
      description = ''
        Optional package overrides for ids in bundledRuntimePlugins. This is
        for host-local compatibility patches that must be applied before a
        runtime plugin is copied into the trusted gateway tree.
      '';
    };
    packageSet = {
      sharedBuild = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Use openclaw-nix's own gateway source build, the one its CI pushes to
          the binary cache, so the host downloads it instead of compiling.
          Host changes then go through `customize`.
        '';
      };
      customize = lib.mkOption {
        type = lib.types.attrs;
        default = {};
        description = ''
          Arguments for openclaw-nix's customize layer (replaceBundledChannels,
          extraCommands): host changes applied to a copy of the built tree.
        '';
      };
      gatewayArgs = lib.mkOption {
        type = lib.types.attrs;
        default = {};
        description = ''
          Arguments for openclaw-nix's gateway build (extraSourcePatches,
          extraTests, extraInstallCommands, localRevision); they make the source
          build this host's own. Every OpenClaw package on the host derives from
          that one build.
        '';
      };
      excludeToolNames = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "Tools to drop from the CLI bundle (ones the host installs itself).";
      };
    };
  };

  config = lib.mkMerge [
    # Published so desktop surfaces read the gateway's real config path and unit
    # rather than literals that only track one host's path layout.
    (lib.setAttrByPath optionPath {
      interactiveConfigPath = interactiveConfigPath;
      runtimeGatewayPackages = lib.mapAttrs (_: selectedGatewayFor) cfg.instances;
      interactiveUnit =
        if interactiveInstance == null
        then null
        else "${unitNameFor interactiveInstance}.service";
    })
    {
      assertions =
        lib.optional (interactiveInstance != null) {
          assertion = builtins.hasAttr interactiveInstance cfg.instances;
          message = "${lib.showOption (optionPath ++ ["interactiveInstance"])} must name a declared OpenClaw instance";
        }
        ++ lib.mapAttrsToList (name: inst: {
          assertion = !(inst.deriveGatewayPassword && inst.gatewayPasswordFile != null);
          message = "OpenClaw instance ${name} cannot combine deriveGatewayPassword with gatewayPasswordFile";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion = !inst.canary.enable || inst.deriveGatewayPassword || inst.gatewayPasswordFile != null;
          message = "OpenClaw instance ${name}: canary runs through oc-${name}, which needs gatewayPasswordFile or deriveGatewayPassword";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion = !inst.cleanEnvironment.enable || inst.deriveGatewayPassword || inst.gatewayPasswordFile != null;
          message = "OpenClaw instance ${name}: cleanEnvironment wraps the password launcher, so it needs gatewayPasswordFile or deriveGatewayPassword";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion = lib.all (id: builtins.elem id graftIds) inst.excludedBundledRuntimePlugins;
          message = "OpenClaw instance ${name} may exclude only host-declared bundled runtime plugins";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion =
            inst.profileCliName
            == null
            || inst.deriveGatewayPassword
            || inst.gatewayPasswordFile != null;
          message = "OpenClaw instance ${name} with profileCliName requires an explicit gateway launcher";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion = !inst.declarativeTwin.enable || inst.uiOverlay.enable;
          message = "OpenClaw instance ${name}: declarativeTwin is the strict-Nix fallback for a uiOverlay instance";
        })
        cfg.instances
        ++ lib.mapAttrsToList (name: inst: {
          assertion = !inst.uiOverlay.enable || inst.runtimeConfigJqFilter != null;
          message = "OpenClaw instance ${name}: uiOverlay needs runtimeConfigJqFilter (a regular runtime config rendered at start)";
        })
        cfg.instances;

      # First-party OpenClaw packaging/module support, then openclaw-nix's
      # single-release package set (gateway, CLI, pinned runtime plugins).
      nixpkgs.overlays = [
        nix-openclaw.overlays.default
        (self.lib.mkPackageSetOverlay {inherit (cfg.packageSet) sharedBuild customize gatewayArgs excludeToolNames;})
      ];
      home-manager.sharedModules = [
        nix-openclaw.homeManagerModules.openclaw
        # Every instance's config is typed by the release's own schema.
        {_module.args.openclawConfigOptionsFile = self.lib.configOptionsFile;}
      ];
      # The overlays above must reach Home Manager, and the user's packages
      # /etc/profiles/per-user/<user>/bin, which the units' PATH includes.
      home-manager.useGlobalPkgs = true;
      home-manager.useUserPackages = true;

      # nix-openclaw runs Linux gateways as systemd user services. Linger keeps
      # them running after boot without an interactive login.
      users.users.${cfg.user}.linger = lib.mkIf (cfg.instances != {}) true;

      home-manager.users.${cfg.user} = lib.mkIf (cfg.instances != {}) {
        # `openclaw-overlay-<instance> list|promote|drop <n|all>|check`
        home.packages =
          lib.mapAttrsToList overlayToolFor (lib.filterAttrs (_: inst: inst.uiOverlay.enable) cfg.instances)
          ++ lib.mapAttrsToList instanceCliFor (lib.filterAttrs (name: _: name != interactiveInstance) cfg.instances)
          ++ lib.mapAttrsToList modeToolFor (lib.filterAttrs (_: inst: inst.declarativeTwin.enable) cfg.instances)
          ++ lib.mapAttrsToList restoreToolFor (lib.filterAttrs (_: inst: inst.migrateStateOnUpgrade && inst.runtimeConfigJqFilter != null) cfg.instances);

        # nix-openclaw also installs programs.openclaw.package as the
        # interactive CLI. Bind that global package to this repository's
        # selected interactive instance. profilePackageFor also gives that
        # instance priority in the shared Home Manager package environment.
        programs.openclaw.package = lib.mkIf (interactiveInstanceConfig != null) (
          packageFor interactiveInstance interactiveInstanceConfig
        );

        programs.openclaw.instances = lib.mapAttrs' (name: inst:
          lib.nameValuePair (upstreamInstanceNameFor name) {
            enable = true;
            gatewayPort = inst.gatewayPort;
            # Graft ids load as bundled from inside the (grafted) package —
            # keeping them in the load-path list would shadow the trusted copy.
            runtimePlugins = lib.subtractLists graftIds inst.runtimePlugins;
            # Default package = the batteries bundle minus the stale bundled
            # tools (see staleBundledTools above), swapped for the keyed-store
            # graft build when graftIds is set.
            # The skills visibility matrix (modules/openclaw-skills.nix) is
            # applied on top of the imported profile JSON: baseline becomes
            # agents.defaults.skills, and matrix agents get baseline ++ extras
            # (explicit per-agent lists REPLACE defaults in OpenClaw, so the
            # merge must happen here).
            config = let
              base = inst.configTransform (lib.importJSON inst.configFile);
              sk = cfg.skills;
              visibleBaseline = lib.subtractLists inst.deniedSkills sk.baseline;
              skillsFor = id: lib.unique (lib.subtractLists inst.deniedSkills (visibleBaseline ++ sk.agents.${id}));
              applyAgent = agent:
                if agent ? id && sk.agents ? ${agent.id}
                then agent // {skills = skillsFor agent.id;}
                else agent;
              # Only what the host sets: an explicit empty skills list would hide
              # every skill, and an empty agents.list leaves no agent (not even
              # the implicit main).
              agents' =
                (base.agents or {})
                // {
                  defaults =
                    (base.agents.defaults or {})
                    // lib.optionalAttrs (sk.baseline != [] || inst.deniedSkills != []) {skills = visibleBaseline;}
                    // lib.optionalAttrs cfg.skipBootstrap {
                      skipBootstrap = true;
                    };
                }
                // lib.optionalAttrs (base.agents ? list) {
                  list = map applyAgent base.agents.list;
                }
                # The current schema's roster: entries keyed by agent id.
                // lib.optionalAttrs (base.agents ? entries) {
                  entries =
                    lib.mapAttrs (
                      id: agent:
                        if sk.agents ? ${id}
                        then agent // {skills = skillsFor id;}
                        else agent
                    )
                    base.agents.entries;
                };
            in
              base // {agents = agents';};
            package = profilePackageFor name inst;
          })
        cfg.instances;

        # Upstream's generated user units still lack an [Install] section, so
        # add WantedBy=default.target ourselves; and it does not expose
        # EnvironmentFile directly, so layer the shared env file onto each unit.
        systemd.user.services = let
          # `declarative = true` builds the strict-Nix twin of an instance:
          # same state dir, port, package, secrets and fences, but Nix mode on,
          # no Control UI overlay, its own runtime file, off by default, and
          # mutually exclusive with the main unit (Conflicts=). Switch with
          # `openclaw-<name>-mode declarative|writable|status`.
          mkUnit = declarative: name: _inst0: let
            _inst =
              _inst0
              // lib.optionalAttrs declarative {
                uiOverlay = _inst0.uiOverlay // {enable = false;};
              };
            suffix = lib.optionalString declarative "-declarative";
            runtimeConfigFor =
              if declarative
              then "${stateDirFor name}/openclaw-runtime.declarative.json"
              else runtimeConfigPathFor name;
            instanceEnvironment =
              lib.mapAttrsToList (environmentName: value: "${environmentName}=${value}") _inst.environment
              # Each credential file's path, as systemd mounts it.
              ++ lib.mapAttrsToList (credential: c: "${c.variable}=%d/${credential}") _inst.credentialFiles;
            unitEnvironment =
              if _inst.runtimeConfigJqFilter != null
              then
                cfg.extraUnitEnvironment
                ++ [
                  unitPath
                  "HOME=${cfg.home}"
                  "OPENCLAW_CONFIG_PATH=${runtimeConfigFor}"
                  "OPENCLAW_STATE_DIR=${stateDirFor name}"
                  "OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY=1"
                ]
                # Nix mode makes every config write throw
                # (OPENCLAW_NIX_MODE_CONFIG_IMMUTABLE): Control UI saves,
                # provider sign-in's config step, /config. uiOverlay
                # instances run writable and let prepare-config decide
                # what survives a restart. Nix mode also disabled update
                # checks and telemetry; keep both off explicitly.
                ++ (
                  if _inst.uiOverlay.enable
                  # Explicit 0: the state-fenced wrapper defaults an
                  # unset OPENCLAW_NIX_MODE back to 1.
                  then ["OPENCLAW_NIX_MODE=0" "OPENCLAW_NO_AUTO_UPDATE=1" "DO_NOT_TRACK=1"]
                  else ["OPENCLAW_NIX_MODE=1"]
                )
                ++ instanceEnvironment
              else
                cfg.extraUnitEnvironment
                # The systemd user manager does not inherit the login
                # shell's PATH, so gateway-spawned tools otherwise miss
                # ~/.local/bin and the user's Nix profiles.
                ++ [unitPath]
                ++ instanceEnvironment;
            # cleanEnvironment: the prepare step and the gateway start from exactly
            # the variables the unit declares (plus `pass` from its env files and
            # systemd's CREDENTIALS_DIRECTORY), nothing the user manager hands down.
            keepNames =
              map (entry: builtins.head (lib.splitString "=" entry)) unitEnvironment
              ++ _inst.cleanEnvironment.pass
              ++ ["CREDENTIALS_DIRECTORY"];
            clean = command:
              if !_inst.cleanEnvironment.enable
              then command
              else "${pkgs.writeShellScript "openclaw-${name}${suffix}-clean-env" ''
                kept=()
                for name in ${lib.escapeShellArgs (lib.unique keepNames)}; do
                  if [ -n "''${!name+x}" ]; then kept+=("$name=''${!name}"); fi
                done
                exec ${pkgs.coreutils}/bin/env -i "''${kept[@]}" "$@"
              ''} ${command}";
          in
            lib.nameValuePair "${unitNameFor name}${suffix}" {
              Install.WantedBy = lib.optional (_inst.autoStart && !declarative) "default.target";
              Unit =
                if declarative
                then {
                  Description = "OpenClaw gateway ${name} — declarative (strict Nix) mode, off by default";
                  Conflicts = ["${unitNameFor name}.service"];
                  After = ["network-online.target"];
                }
                else
                  lib.optionalAttrs _inst0.declarativeTwin.enable {
                    Conflicts = ["${unitNameFor name}-declarative.service"];
                  }
                  # Activations leave the running gateway alone (options.nix).
                  // lib.optionalAttrs _inst0.keepRunningOnActivation {
                    "X-SwitchMethod" = "keep-old";
                  };
              # memoryHigh/memoryMax bound the gateway and its children (a leaking
              # model CLI child can take a host down). They also size the V8 heap:
              # with no --max-old-space-size, Node derives the main-isolate ceiling
              # from process.constrainedMemory() = min(MemoryHigh, MemoryMax).
              Service =
                {
                  # The gateway main process handles TERM, but MCP children can
                  # keep the cgroup alive indefinitely. Signal only the main
                  # process first, then bound cleanup of remaining children.
                  # Keep the allowance for long planned restart paths. The
                  # qualified prod 9.4 stop-only hotfix drains for 30s and
                  # bounds cleanup at 90s (+2s watchdog), below user@'s 120s.
                  # Do not shorten this supervisor limit to skip app cleanup.
                  KillMode = "mixed";
                  TimeoutStopSec = _inst.stopTimeout;
                  # gogcli's default keyring backend is `auto`, which prefers
                  # the OS Secret Service whenever D-Bus is reachable — and
                  # under the graphical session it always is. The tokens live
                  # in the encrypted *file* store (~/.config/gogcli/keyring),
                  # so auto resolves to an empty gnome-keyring and every gog
                  # call reports "No tokens stored" (measured 2026-07-28:
                  # `gog auth status` => keyring_backend=auto, source=default,
                  # `gog auth list` => empty; same command with backend=file
                  # lists both accounts). scripts/heartbeat-gog worked only
                  # because it exports the backend itself — patched at the
                  # wrapper instead of the source. Pin it here so every agent
                  # gets the store the tokens are actually in.
                  Environment =
                    if _inst.runtimeConfigJqFilter != null
                    then lib.mkForce unitEnvironment
                    else unitEnvironment;
                  # Talk's OAuth/subscription path is selected only when
                  # OPENAI_API_KEY is absent. Unset it after EnvironmentFile
                  # processing so the canonical SOPS bundle remains available
                  # to separately scoped services such as Robin while the
                  # Gateway cannot silently use metered Platform billing.
                  UnsetEnvironment =
                    (lib.optionals _inst.unsetOpenAIApiKey ["OPENAI_API_KEY"])
                    ++ _inst.unsetEnvironment;
                }
                // lib.optionalAttrs (_inst.memoryHigh != null) {MemoryHigh = _inst.memoryHigh;}
                // lib.optionalAttrs (_inst.memoryMax != null) {MemoryMax = _inst.memoryMax;}
                // lib.optionalAttrs (_inst.inaccessiblePaths != []) {
                  InaccessiblePaths = lib.mkForce (lib.concatStringsSep " " _inst.inaccessiblePaths);
                }
                // lib.optionalAttrs (_inst.readOnlyPaths != []) {
                  ReadOnlyPaths = lib.mkForce (lib.concatStringsSep " " _inst.readOnlyPaths);
                }
                // lib.optionalAttrs ((hasOpenclawEnv && _inst.useSharedEnvironmentFile) || _inst.environmentFile != null) {
                  EnvironmentFile = let
                    environmentFiles =
                      (lib.optional (hasOpenclawEnv && _inst.useSharedEnvironmentFile) openclawEnv)
                      ++ (lib.optional (_inst.environmentFile != null) _inst.environmentFile);
                  in
                    if builtins.length environmentFiles == 1
                    then builtins.head environmentFiles
                    else environmentFiles;
                }
                // lib.optionalAttrs (_inst.gatewayPasswordFile != null || _inst.credentialFiles != {}) {
                  LoadCredential = let
                    credentials =
                      lib.optional (_inst.gatewayPasswordFile != null) "gateway-password:${_inst.gatewayPasswordFile}"
                      ++ lib.mapAttrsToList (credential: c: "${credential}:${c.path}") _inst.credentialFiles;
                  in
                    if builtins.length credentials == 1
                    then builtins.head credentials
                    else credentials;
                }
                // lib.optionalAttrs (_inst.runtimeConfigJqFilter != null) (let
                  runtimeConfig = runtimeConfigFor;
                  prepareConfig = configOverlay.prepareConfig {
                    inherit name suffix;
                    stateDir = stateDirFor name;
                    inherit runtimeConfig;
                    migrationSource = runtimeConfigPathFor name;
                    package = packageFor name _inst;
                    transform = _inst.runtimeConfigJqFilter;
                    overlayPolicy =
                      if _inst.uiOverlay.enable
                      then _inst.uiOverlay.policyFile
                      else null;
                    migrateOnUpgrade = _inst.migrateStateOnUpgrade;
                    recordStartedFrom = _inst.keepRunningOnActivation;
                    materializePluginsRoot =
                      if _inst.materializeRuntimePlugins
                      then materializedRuntimePluginsRootFor name
                      else null;
                    isolateTools = _inst.cleanEnvironment.enable;
                  };
                in {
                  ExecStartPre = clean "${prepareConfig}/bin/openclaw-${name}${suffix}-prepare-config";
                  # A first start on a new release may run doctor migrations
                  # (bounded at 900s inside prepare-config); the user-manager
                  # default of 90s would kill them half-way.
                  TimeoutStartSec = lib.mkIf _inst.migrateStateOnUpgrade "20min";
                })
                // lib.optionalAttrs (_inst.deriveGatewayPassword || _inst.gatewayPasswordFile != null) {
                  ExecStart = lib.mkForce (clean "${passwordLauncherFor name _inst}/bin/openclaw-gateway-${name}");
                }
                # Upstream defines only the main unit; the twin needs its own
                # start command (the same one passwordLauncherFor execs).
                // lib.optionalAttrs (declarative && !(_inst.deriveGatewayPassword || _inst.gatewayPasswordFile != null)) {
                  ExecStart = clean "${packageFor name _inst}/bin/openclaw gateway --port ${toString _inst.gatewayPort}";
                  Restart = "on-failure";
                  RestartSec = "5s";
                  WorkingDirectory = stateDirFor name;
                }
                // _inst.serviceConfig;
            };
        in
          lib.mapAttrs' (mkUnit false) cfg.instances
          // lib.mapAttrs' (mkUnit true) (lib.filterAttrs (_: inst: inst.declarativeTwin.enable) cfg.instances)
          // lib.mapAttrs' (name: inst:
            lib.nameValuePair "openclaw-${name}-canary" {
              Unit.Description = "OpenClaw ${name} canary (one real agent turn)";
              Service = {
                Type = "oneshot";
                ExecStart = "${canaryFor name inst}/bin/openclaw-${name}-canary";
              };
            })
          canaryInstances;
        systemd.user.timers = lib.mapAttrs' (name: inst:
          lib.nameValuePair "openclaw-${name}-canary" {
            Unit.Description = "OpenClaw ${name} canary";
            Timer = {
              OnCalendar = inst.canary.onCalendar;
              RandomizedDelaySec = "15m";
              Persistent = true;
            };
            Install.WantedBy = ["timers.target"];
          })
        canaryInstances;
      };

      # Interactive CLI runs (openclaw status / plugins / logs ...) must consume
      # the same effective config as the selected gateway. In particular, a
      # release adapter or secret materialization makes openclaw-runtime.json
      # load-bearing; reading the raw declarative JSON instead yields false
      # schema and token diagnostics. Multi-instance hosts select deliberately
      # through interactiveInstance. programs.zsh.enable makes /etc/zshenv
      # deliver these to every shell, including ssh commands.
      environment.variables = lib.mkIf (interactiveConfigPath != null) {
        OPENCLAW_CONFIG_PATH = interactiveConfigPath;
        OPENCLAW_STATE_DIR = stateDirFor interactiveInstance;
        OPENCLAW_SYSTEMD_UNIT = "${unitNameFor interactiveInstance}.service";
      };

      networking.firewall.allowedTCPPorts = lib.mapAttrsToList (_: inst: inst.gatewayPort) (lib.filterAttrs (_: inst: inst.openFirewall) cfg.instances);

      system.checks = [
        # The overlay engine's own tests (capture/apply policy, drift redaction).
        configOverlay.test
      ];
    }
  ];
}
