# Declarative OpenClaw workspace bootstrap files: each agent's AGENTS.md,
# SOUL.md, USER.md, IDENTITY.md and HEARTBEAT.md from the host's repository.
#
# Store symlinks are deliberately not used. OpenClaw's hardened file reader can
# reject multi-hardlink store files, and sandbox seeding ignores aliases that
# resolve outside a workspace. Activation therefore copies each source through
# rsync (without -H) and atomically replaces only the managed paths.
{optionPath}: {
  config,
  lib,
  pkgs,
  ...
}: let
  workstation = lib.getAttrFromPath optionPath config;
  cfg = workstation.agentFiles;
  inherit (workstation) user home;
  group = config.users.users.${user}.group;
  option = path: lib.showOption (optionPath ++ ["agentFiles"] ++ path);

  managedNames = [
    "AGENTS.md"
    "SOUL.md"
    "USER.md"
    "IDENTITY.md"
    "HEARTBEAT.md"
  ];

  # Names this module managed once and has retired. Activation moves a copy
  # still in a managed workspace to a dated quarantine folder (never deletes
  # it), and the audit fails while one remains. TOOLS.md: OpenClaw 2026.9.3+
  # never loads it; keep its notes in an AGENTS.md section.
  retiredNames = ["TOOLS.md"];
  quarantineRoot = "${home}/.local/share/openclaw/retired-agent-files";

  # Optional managed names a workspace may add (BOOT.md: the boot-md hook's
  # once-per-start instructions).
  optionalNames = ["BOOT.md"];

  forbiddenNames = [
    "MEMORY.md"
    "DREAMS.md"
    "LESSONS.md"
    "memory"
    "skills"
    "openclaw-workspace-state.json"
  ];

  workspaceType = lib.types.submodule {
    options = {
      workspace = lib.mkOption {
        type = lib.types.str;
        description = "Absolute native OpenClaw workspace path.";
      };

      files = lib.mkOption {
        type = lib.types.attrsOf lib.types.path;
        description = "Managed bootstrap filename to repo or generated source path.";
      };
    };
  };

  workspaceValues = lib.attrValues cfg.workspaces;
  workspacePaths = map (entry: entry.workspace) workspaceValues;

  # Path literals below point into the flake source tree. Coercing those paths
  # to plain strings in an activation script does not retain their store-path
  # context, so a remote installation can receive the script without receiving
  # the referenced source tree. Stage every managed file in an explicit link
  # farm so the complete bootstrap source set is part of the system closure.
  sourceBundle = pkgs.linkFarm "openclaw-agent-files-sources" (lib.concatLists (lib.mapAttrsToList (
      workspaceName: entry:
        lib.mapAttrsToList (filename: source: {
          name = "${workspaceName}-${filename}";
          path = source;
        })
        entry.files
    )
    cfg.workspaces));

  materializeCalls = lib.concatStringsSep "\n" (lib.concatLists (lib.mapAttrsToList (
      workspaceName: entry:
        lib.mapAttrsToList (
          filename: _:
            "materialize_file ${lib.escapeShellArg entry.workspace} "
            + "${lib.escapeShellArg filename} ${sourceBundle}/${workspaceName}-${filename}"
        )
        entry.files
    )
    cfg.workspaces));

  auditCalls = lib.concatStringsSep "\n" (lib.concatLists (lib.mapAttrsToList (
      workspaceName: entry:
        lib.mapAttrsToList (
          filename: _:
            "check_file ${lib.escapeShellArg "${entry.workspace}/${filename}"} "
            + "${sourceBundle}/${workspaceName}-${filename}"
        )
        entry.files
    )
    cfg.workspaces));

  # Runs as the user, never root: every path it touches is user-writable, so a
  # planted symlink must not be able to redirect a root-owned mkdir or mv.
  retireScript = pkgs.writeShellScript "openclaw-agent-files-retire" ''
    set -eu
    umask 077
    day=$(${pkgs.coreutils}/bin/date +%F)
    while [ "$#" -ge 2 ]; do
      root="$1"
      name="$2"
      shift 2
      [ -e "$root/$name" ] || [ -L "$root/$name" ] || continue
      dir="${quarantineRoot}/$day/$(${pkgs.coreutils}/bin/basename "$root")"
      ${pkgs.coreutils}/bin/mkdir -p "$dir"
      target="$dir/$name"
      if [ -e "$target" ] || [ -L "$target" ]; then
        target="$target.$(${pkgs.coreutils}/bin/date +%s)"
      fi
      ${pkgs.coreutils}/bin/mv -nT "$root/$name" "$target"
      echo "openclaw-agent-files: retired $root/$name -> $target"
    done
  '';

  retireArgs =
    lib.concatMapStringsSep " " (
      entry: lib.concatMapStringsSep " " (name: "${lib.escapeShellArg entry.workspace} ${lib.escapeShellArg name}") retiredNames
    )
    workspaceValues;

  retiredAuditCalls = lib.concatStringsSep "\n" (lib.concatMap (
      entry:
        map (filename: "check_retired ${lib.escapeShellArg "${entry.workspace}/${filename}"}") retiredNames
    )
    workspaceValues);

  auditPackage = pkgs.writeShellApplication {
    name = "openclaw-agent-files-audit";
    runtimeInputs = [pkgs.coreutils];
    text = ''
      failures=0

      check_file() {
        destination="$1"
        source="$2"
        if [ ! -f "$destination" ]; then
          echo "MISSING $destination" >&2
          failures=$((failures + 1))
        elif [ -L "$destination" ]; then
          echo "SYMLINK $destination" >&2
          failures=$((failures + 1))
        elif [ "$(stat -c %h "$destination")" -ne 1 ]; then
          echo "HARDLINK $(stat -c %h "$destination") $destination" >&2
          failures=$((failures + 1))
        elif ! cmp -s "$source" "$destination"; then
          echo "DRIFT $destination" >&2
          failures=$((failures + 1))
        fi
      }

      check_retired() {
        if [ -e "$1" ] || [ -L "$1" ]; then
          echo "RETIRED $1 (activation moves it to ${quarantineRoot})" >&2
          failures=$((failures + 1))
        fi
      }

      ${auditCalls}
      ${retiredAuditCalls}

      if [ "$failures" -ne 0 ]; then
        echo "FAIL: $failures declarative agent-file violations" >&2
        exit 1
      fi
      echo "OK: ${toString (lib.length workspacePaths)} workspaces, ${toString (lib.length (lib.concatMap (e: lib.attrNames e.files) workspaceValues))} files"
    '';
  };
