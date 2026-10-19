# NixOS: OpenClaw gateways as system services, for servers.
#
# `services.openclaw.instances.<name>` runs one gateway as `openclaw-<name>.service`
# under its own system user, with state in /var/lib/openclaw/<name> (StateDirectory)
# and OpenClaw's file logs in /var/log/openclaw/<name> (console output goes to the
# journal). The config is `settings`, rendered by Nix; before every start the
# prepare step (packages/config-overlay) validates it, falls back to the pure render
# when a merged config is invalid, runs doctor on copies after a package change, and,
# with `configOverlay.enable`, keeps the Control UI changes its policy allows.
#
# Secrets never enter the store or the unit: `credentials` are loaded with systemd's
# LoadCredential and exported only inside the service's own start wrapper, so a
# `settings` value can reference one as "$NAME". `hardening` (on by default) confines
# the service; turn it off, or override single settings with `serviceConfig`, only for
# a plugin that needs more.
{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.openclaw;
  system = pkgs.stdenv.hostPlatform.system;
  overlayTools = self.lib.mkConfigOverlay pkgs;
  json = pkgs.formats.json {};
  enabled = lib.filterAttrs (_: inst: inst.enable) cfg.instances;

  # Native Control UI plugins switched on per instance: each adds its load path,
  # allows and enables it, and turns on native plugin UI (Labs > Custom plugin UI).
  settingsFor = inst: let
    s = inst.settings;
    plugins = s.plugins or {};
  in
    if !inst.sessionIcons.enable
    then s
    else
      lib.recursiveUpdate s {
        plugins = {
          load.paths = (plugins.load.paths or []) ++ ["${inst.sessionIcons.package}"];
          allow = lib.unique ((plugins.allow or []) ++ ["session-icons"]);
          entries."session-icons".enabled = true;
        };
        gateway.controlUi.experimental.customPlugins = true;
      };

  unitFor = name: inst: let
    stateDir = "/var/lib/openclaw/${name}";
    logsDir = "/var/log/openclaw/${name}";
    render = "${stateDir}/openclaw.json";
    runtime = "${stateDir}/openclaw-runtime.json";
    configSource =
      if inst.configFile != null
      then inst.configFile
      else json.generate "openclaw-${name}.json" (settingsFor inst);
    # Export each credential under its own name, then run the command.
    withCredentials = label: command:
      pkgs.writeShellScript "openclaw-${name}-${label}" ''
        set -euo pipefail
        ${lib.concatMapStrings (n: ''
          ${n}="$(< "$CREDENTIALS_DIRECTORY/${n}")"
          export ${n}
        '') (lib.attrNames inst.credentials)}
        exec ${command}
      '';
    prepare = overlayTools.prepareConfig {
      inherit name stateDir;
      runtimeConfig = runtime;
      inherit (inst) package transform;
      overlayPolicy =
        if inst.configOverlay.enable
        then inst.configOverlay.policy
        else null;
      migrateOnUpgrade = inst.migrateOnUpgrade;
      materializePluginsRoot =
        if inst.materializePlugins
        then "${stateDir}/runtime-plugins"
        else null;
    };
    hardening = {
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      # OpenClaw writes its file logs under /tmp/openclaw (a fixed "secure temp root").
      # Inside the private /tmp that is the logs directory, so they survive the unit.
      BindPaths = ["${logsDir}:/tmp/openclaw"];
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectControlGroups = true;
      ProtectClock = true;
      ProtectHostname = true;
      ProtectProc = "invisible";
      RestrictNamespaces = true;
      RestrictRealtime = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      RemoveIPC = true;
      # V8 compiles code at run time, which MemoryDenyWriteExecute would forbid.
      MemoryDenyWriteExecute = false;
      CapabilityBoundingSet = "";
      AmbientCapabilities = "";
      RestrictAddressFamilies = ["AF_UNIX" "AF_INET" "AF_INET6" "AF_NETLINK"];
      SystemCallArchitectures = "native";
      # 2026.10.5's page-cache warm worker reads residency with mincore, which no
      # syscall group carries.
      SystemCallFilter = ["@system-service" "mincore" "~@privileged"];
      UMask = "0077";
    };
  in {
    description = "OpenClaw gateway ${name}";
    wantedBy = ["multi-user.target"];
    wants = ["network-online.target"];
    after = ["network-online.target"];
    environment =
      {
        HOME = stateDir;
        OPENCLAW_STATE_DIR = stateDir;
        OPENCLAW_CONFIG_PATH = runtime;
        # Nix mode makes every config write throw; the overlay needs a writable config.
        OPENCLAW_NIX_MODE =
          if inst.configOverlay.enable
          then "0"
          else "1";
        OPENCLAW_NO_AUTO_UPDATE = "1";
        OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY = "1";
        DO_NOT_TRACK = "1";
      }
      // inst.environment;
    serviceConfig = lib.mkMerge [
      {
        Type = "simple";
        User = inst.user;
        Group = inst.group;
        StateDirectory = "openclaw/${name}";
        StateDirectoryMode = "0700";
        LogsDirectory = "openclaw/${name}";
        LogsDirectoryMode = "0700";
        WorkingDirectory = stateDir;
        EnvironmentFile = inst.environmentFiles;
        LoadCredential = lib.mapAttrsToList (n: path: "${n}:${path}") inst.credentials;
        ExecStartPre = [
          "${pkgs.coreutils}/bin/install -m 0600 ${configSource} ${render}"
          (withCredentials "prepare" "${prepare}/bin/openclaw-${name}-prepare-config")
        ];
        ExecStart = withCredentials "start" "${inst.package}/bin/openclaw gateway --port ${toString inst.port}";
        Restart = "always";
        RestartSec = "2s";
        # A gateway drains active work before shutdown hooks run, with a hard-exit
        # watchdog at about 327 s; stop only after it, and the children with it.
        KillMode = "mixed";
        TimeoutStopSec = "360s";
        # The first start on a new package snapshots the state and runs doctor on it.
        TimeoutStartSec =
          if inst.migrateOnUpgrade
          then "20min"
          else "5min";
      }
      (lib.mkIf inst.hardening hardening)
      inst.serviceConfig
    ];
  };

  # The operator's rollback for the state: openclaw-<name>-restore (README, "Upgrade
  # and rollback"). Run the one from the generation being rolled back to, with the
  # gateway stopped; it restores as the instance's user and starts nothing, since
  # switching to that generation starts the gateway.
  restoreFor = name: inst: let
    unit = "openclaw-${name}.service";
    tool = overlayTools.restoreState {
      inherit name;
      stateDir = "/var/lib/openclaw/${name}";
      inherit (inst) package;
    };
  in
    pkgs.writeShellApplication {
      name = "openclaw-${name}-restore";
      runtimeInputs = [pkgs.systemd pkgs.util-linux pkgs.coreutils];
      text = ''
        usage() {
          echo "usage: openclaw-${name}-restore list | restore <pre-migrate-...|latest> [--force]" >&2
          exit 64
        }
        [ "$(id -u)" = 0 ] || { echo "openclaw-${name}-restore: run as root" >&2; exit 1; }
        as_instance() { setpriv --reuid=${inst.user} --regid=${inst.group} --init-groups -- "$@"; }
        case "''${1:-}" in
          list) as_instance ${tool}/bin/openclaw-${name}-restore-state list ;;
          restore)
            if systemctl is-active --quiet ${unit}; then
              echo "refusing: ${unit} is running; stop it first (systemctl stop ${unit})" >&2
              exit 1
            fi
            as_instance ${tool}/bin/openclaw-${name}-restore-state "$@"
            echo "Now switch the system to the generation this command came from; that starts ${unit}." >&2
            echo "(If the system already runs it: systemctl start ${unit}.)" >&2
            ;;
          *) usage ;;
        esac
      '';
    };

  logRules = name: inst:
    lib.optional (inst.logRetention != null) "e /var/log/openclaw/${name} - - - ${inst.logRetention}";
