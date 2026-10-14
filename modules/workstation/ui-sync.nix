# Nightly: turn each writable gateway's Control UI overlay into a reviewable
# commit (every instance with uiOverlay.enable).
#
# A writable gateway keeps policy-allowed Control UI edits in
# <stateDir>/config-overlay.json, but that file is only updated when the
# gateway starts; a hot-applied UI edit lives in the runtime file until then.
# So each job folds `openclaw-overlay-<name> preview` (what the next capture
# would keep, from the live runtime file, writing nothing) rather than the
# stored overlay. It rebuilds the machine-owned branch `<name>-ui-sync` from
# the checkout's local `main` each night, folds the overlay into the
# instance's source file (mapping the runtime shape back to the source shape),
# and commits if anything changed. It never pushes, never merges, never
# activates. Merge the branch to make the declarative gateway match what the
# UI did; the overlay entries then prune themselves at the next start.
{optionPath}: {
  config,
  lib,
  pkgs,
  ...
}: let
  workstation = lib.getAttrFromPath optionPath config;
  cfg = workstation.uiSync;
  instances = lib.filterAttrs (_: inst: inst.uiOverlay.enable) workstation.instances;
  option = path: lib.showOption (optionPath ++ ["uiSync"] ++ path);
  pathType = with lib.types; listOf str;
  syncFor = name: inst:
    pkgs.openclawNix.configOverlay.sync {
      inherit name;
      inherit (cfg) renames exclude repo;
      inherit (inst) stateDir;
      policy = inst.uiOverlay.policyFile;
      worktree = "${cfg.worktreeRoot}/${name}-ui-sync";
      sourceFile = cfg.sourceFile name;
    };
in {
  options = lib.setAttrByPath (optionPath ++ ["uiSync"]) {
    enable = lib.mkEnableOption ''
      a nightly job per uiOverlay instance that folds its Control UI edits into
      a commit on the branch <name>-ui-sync of `repo` (no push, no merge, no
      activation)'';

    repo = lib.mkOption {
      type = lib.types.str;
      example = "/home/alice/src/workstation";
      description = "Checkout of the repository that declares the instances, owned by the user.";
    };

    worktreeRoot = lib.mkOption {
      type = lib.types.str;
      default = "${builtins.dirOf cfg.repo}/${builtins.baseNameOf cfg.repo}-worktrees";
      defaultText = lib.literalExpression ''"''${dirOf repo}/''${baseNameOf repo}-worktrees"'';
      description = "Where each job keeps its worktree, <worktreeRoot>/<name>-ui-sync.";
    };

    sourceFile = lib.mkOption {
      type = lib.types.functionTo lib.types.str;
      example = lib.literalExpression ''name: "gateways/''${name}.json"'';
      description = ''
        An instance's source config, relative to `repo`: the file its
        configFile is, which the job folds the overlay into.
      '';
    };

    schedule = lib.mkOption {
      type = with lib.types; attrsOf str;
      default = {};
      example = {
        main = "02:40";
        work = "02:50";
      };
      description = ''
        OnCalendar per instance (03:10 otherwise). Stagger them: the jobs share a
        lock, and Persistent timers that missed a night all fire at boot.
      '';
    };

    renames = lib.mkOption {
      type = with lib.types;
        listOf (submodule {
          options = {
            from = lib.mkOption {
              type = pathType;
              description = "Key path in the source file.";
            };
            to = lib.mkOption {
              type = pathType;
              description = "The same key's path in the runtime config.";
            };
          };
        });
      default = [];
      description = "Keys the host's render moves: the fold maps each runtime path back to its source path.";
    };

    exclude = lib.mkOption {
      type = with lib.types; listOf pathType;
      default = [["ui"]];
      description = ''
        Key paths kept in the overlay, never folded into source. ui is Control
        UI state, not configuration: its sidebar pins name individual sessions
        and change with every click.
      '';
    };
  };

  config = lib.mkIf (cfg.enable && instances != {}) {
    # The job folds into the instance's source file; an instance rendered from
    # anywhere else would get a commit against the wrong file.
    assertions =
      lib.mapAttrsToList (name: inst: {
        assertion = lib.hasSuffix "/${cfg.sourceFile name}" (toString inst.configFile);
        message = "OpenClaw instance ${name}: ${option ["sourceFile"]} is ${cfg.sourceFile name}, but configFile is ${toString inst.configFile}";
      })
      instances;

    systemd.user.services = lib.mapAttrs' (name: inst:
      lib.nameValuePair "openclaw-${name}-ui-sync" {
        description = "Fold ${name}'s Control UI overlay into a ${name}-ui-sync commit (no push, no activation)";
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${syncFor name inst}/bin/openclaw-${name}-ui-sync";
        };
      })
    instances;
    systemd.user.timers = lib.mapAttrs' (name: _:
      lib.nameValuePair "openclaw-${name}-ui-sync" {
        description = "Nightly ${name} Control UI overlay -> git branch";
        wantedBy = ["timers.target"];
        timerConfig = {
          OnCalendar = cfg.schedule.${name} or "03:10";
          RandomizedDelaySec = "5m";
          Persistent = true;
        };
      })
    instances;
  };
}