in {
  options = lib.setAttrByPath (optionPath ++ ["agentFiles"]) {
    enable = lib.mkEnableOption ''
      declarative agent workspace Markdown files, copied into each workspace at
      activation (openclaw-agent-files-audit checks them). Once every workspace
      has its complete set and the audit passes, set skipBootstrap'';

    workspaces = lib.mkOption {
      type = lib.types.attrsOf workspaceType;
      default = {};
      description = "Native agent workspaces and their declarative files.";
    };

    bootstrapMaxChars = lib.mkOption {
      type = lib.types.ints.positive;
      default = 20000;
      description = ''
        The instances' agents.defaults.bootstrapMaxChars: OpenClaw truncates a
        longer bootstrap file in the prompt, so a longer source fails evaluation.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions =
      [
        {
          assertion = cfg.workspaces != {};
          message = "${option ["enable"]} requires at least one workspace.";
        }
        {
          assertion = lib.length workspacePaths == lib.length (lib.unique workspacePaths);
          message = "${option ["workspaces"]} contains duplicate destination paths.";
        }
      ]
      ++ lib.mapAttrsToList (name: entry: {
        assertion = lib.hasPrefix "${home}/.openclaw" entry.workspace;
        message = ''
          ${option ["workspaces" name "workspace"]} must be an explicit
          OpenClaw workspace path under ${home}/.openclaw*.
        '';
      })
      cfg.workspaces
      ++ lib.mapAttrsToList (name: entry: {
        assertion = let
          names = lib.attrNames entry.files;
        in
          lib.all (n: lib.elem n names) managedNames
          && lib.all (n: lib.elem n (managedNames ++ optionalNames)) names;
        message = ''
          ${option ["workspaces" name "files"]} must contain
          ${lib.concatStringsSep ", " managedNames} and may add only
          ${lib.concatStringsSep ", " optionalNames}. Runtime-owned names such as
          ${lib.concatStringsSep ", " forbiddenNames} and retired names
          (${lib.concatStringsSep ", " retiredNames}) are forbidden.
        '';
      })
      cfg.workspaces
      # stringLength counts bytes, which is never fewer than characters, so this
      # bound is conservative.
      ++ lib.concatLists (lib.mapAttrsToList (name: entry:
        lib.mapAttrsToList (filename: source: {
          assertion = builtins.stringLength (builtins.readFile source) <= cfg.bootstrapMaxChars;
          message = ''
            ${option ["workspaces" name "files" filename]} is
            ${toString (builtins.stringLength (builtins.readFile source))} bytes; OpenClaw truncates bootstrap files
            over ${toString cfg.bootstrapMaxChars} characters. Move rare reference material into a skill.
          '';
        })
        entry.files)
      cfg.workspaces);

    system.activationScripts.openclawAgentFiles = {
      deps = ["users"];
      # Subshell: a top-level `set -e` leaks into the rest of activate, and an
      # abort in stage 1 leaves /run/current-system unlinked (the boot cannot
      # switch root).
      text = ''
        (
        set -eu

        materialize_file() {
          destination_root="$1"
          filename="$2"
          source_file="$3"

          ${pkgs.coreutils}/bin/install -d -m 0700 -o ${user} -g ${group} "$destination_root"
          stage_dir=$(${pkgs.coreutils}/bin/mktemp -d "$destination_root/.csa-agent-file.XXXXXX")
          ${pkgs.rsync}/bin/rsync --archive --copy-links "$source_file" "$stage_dir/$filename"
          ${pkgs.coreutils}/bin/chown ${user}:${group} "$stage_dir/$filename"
          ${pkgs.coreutils}/bin/chmod 0644 "$stage_dir/$filename"
          ${pkgs.coreutils}/bin/mv -Tf "$stage_dir/$filename" "$destination_root/$filename"
          ${pkgs.coreutils}/bin/rmdir "$stage_dir"
        }

        ${materializeCalls}
        ${pkgs.util-linux}/bin/runuser -u ${user} -- ${retireScript} ${retireArgs}
        )
      '';
    };

    environment.systemPackages = [auditPackage];
  };
}