in {
  options.services.openclaw = {
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${system}.gateway-hotfixed;
      defaultText = lib.literalExpression "openclaw-nix.packages.\${system}.gateway-hotfixed";
      description = "The gateway package instances run unless they set their own.";
    };

    instances = lib.mkOption {
      default = {};
      description = "OpenClaw gateways, one system service each.";
      type = lib.types.attrsOf (lib.types.submodule ({
        name,
        config,
        ...
      }: {
        options = {
          enable = lib.mkEnableOption "this OpenClaw gateway" // {default = true;};

          package = lib.mkOption {
            type = lib.types.package;
            default = cfg.package;
            defaultText = lib.literalExpression "config.services.openclaw.package";
            description = "The gateway package; its `bin/openclaw` runs the gateway.";
          };

          port = lib.mkOption {
            type = lib.types.port;
            description = "The gateway's port (`openclaw gateway --port`).";
          };

          openFirewall = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = ''
              Open `port` in the firewall. Leave it closed when a reverse proxy on the
              same host terminates TLS and authenticates users in front of the gateway.
            '';
          };

          settings = lib.mkOption {
            inherit (json) type;
            default = {};
            description = ''
              The gateway's config (openclaw.json), rendered to the Nix store: never put a
              secret here. Reference a credential or environment variable as "$NAME".
            '';
          };

          configFile = lib.mkOption {
            type = lib.types.nullOr lib.types.path;
            default = null;
            description = "A config file to use instead of `settings`.";
          };

          transform = lib.mkOption {
            type = lib.types.str;
            default = ".";
            description = "jq filter applied to the config before the gateway reads it.";
          };

          user = lib.mkOption {
            type = lib.types.str;
            default = "openclaw-${name}";
            description = "The system user the gateway runs as (created unless it exists).";
          };

          group = lib.mkOption {
            type = lib.types.str;
            default = "openclaw-${name}";
            description = "The gateway's group (created unless it exists).";
          };

          environment = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = {};
            description = "Extra environment variables. Not for secrets: they are in the unit file.";
          };

          environmentFiles = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = "EnvironmentFile= paths, read by systemd before it drops privileges.";
          };

          credentials = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = {};
            example = {OPENCLAW_GATEWAY_TOKEN = "/run/secrets/openclaw-gateway-token";};
            description = ''
              Secrets by environment variable name, each a file path loaded with systemd's
              LoadCredential and exported only inside the service's start and prepare
              wrappers. The files can be root-only; the service never sees the paths.
            '';
          };

          sessionIcons = {
            enable = lib.mkEnableOption ''
              the session menu's Custom icons library (deprecated: the built-in session icon
              picker has these 72 icons under Icons since 2026.10.3-r3; this option and the
              session-icons plugin are removed after the 2026.11 releases)
            '';
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${system}.session-icons;
              defaultText = lib.literalExpression "openclaw-nix.packages.\${system}.session-icons";
              description = "The plugin package.";
            };
          };

          configOverlay = {
            enable = lib.mkEnableOption "a Control UI that can save, over the Nix config";
            policy = lib.mkOption {
              type = lib.types.path;
              default = overlayTools.defaultPolicy;
              defaultText = lib.literalExpression "openclaw-nix's default overlay policy";
              description = "Paths the Control UI may change persistently (`allow`) and must not (`deny`).";
            };
          };

          migrateOnUpgrade = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              On the first start of a new package version, snapshot the state
              (backups/pre-migrate-<time>; `openclaw-<name>-restore` puts it back) and run
              the new doctor on it, with copies of the config and workspaces: their
              proposed changes are written for review, not applied.
            '';
          };

          materializePlugins = lib.mkOption {
            type = lib.types.bool;
            default = config.sessionIcons.enable;
            defaultText = lib.literalExpression "config.sessionIcons.enable";
            description = ''
              Copy plugins.load.paths out of the store into the state directory. The
              gateway refuses a plugin whose files are hardlinks, and store optimisation
              hardlinks store files, so turn this on for any plugin loaded from the store.
            '';
          };

          hardening = lib.mkOption {
            type = lib.types.bool;
            default = true;
            description = ''
              Confine the service (read-only system, no home directories, private /tmp and
              devices, no capabilities, a system-call filter). Override single settings
              with `serviceConfig` instead of turning all of it off.
            '';
          };

          serviceConfig = lib.mkOption {
            type = lib.types.attrsOf lib.types.anything;
            default = {};
            description = "Extra systemd [Service] settings, merged last.";
          };

          logRetention = lib.mkOption {
            type = lib.types.nullOr lib.types.str;
            default = "30d";
            description = "Age after which systemd-tmpfiles removes file logs; null keeps them.";
          };
        };
      }));
    };
  };

  config = lib.mkIf (enabled != {}) {
    assertions =
      lib.mapAttrsToList (name: inst: {
        assertion = lib.all (n: builtins.match "[A-Za-z_][A-Za-z0-9_]*" n != null) (lib.attrNames inst.credentials);
        message = "services.openclaw.instances.${name}.credentials: names must be environment variable names";
      })
      enabled
      ++ lib.mapAttrsToList (name: inst: {
        assertion = !(inst.sessionIcons.enable && inst.configFile != null);
        message = "services.openclaw.instances.${name}.sessionIcons needs `settings`, not `configFile`";
      })
      enabled
      ++ [
        {
          assertion = lib.length (lib.unique (lib.mapAttrsToList (_: inst: inst.port) enabled)) == lib.length (lib.attrNames enabled);
          message = "services.openclaw.instances: each instance needs its own port";
        }
      ];

    warnings =
      lib.mapAttrsToList (
        name: _: "services.openclaw.instances.${name}.sessionIcons is deprecated: the built-in session icon picker has the icon library under Icons now, and the plugin's Custom icons… action duplicates it. Remove the option; it goes after the 2026.11 releases."
      )
      (lib.filterAttrs (_: inst: inst.sessionIcons.enable) enabled);

    users.users = lib.mapAttrs' (name: inst:
      lib.nameValuePair inst.user {
        isSystemUser = true;
        inherit (inst) group;
        home = "/var/lib/openclaw/${name}";
        description = "OpenClaw gateway ${name}";
      })
    enabled;
    users.groups = lib.mapAttrs' (_: inst: lib.nameValuePair inst.group {}) enabled;

    systemd.services = lib.mapAttrs' (name: inst: lib.nameValuePair "openclaw-${name}" (unitFor name inst)) enabled;
    systemd.tmpfiles.rules = lib.concatLists (lib.mapAttrsToList logRules enabled);
    environment.systemPackages = lib.mapAttrsToList restoreFor enabled;

    networking.firewall.allowedTCPPorts = lib.concatLists (lib.mapAttrsToList (_: inst: lib.optional inst.openFirewall inst.port) enabled);
  };
}
