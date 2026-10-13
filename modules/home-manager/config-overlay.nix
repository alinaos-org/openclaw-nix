# Home Manager: a Control UI that can save, on nix-openclaw's instances.
#
# nix-openclaw renders each instance's config to `configPath` and starts the
# gateway in Nix mode, where every config write throws, so the Control UI cannot
# change models, sign-in, heartbeats or anything else. With
# `programs.openclaw.instances.<name>.configOverlay.enable`, the gateway runs from
# a writable runtime config instead, and before every start the overlay engine
# keeps the Control UI's changes the policy allows and renders them over the Nix
# config (packages/config-overlay). Use with nix-openclaw's Home Manager module.
{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  overlay = self.lib.mkConfigOverlay pkgs;
  enabled = lib.filterAttrs (_: inst: inst.enable && inst.configOverlay.enable) config.programs.openclaw.instances;
  synced = lib.filterAttrs (_: inst: inst.configOverlay.sync.enable) enabled;
  prepareFor = name: inst: let
    o = inst.configOverlay;
  in
    overlay.prepareConfig {
      inherit name;
      inherit (inst) stateDir;
      runtimeConfig = o.runtimeConfigPath;
      inherit (o) package transform migrateOnUpgrade;
      overlayPolicy = o.policy;
      materializePluginsRoot =
        if o.materializePlugins
        then "${inst.stateDir}/runtime-plugins"
        else null;
    };
  cliFor = name: inst:
    overlay.cli {
      inherit name;
      inherit (inst) stateDir;
      inherit (inst.configOverlay) policy;
    };
  syncFor = name: inst: let
    s = inst.configOverlay.sync;
  in
    overlay.sync {
      inherit name;
      inherit (inst) stateDir;
      inherit (inst.configOverlay) policy;
      inherit (s) repo worktree branch sourceFile renames baseBranch;
    };
in {
  options.programs.openclaw.instances = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule ({
      name,
      config,
      ...
    }: {
      options.configOverlay = {
        enable = lib.mkEnableOption "a Control UI that can save, over the Nix config";
        policy = lib.mkOption {
          type = lib.types.path;
          default = overlay.defaultPolicy;
          description = ''
            Paths the Control UI may change persistently (`allow`) and must not
            (`deny`; deny wins), in the runtime config's shape. The default keeps
            models, sign-in, heartbeats, thinking levels and similar preferences,
            and refuses gateway, plugins, channels, tools, sandbox, secrets and
            hooks.
          '';
        };
        runtimeConfigPath = lib.mkOption {
          type = lib.types.str;
          default = "${config.stateDir}/openclaw-runtime.json";
          description = "The writable config the gateway runs from.";
        };
        transform = lib.mkOption {
          type = lib.types.str;
          default = ".";
          description = ''
            jq filter from nix-openclaw's render to the config the gateway runs,
            for keys its typed options do not cover yet.
          '';
        };
        migrateOnUpgrade = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = ''
            When the package version changes, snapshot the state and run the new
            doctor against it with disposable config and workspace copies. Its
            proposed changes are written to upgrade-config-drift.json and
            upgrade-workspace-drift.json for the Nix source, not applied; a
            failure stops the start until someone reads the log.
          '';
        };
        materializePlugins = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Copy plugins.load.paths out of the store into the state directory.";
        };
        package = lib.mkOption {
          type = lib.types.package;
          default = config.package;
          defaultText = lib.literalExpression "config.package";
          description = "The package whose bin/openclaw validates and migrates the config.";
        };
        sync = {
          enable = lib.mkEnableOption "a nightly commit of the Control UI's changes to the source config, on a branch for review";
          repo = lib.mkOption {
            type = lib.types.str;
            description = "Checkout of the repository holding the instance's source config.";
          };
          worktree = lib.mkOption {
            type = lib.types.str;
            description = "Worktree the job owns (created on first run).";
          };
          branch = lib.mkOption {
            type = lib.types.str;
            default = "${name}-ui-sync";
            description = "Machine-owned branch, rebuilt from `baseBranch` every night.";
          };
          baseBranch = lib.mkOption {
            type = lib.types.str;
            default = "main";
          };
          sourceFile = lib.mkOption {
            type = lib.types.str;
            description = "The instance's source config, relative to the repository root.";
          };
          renames = lib.mkOption {
            type = lib.types.listOf (lib.types.attrsOf (lib.types.listOf lib.types.str));
            default = [];
            example = [
              {
                from = ["memory" "search"];
                to = ["agents" "defaults" "memorySearch"];
              }
            ];
            description = "Source spellings of runtime paths (the inverse of `transform`'s renames).";
          };
          onCalendar = lib.mkOption {
            type = lib.types.str;
            default = "03:00";
          };
        };
      };
    }));
  };

  config = lib.mkIf (enabled != {}) {
    assertions =
      lib.mapAttrsToList (name: inst: {
        assertion = inst.systemd.enable;
        message = "programs.openclaw.instances.${name}.configOverlay needs the instance's systemd unit";
      })
      enabled;

    home.packages = lib.mapAttrsToList cliFor enabled;

    systemd.user.services =
      lib.mapAttrs' (name: inst:
        lib.nameValuePair inst.systemd.unitName {
          Service = {
            ExecStartPre = "${prepareFor name inst}/bin/openclaw-${name}-prepare-config";
            # Writable: Nix mode makes every config write throw. Keep the update
            # check and telemetry Nix mode disabled off explicitly.
            Environment = lib.mkAfter [
              "OPENCLAW_CONFIG_PATH=${inst.configOverlay.runtimeConfigPath}"
              "OPENCLAW_NIX_MODE=0"
              "OPENCLAW_NO_AUTO_UPDATE=1"
              "DO_NOT_TRACK=1"
            ];
            # A first start on a new release runs doctor (bounded at 900 s).
            TimeoutStartSec = lib.mkIf inst.configOverlay.migrateOnUpgrade "20min";
          };
        })
      enabled
      // lib.mapAttrs' (name: inst:
        lib.nameValuePair "openclaw-${name}-ui-sync" {
          Unit.Description = "Fold ${name}'s Control UI overlay into a ${inst.configOverlay.sync.branch} commit (no push, no merge)";
          Service = {
            Type = "oneshot";
            ExecStart = "${syncFor name inst}/bin/openclaw-${name}-ui-sync";
          };
        })
      synced;

    systemd.user.timers = lib.mapAttrs' (name: inst:
      lib.nameValuePair "openclaw-${name}-ui-sync" {
        Unit.Description = "Nightly ${name} Control UI overlay to git";
        Timer = {
          OnCalendar = inst.configOverlay.sync.onCalendar;
          RandomizedDelaySec = "5m";
          Persistent = true;
        };
        Install.WantedBy = ["timers.target"];
      })
    synced;
  };
}
