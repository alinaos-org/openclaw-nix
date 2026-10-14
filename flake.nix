{
  description = "Current OpenClaw releases on Nix: a source-built gateway and a single-release package set";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Upstream Nix packaging. Used for its source build recipe, CLI tool bundle
    # and runtime-plugin builder; its own OpenClaw pin is replaced by ours.
    nix-openclaw = {
      url = "github:openclaw/nix-openclaw/f62d33f760bcbdbc6a52ac589eae22bf99201f90";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # The gateway's source recipe and build scripts only, from the nix-openclaw
    # revision packages/gateway's repairs are written against. Upstream's later
    # recipe (build:package, filtered rebuilds) needs those repairs requalified.
    nix-openclaw-gateway = {
      url = "github:openclaw/nix-openclaw/e72fe70f6d23cf2efe8a2a693f0788090af9bde0";
      flake = false;
    };
  };

  outputs = {
    self,
    nixpkgs,
    nix-openclaw,
    nix-openclaw-gateway,
  }: let
    lib = nixpkgs.lib;
    systems = ["x86_64-linux"];
    forAllSystems = lib.genAttrs systems;

    # The package set overlay, parameterised for consumers that customise the
    # gateway or trim the CLI bundle: (mkOverlay { sharedBuild = true; customize = ...; }).
    # mkPackageSetOverlay leaves out nix-openclaw's overlay, for consumers
    # that already apply it.
    mkPackageSetOverlay = args: import ./overlay.nix {inherit nix-openclaw nix-openclaw-gateway self;} args;
    mkOverlay = args:
      lib.composeManyExtensions [
        nix-openclaw.overlays.default
        (mkPackageSetOverlay args)
      ];

    # The openclaw-upgrade skill (skills/openclaw-upgrade) with a host profile's files
    # added: references/host.md, scripts/host.env and host-only scripts. A profile
    # may add files, never replace the skill's own.
    mkUpgradeSkill = {
      pkgs,
      hostProfile ? null,
    }:
      pkgs.runCommand "openclaw-upgrade-skill" {} (''
          cp -r ${./skills/openclaw-upgrade} "$out"
          chmod -R u+w "$out"
        ''
        + lib.optionalString (hostProfile != null) ''
          while IFS= read -r -d "" f; do
            if [ -e "$out/$f" ]; then
              echo "openclaw-upgrade: the host profile may add files, not replace $f" >&2
              exit 1
            fi
            install -D -m "$(stat -c %a "${hostProfile}/$f")" "${hostProfile}/$f" "$out/$f"
          done < <(cd ${hostProfile} && find . -type f -printf '%P\0')
          test -f "$out/references/host.md" || {
            echo "openclaw-upgrade: the host profile has no references/host.md" >&2
            exit 1
          }
        '');

    # Nix config plus a Control UI that can save (packages/config-overlay):
    # cli, prepareConfig, sync, defaultPolicy.
    mkConfigOverlay = pkgs: pkgs.callPackage ./packages/config-overlay {};

    pkgsFor = system:
      import nixpkgs {
        inherit system;
        overlays = [self.overlays.default];
      };
  in {
    lib = {
      inherit mkOverlay mkPackageSetOverlay mkUpgradeSkill mkConfigOverlay;
      release = import ./release.nix;
      # The workstation module with its options at another path, for a host
      # that keeps its own namespace.
      mkWorkstationModule = {optionPath ? ["services" "openclaw" "workstation"]}:
        import ./modules/workstation/module.nix {inherit self nix-openclaw optionPath;};
    };

    overlays.default = mkOverlay {};

    # programs.openclaw.instances.<name>.configOverlay, for nix-openclaw's
    # Home Manager module.
    homeManagerModules.configOverlay = import ./modules/home-manager/config-overlay.nix {inherit self;};
    # Gateways as system services with their own users, state and hardening, for
    # servers (modules/nixos/openclaw.nix).
    nixosModules.openclaw = import ./modules/nixos/openclaw.nix {inherit self;};
    nixosModules.default = self.nixosModules.openclaw;
    # Gateways as systemd user units of one desktop user, over nix-openclaw's
    # Home Manager module, for workstations (modules/workstation/module.nix).
    nixosModules.workstation = self.lib.mkWorkstationModule {};

    # `nix flake init -t github:alinaos-org/openclaw-nix#workstation`
    templates.workstation = {
      path = ./templates/workstation;
      description = "A workstation with OpenClaw gateways as user units of one desktop user";
    };

    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
    in {
      default = pkgs.openclaw-gateway;
      gateway = pkgs.openclaw-gateway;
      gateway-hotfixed = pkgs.openclawNix.hotfix pkgs.openclaw-gateway;
      openclaw = pkgs.openclaw;
      upgrade-skill = mkUpgradeSkill {inherit pkgs;};
      # The session menu's Custom icons library (native Control UI plugin).
      session-icons = pkgs.openclawRuntimePlugins.session-icons;
      # Every runtime plugin at the release (CI builds them all).
      runtime-plugins = pkgs.linkFarm "openclaw-runtime-plugins" (map (name: {
          inherit name;
          path = pkgs.openclawRuntimePlugins.${name};
        })
        pkgs.openclawNix.runtimePluginIds);
    });

    checks = forAllSystems (system: let
      pkgs = pkgsFor system;
      p = self.packages.${system};
    in {
      # Every exported package belongs to the current release.
      single-release = pkgs.openclawNix.checkSingleRelease {
        roots = [p.gateway-hotfixed p.openclaw p.runtime-plugins];
      };
      # packages/hotfix/register.nix covers every patch and test file, each entry has a
      # test (or the reason there is none), an upstream status and a removal
      # condition, default.nix applies and runs them, and the package advertises
      # exactly the registered markers. Evaluation fails otherwise.
      hotfix-register = let
        inherit (pkgs) lib;
        register = import ./packages/hotfix/register.nix;
        files = builtins.attrNames (builtins.readDir ./packages/hotfix);
        sorted = lib.sort lib.lessThan;
        named = prefix: sorted (lib.filter (f: lib.hasPrefix prefix f && lib.hasSuffix ".mjs" f) files);
        base = path: baseNameOf (toString path);
        entries = lib.attrValues register;
        applied = builtins.readFile ./packages/hotfix/default.nix;
        has = e: field: (e.${field} or null) != null && e.${field} != "";
        problems =
          lib.optional (named "patch-" != sorted (map (e: base e.patch) entries))
          "patch files and register entries differ"
          ++ lib.optional (named "test-" != sorted (map (e: base e.test) (lib.filter (e: e.test != null) entries)))
          "test files and registered tests differ"
          ++ lib.concatLists (lib.mapAttrsToList (name: e:
            lib.optional (e.test == null && !(has e "untested")) "${name}: no test and no reason"
            ++ lib.optional (!(has e "fixes")) "${name}: no description"
            ++ lib.optional (!(has e "removeWhen")) "${name}: no removal condition"
            ++ lib.optional (e.upstream == null && !(has e "upstreamStatus")) "${name}: no upstream status"
            ++ lib.optional (!(lib.hasInfix "./${base e.patch}" applied)) "${name}: default.nix does not apply it"
            ++ lib.optional (e.test != null && !(lib.hasInfix "./${base e.test}" applied)) "${name}: default.nix does not run its test")
          register)
          ++ lib.optional (sorted (lib.attrValues p.gateway-hotfixed.passthru.hotfixes) != sorted (map (e: e.marker) entries))
          "the package's passthru.hotfixes and the register's markers differ";
      in
        if problems == []
        then pkgs.runCommand "hotfix-register" {} "touch $out"
        else throw "hotfix register: ${lib.concatStringsSep "; " problems}";
      # The fence refuses implicit and protected state, and runs the gateway
      # for its own host and state directory.
      state-fence = let
        fenced = pkgs.openclawNix.stateFence {
          gateway = p.gateway;
          hostname = "fence-test-host";
          stateDir = "/srv/openclaw-prod";
        };
      in
        pkgs.runCommand "openclaw-state-fence-test" {} ''
          rc=0; ${fenced}/bin/openclaw --version 2>err || rc=$?
          test "$rc" -eq 78 && grep -q 'must both be explicit' err
          rc=0; OPENCLAW_STATE_DIR=/srv/openclaw-prod OPENCLAW_CONFIG_PATH=/srv/openclaw-prod/openclaw.json \
            ${fenced}/bin/openclaw --version 2>err || rc=$?
          test "$rc" -eq 78 && grep -q 'protected production paths' err
          OPENCLAW_STATE_DIR=$TMPDIR/state OPENCLAW_CONFIG_PATH=$TMPDIR/state/openclaw.json HOME=$TMPDIR \
            ${fenced}/bin/openclaw --version | grep -F '${pkgs.openclawNix.release.current}'
          touch $out
        '';
      # The customize layer over the current release: a bundled channel that an
      # external plugin replaces (this release bundles a "buzz" channel) and a
      # consumer command.
      customize = pkgs.openclawNix.customize {
        gateway = p.gateway;
        replaceBundledChannels = ["buzz"];
        extraCommands = ''
          test -x "$node" && test -f "$root/dist/index.js"
          touch "$root/.customize-check"
        '';
      };
      # The skill assembled with a fixture host profile: frontmatter, script syntax,
      # and every relative link and anchor in its documents.
      upgrade-skill = let
        skill = mkUpgradeSkill {
          inherit pkgs;
          hostProfile = ./tests/upgrade-skill-host;
        };
      in
        pkgs.runCommand "openclaw-upgrade-skill-check" {nativeBuildInputs = [pkgs.python3];} ''
          python3 ${./tests/check-upgrade-skill.py} ${skill}
          touch $out
        '';
      # The overlay engine's own tests.
      config-overlay = (mkConfigOverlay pkgs).test;
      # prepareConfig end to end against a scratch state, with a stub openclaw.
      config-overlay-prepare = let
        o = mkConfigOverlay pkgs;
        stub = pkgs.writeShellScriptBin "openclaw" ''
          case "$1" in
            --version) echo "OpenClaw 2026.10.2 (stub)" ;;
            config) ${pkgs.jq}/bin/jq -e '.agents.defaults.thinkingDefault != "bogus"' "$OPENCLAW_CONFIG_PATH" >/dev/null ;;
            doctor) exit 0 ;;
            *) exit 2 ;;
          esac
        '';
        # The sandbox build directory: the state paths are baked in at evaluation.
        state = "/build/config-overlay-test/state";
        prepare = o.prepareConfig {
          name = "test";
          stateDir = state;
          runtimeConfig = "${state}/openclaw-runtime.json";
          package = stub;
          overlayPolicy = o.defaultPolicy;
          migrateOnUpgrade = true;
        };
        # A Nix-only instance that copies its runtime plugins out of the store.
        materializeState = "/build/config-overlay-test/materialize";
        prepareMaterialized = o.prepareConfig {
          name = "test-materialize";
          stateDir = materializeState;
          runtimeConfig = "${materializeState}/openclaw-runtime.json";
          package = stub;
          materializePluginsRoot = "${materializeState}/runtime-plugins";
        };
      in
        pkgs.runCommand "openclaw-config-overlay-prepare-test" {nativeBuildInputs = [pkgs.jq pkgs.findutils];} ''
          if [ "$NIX_BUILD_TOP" != /build ]; then
            echo "skipped: the build directory is $NIX_BUILD_TOP, not /build"
          else
            prepare=${prepare}/bin/openclaw-test-prepare-config state=${state} bash ${./tests/config-overlay/prepare.sh}
            prepare=${prepareMaterialized}/bin/openclaw-test-materialize-prepare-config state=${materializeState} \
              bash ${./tests/config-overlay/materialize.sh}
          fi
          touch $out
        '';
      config-overlay-fold = pkgs.runCommand "openclaw-config-overlay-fold-test" {nativeBuildInputs = [pkgs.jq pkgs.python3];} ''
        fold=${(mkConfigOverlay pkgs).fold} bash ${./tests/config-overlay/fold.sh}
        touch $out
      '';
      # The custom icon library plugin: its own tests run in its build.
      session-icons = p.session-icons;
      # The NixOS module in a VM: a gateway as its own system user, state and logs in
      # their directories, the credential kept out of the unit and the config, the
      # hardened unit's exposure, and a Control UI change that survives a restart.
      nixos-module = pkgs.testers.runNixOSTest {
        name = "openclaw-nixos-module";
        nodes.machine = {pkgs, ...}: {
          imports = [self.nixosModules.openclaw];
          virtualisation.memorySize = 4096;
          virtualisation.cores = 2;
          environment.systemPackages = [pkgs.curl pkgs.jq];
          # The rollback drill's "new release": the same gateway reporting another
          # version, so its first start migrates and snapshots the state.
          specialisation.upgraded.configuration = {config, ...}: {
            services.openclaw.instances.test.package = pkgs.writeShellScriptBin "openclaw" ''
              if [ "''${1:-}" = --version ]; then echo "OpenClaw 2099.1.1 (rollback drill)"; exit 0; fi
              exec ${config.services.openclaw.package}/bin/openclaw "$@"
            '';
          };
          # An OpenAI-compatible model that always answers STUB-OK and logs each request.
          systemd.services.stub-provider = {
            wantedBy = ["multi-user.target"];
            before = ["openclaw-test.service"];
            serviceConfig = {
              ExecStart = "${pkgs.python3}/bin/python3 -I ${./tests/nixos-module/stub-provider.py} /var/lib/stub-provider/requests.jsonl";
              StateDirectory = "stub-provider";
              DynamicUser = true;
            };
          };
          services.openclaw.instances.test = {
            port = 18789;
            configOverlay.enable = true;
            sessionIcons.enable = true;
            # A store file in the test only; a real host points at a root-only secret.
            credentials = {
              OPENCLAW_GATEWAY_TOKEN = "${pkgs.writeText "gateway-token" "vm-test-token"}";
              STUB_API_KEY = "${pkgs.writeText "stub-api-key" "vm-stub-key"}";
            };
            settings = {
              gateway = {
                mode = "local";
                port = 18789;
                bind = "loopback";
                auth = {
                  mode = "token";
                  token = "$OPENCLAW_GATEWAY_TOKEN";
                };
              };
              models = {
                mode = "merge";
                providers.stub = {
                  baseUrl = "http://127.0.0.1:9999/v1";
                  api = "openai-completions";
                  apiKey = {
                    source = "env";
                    provider = "default";
                    id = "STUB_API_KEY";
                  };
                  models = [
                    {
                      id = "stub-model";
                      name = "Stub";
                      input = ["text"];
                      contextWindow = 32768;
                      maxTokens = 1024;
                      reasoning = false;
                    }
                  ];
                };
              };
              agents.defaults = {
                workspace = "/var/lib/openclaw/test/workspace";
                thinkingDefault = "low";
                model.primary = "stub/stub-model";
              };
            };
          };
        };
        testScript = {nodes, ...}: ''
          import json

          state = "/var/lib/openclaw/test"
          gw = "${nodes.machine.services.openclaw.instances.test.package}/bin/openclaw"

          def openclaw(args):
              # The instance's own user, state and config, as an operator would run it.
              return machine.succeed(
                  f"runuser -u openclaw-test -- env HOME={state} OPENCLAW_STATE_DIR={state} "
                  f"OPENCLAW_CONFIG_PATH={state}/openclaw-runtime.json OPENCLAW_NIX_MODE=1 "
                  f"OPENCLAW_GATEWAY_TOKEN=vm-test-token {gw} {args}"
              )

          machine.wait_for_unit("openclaw-test.service")
          machine.wait_until_succeeds("curl -sf http://127.0.0.1:18789/readyz", timeout=600)

          with subtest("own user, state and file logs"):
              pid = machine.succeed("systemctl show -p MainPID --value openclaw-test").strip()
              machine.succeed(f"test \"$(ps -o user:32= -p {pid})\" = openclaw-test")
              machine.succeed(f"test \"$(stat -c %U:%a {state})\" = openclaw-test:700")
              machine.wait_until_succeeds("ls /var/log/openclaw/test/openclaw-*.log", timeout=120)

          with subtest("the credentials stay out of the unit and the configs"):
              for secret in ["vm-test-token", "vm-stub-key"]:
                  machine.fail(f"grep -q {secret} /etc/systemd/system/openclaw-test.service")
                  machine.fail(f"grep -q {secret} {state}/openclaw.json {state}/openclaw-runtime.json")

          with subtest("hardened"):
              line = machine.succeed("systemd-analyze security openclaw-test.service | tail -1")
              exposure = float(line.split(":")[1].split()[0])
              print(f"exposure {exposure}")
              assert exposure <= 3.0, line

          with subtest("an agent turn reaches the model provider with the instance's credential"):
              # The prompt never names the stub's answer, so only the provider can supply it.
              reply = openclaw("agent --agent main --session-key agent:main:vm-test -m 'Say hello.' --json")
              print(reply)

              def visible(node):
                  if isinstance(node, dict):
                      if "finalAssistantVisibleText" in node:
                          yield node["finalAssistantVisibleText"]
                      for value in node.values():
                          yield from visible(value)
                  elif isinstance(node, list):
                      for value in node:
                          yield from visible(value)

              assert "STUB-OK" in list(visible(json.loads(reply))), reply
              requests = [json.loads(line) for line in machine.succeed("cat /var/lib/stub-provider/requests.jsonl").splitlines()]
              turns = [r for r in requests if r["path"].endswith("/chat/completions")]
              assert turns, requests
              assert all(r["model"] == "stub-model" and r["authorization"] == "Bearer vm-stub-key" for r in turns), turns

          with subtest("the custom icon library is a native Control UI plugin the gateway serves"):
              listed = openclaw("gateway call plugins.controlUi.list --json --timeout 30000 --params '{}'")
              print(listed)
              assert "session-icons" in listed, listed
              assert json.loads(listed)["diagnostics"] == [], listed
              # Loaded from the state directory: the gateway refuses hardlinked store files.
              machine.succeed(
                  f"jq -e --arg r {state}/runtime-plugins/ "
                  f"'.plugins.load.paths | length == 1 and (.[0] | startswith($r))' {state}/openclaw-runtime.json"
              )

          with subtest("an allowed Control UI change survives a restart"):
              machine.succeed("systemctl stop openclaw-test")
              machine.succeed(
                  f"runuser -u openclaw-test -- sh -c "
                  f"'jq \".agents.defaults.thinkingDefault = \\\"high\\\"\" {state}/openclaw-runtime.json > {state}/edit.json "
                  f"&& mv {state}/edit.json {state}/openclaw-runtime.json'"
              )
              machine.succeed("systemctl start openclaw-test")
              machine.wait_until_succeeds("curl -sf http://127.0.0.1:18789/readyz", timeout=600)
              machine.succeed(f"jq -e '.agents.defaults.thinkingDefault == \"high\"' {state}/openclaw-runtime.json")
              machine.succeed(f"jq -e '.entries | length == 1' {state}/config-overlay.json")

          with subtest("rollback: the previous package gets the pre-upgrade state back"):
              base = "${nodes.machine.system.build.toplevel}"
              ready = "curl -sf http://127.0.0.1:18789/readyz"

              def sessions():
                  return openclaw("gateway call sessions.list --json --timeout 30000 --params '{}'")

              def snapshot_count():
                  return int(machine.succeed(f"ls -d {state}/backups/pre-migrate-* | wc -l"))

              base_version = machine.succeed(f"{gw} --version | head -1").strip()
              openclaw("agent --agent main --session-key agent:main:before-upgrade -m 'Say hello.' --json")

              # Upgrade: the new package's first start snapshots the state, then migrates it.
              before = snapshot_count()
              machine.succeed(f"{base}/specialisation/upgraded/bin/switch-to-configuration test")
              machine.wait_until_succeeds(ready, timeout=600)
              assert snapshot_count() == before + 1
              listing = machine.succeed("openclaw-test-restore list")
              print(listing)
              assert f"{base_version} -> OpenClaw 2099.1.1 (rollback drill)" in listing.splitlines()[0], listing
              openclaw("agent --agent main --session-key agent:main:after-upgrade -m 'Say hello.' --json")
              assert "agent:main:after-upgrade" in sessions()

              # Roll back: stop the gateway, restore with the previous generation's command
              # (the newer one's refuses: its package is not the snapshot's), then switch
              # to that generation, which starts the gateway on the restored state.
              machine.succeed("systemctl stop openclaw-test")
              machine.fail("openclaw-test-restore restore latest")
              machine.succeed(f"{base}/sw/bin/openclaw-test-restore restore latest")
              machine.fail("systemctl is-active openclaw-test")
              machine.succeed(f"{base}/bin/switch-to-configuration test")
              machine.succeed("systemctl start openclaw-test")
              machine.wait_until_succeeds(ready, timeout=600)

              listed = sessions()
              assert "agent:main:before-upgrade" in listed, listed
              assert "agent:main:after-upgrade" not in listed, listed
              assert machine.succeed(f"cat {state}/.migrated-for-version").strip() == base_version
              # Restored state is marked for this package: the start did not migrate again.
              assert snapshot_count() == before + 1
              machine.succeed(f"ls {state}/backups/restore-*/replaced/agents")
        '';
      };
      # The workstation module in a VM: one gateway as a user unit of a desktop
      # user, started at boot through linger, with its secrets from the shared env
      # file, the Custom icons library copied into its state, and one agent turn against a
      # stub model provider; its workspace files, their heartbeat checklist, and
      # the nightly fold of a Control UI edit into a git commit.
      workstation = pkgs.testers.runNixOSTest {
        name = "openclaw-workstation";
        # The module adds its package-set overlays, as on a real host.
        node.pkgsReadOnly = false;
        nodes.machine = {
          lib,
          pkgs,
          ...
        }: {
          imports = [
            nix-openclaw.inputs.home-manager.nixosModules.home-manager
            self.nixosModules.workstation
          ];
          virtualisation.memorySize = 4096;
          virtualisation.cores = 2;
          environment.systemPackages = [pkgs.curl pkgs.git pkgs.jq];
          users.users.alice.isNormalUser = true;
          home-manager.users.alice.home.stateVersion = "25.11";
          # A test file; a real host points at a secret only the user can read.
          environment.etc."openclaw-test.env" = {
            text = ''
              OPENCLAW_GATEWAY_TOKEN=ws-test-token
              STUB_API_KEY=ws-stub-key
            '';
            user = "alice";
            mode = "0400";
          };
          systemd.services.stub-provider = {
            wantedBy = ["multi-user.target"];
            serviceConfig = {
              ExecStart = "${pkgs.python3}/bin/python3 -I ${./tests/nixos-module/stub-provider.py} /var/lib/stub-provider/requests.jsonl";
              StateDirectory = "stub-provider";
              DynamicUser = true;
            };
          };
          services.openclaw.workstation = {
            user = "alice";
            sharedEnvironmentFile = "/etc/openclaw-test.env";
            interactiveInstance = "main";
            instances.main = {
              # A file in the repository, as uiSync folds into it.
              configFile = ./tests/workstation/main.json;
              gatewayPort = 18789;
              runtimePlugins = ["session-icons"];
              materializeRuntimePlugins = true;
              # Labs > Custom plugin UI, which the Custom icons library needs; nix-openclaw's
              # typed options reject this key, so it rides the runtime filter.
              runtimeConfigJqFilter = ''.gateway.controlUi.experimental = {"customPlugins": true}'';
              uiOverlay.enable = true;
            };
            agentFiles = {
              enable = true;
              workspaces.main = {
                workspace = "/home/alice/.openclaw-main/workspace";
                files = lib.genAttrs ["AGENTS.md" "SOUL.md" "USER.md" "IDENTITY.md" "HEARTBEAT.md"] (
                  name: ./tests/workstation + "/workspace-${name}"
                );
              };
            };
            heartbeatChecklists.enable = true;
            uiSync = {
              enable = true;
              repo = "/home/alice/config";
              sourceFile = name: "tests/workstation/${name}.json";
            };
          };
        };
        testScript = {nodes, ...}: ''
          import json

          state = "/home/alice/.openclaw-main"
          as_alice = "runuser -u alice -- env HOME=/home/alice XDG_RUNTIME_DIR=/run/user/$(id -u alice) "
          workspace = f"{state}/workspace"

          def openclaw(args):
              # The interactive instance's CLI, as the desktop user runs it.
              return machine.succeed(
                  "runuser -u alice -- env HOME=/home/alice "
                  f"OPENCLAW_STATE_DIR={state} OPENCLAW_CONFIG_PATH={state}/openclaw-runtime.json "
                  f"OPENCLAW_GATEWAY_TOKEN=ws-test-token /etc/profiles/per-user/alice/bin/openclaw {args}"
              )

          machine.wait_for_unit("multi-user.target")
          machine.wait_for_unit("openclaw-gateway-main.service", "alice")
          machine.wait_until_succeeds("curl -sf http://127.0.0.1:18789/readyz", timeout=600)

          with subtest("a user unit of alice, started at boot through linger"):
              machine.succeed("test -e /var/lib/systemd/linger/alice")
              pid = machine.succeed(
                  "runuser -u alice -- env XDG_RUNTIME_DIR=/run/user/$(id -u alice) "
                  "systemctl --user show -p MainPID --value openclaw-gateway-main.service"
              ).strip()
              machine.succeed(f"test \"$(ps -o user:32= -p {pid})\" = alice")
              machine.succeed(f"test \"$(stat -c %U {state})\" = alice")

          with subtest("the shared env file's secrets stay out of the configs"):
              for secret in ["ws-test-token", "ws-stub-key"]:
                  machine.fail(f"grep -q {secret} {state}/openclaw.json {state}/openclaw-runtime.json")

          with subtest("the Custom icons library loads from the state directory"):
              listed = openclaw("gateway call plugins.controlUi.list --json --timeout 30000 --params '{}'")
              print(listed)
              assert "session-icons" in listed, listed
              assert json.loads(listed)["diagnostics"] == [], listed
              machine.succeed(
                  f"jq -e --arg r {state}/runtime-plugins/ "
                  f"'[.plugins.load.paths[] | select(startswith($r))] | length >= 1' {state}/openclaw-runtime.json"
              )

          with subtest("an agent turn reaches the model provider with the shared env file's key"):
              reply = openclaw("agent --agent main --session-key agent:main:ws-test -m 'Say hello.' --json")
              print(reply)
              assert "STUB-OK" in reply, reply
              requests = [json.loads(line) for line in machine.succeed("cat /var/lib/stub-provider/requests.jsonl").splitlines()]
              turns = [r for r in requests if r["path"].endswith("/chat/completions")]
              assert turns and all(r["authorization"] == "Bearer ws-stub-key" for r in turns), requests

          with subtest("the operator commands: overlay and restore"):
              machine.succeed("test -x /etc/profiles/per-user/alice/bin/openclaw-overlay-main")
              restore = as_alice + "/etc/profiles/per-user/alice/bin/openclaw-main-restore"
              # A fresh state has never migrated: nothing to list, and no error.
              print(machine.succeed(f"{restore} list"))
              # Never against a running gateway.
              status, output = machine.execute(f"{restore} restore latest 2>&1")
              print(output)
              assert status != 0 and "is running" in output, output

          with subtest("agentFiles: the workspace files, single-link copies the user owns"):
              for name in ["AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md", "HEARTBEAT.md"]:
                  machine.succeed(f"grep -qx 'ws-test {name}' {workspace}/{name}")
                  machine.succeed(f"test \"$(stat -c '%U %h' {workspace}/{name})\" = 'alice 1'")
              print(machine.succeed("openclaw-agent-files-audit"))
              # A retired name: the audit fails until activation moves it aside.
              machine.succeed(f"runuser -u alice -- sh -c 'echo notes > {workspace}/TOOLS.md'")
              machine.fail("openclaw-agent-files-audit")
              machine.succeed("/run/current-system/activate")
              machine.succeed(f"test ! -e {workspace}/TOOLS.md")
              machine.succeed("grep -qx notes /home/alice/.local/share/openclaw/retired-agent-files/*/workspace/TOOLS.md")
              print(machine.succeed("openclaw-agent-files-audit"))

          with subtest("heartbeatChecklists: synced after the gateway start, and no drift"):
              unit = "openclaw-main-heartbeat-checklists.service"
              machine.wait_until_succeeds(
                  as_alice + f"systemctl --user show -p SubState --value {unit} | grep -qx -e exited -e failed", timeout=420
              )
              print(machine.succeed(f"journalctl --no-pager _SYSTEMD_USER_UNIT={unit}"))
              result = machine.succeed(as_alice + f"systemctl --user show -p Result --value {unit}").strip()
              assert result == "success", result
              tool = "${nodes.machine.services.openclaw.workstation.heartbeatChecklists.tool}/bin/openclaw-heartbeat-checklists"
              # The interactive instance's token comes from the shared env file.
              drift = machine.succeed(as_alice + f"env -u OPENCLAW_GATEWAY_TOKEN {tool} check main")
              assert drift.strip() == "", drift

          with subtest("uiSync: a Control UI edit becomes a commit on main-ui-sync"):
              repo = "/home/alice/config"
              machine.succeed(
                  "runuser -u alice -- sh -c '"
                  "git config --global user.name Alice && git config --global user.email alice@example.test && "
                  f"mkdir -p {repo}/tests/workstation && cp ${./tests/workstation/main.json} {repo}/tests/workstation/main.json && "
                  f"chmod u+w {repo}/tests/workstation/main.json && "
                  f"git -C {repo} init -q -b main && git -C {repo} add -A && git -C {repo} commit -q -m init'"
              )
              def git(args):
                  return machine.succeed(as_alice + f"git -C {repo} {args}").strip()

              main = git("rev-parse main")
              sync = as_alice + "systemctl --user start openclaw-main-ui-sync.service"
              machine.succeed(sync)
              # Nothing to fold: no branch yet, or one equal to main.
              status, branch = machine.execute(as_alice + f"git -C {repo} rev-parse -q --verify main-ui-sync")
              assert status != 0 or branch.strip() == main, branch
              # What the Control UI does when it saves a setting its policy allows:
              # a hot-applied edit to the runtime file.
              machine.succeed(
                  f"runuser -u alice -- sh -c 'jq \".agents.defaults.thinkingDefault = \\\"high\\\"\" {state}/openclaw-runtime.json > {state}/edit.json "
                  f"&& mv {state}/edit.json {state}/openclaw-runtime.json'"
              )
              machine.succeed(sync)
              print(machine.succeed("journalctl --no-pager _SYSTEMD_USER_UNIT=openclaw-main-ui-sync.service"))
              print(git("log --format=%s%n%b -1 main-ui-sync"))
              folded = json.loads(git("show main-ui-sync:tests/workstation/main.json"))
              assert folded["agents"]["defaults"]["thinkingDefault"] == "high", folded
              assert git("rev-parse main-ui-sync~1") == main
        '';
      };
      # The Home Manager module over nix-openclaw's: a writable instance gets the
      # prepare step, the runtime config and Nix mode off (after nix-openclaw's
      # own environment), its operator command, and the nightly sync timer.
      config-overlay-home-manager = let
        stub = pkgs.writeShellScriptBin "openclaw" "exit 0";
        home = nix-openclaw.inputs.home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          modules = [
            nix-openclaw.homeManagerModules.openclaw
            self.homeManagerModules.configOverlay
            {
              home = {
                username = "alice";
                homeDirectory = "/home/alice";
                stateVersion = "25.05";
              };
              programs.openclaw = {
                enable = true;
                installApp = false;
                instances.demo = {
                  config.gateway.mode = "local";
                  configOverlay = {
                    enable = true;
                    package = stub;
                    sync = {
                      enable = true;
                      repo = "/home/alice/config";
                      worktree = "/home/alice/config-demo-ui-sync";
                      sourceFile = "openclaw/demo.json";
                    };
                  };
                };
              };
            }
          ];
        };
        cfg = home.config;
        service = cfg.systemd.user.services."openclaw-gateway-demo".Service;
        env = service.Environment;
        prepare = lib.head (lib.toList service.ExecStartPre);
        sync = lib.head (lib.toList cfg.systemd.user.services."openclaw-demo-ui-sync".Service.ExecStart);
      in
        assert lib.hasSuffix "/bin/openclaw-demo-prepare-config" prepare;
        assert lib.elem "OPENCLAW_CONFIG_PATH=/home/alice/.openclaw-demo/openclaw.json" env;
        assert lib.elem "OPENCLAW_CONFIG_PATH=/home/alice/.openclaw-demo/openclaw-runtime.json" env;
        # systemd keeps the last assignment: the writable config and Nix mode off.
        assert lib.last (lib.filter (lib.hasPrefix "OPENCLAW_CONFIG_PATH=") env) == "OPENCLAW_CONFIG_PATH=/home/alice/.openclaw-demo/openclaw-runtime.json";
        assert lib.last (lib.filter (lib.hasPrefix "OPENCLAW_NIX_MODE=") env) == "OPENCLAW_NIX_MODE=0";
        assert cfg.systemd.user.timers ? "openclaw-demo-ui-sync";
        assert lib.any (p: lib.hasSuffix "openclaw-overlay-demo" (p.name or "")) cfg.home.packages;
          pkgs.runCommand "openclaw-config-overlay-home-manager-test" {} ''
            test -x ${prepare}
            test -x ${sync}
            touch $out
          '';
      formatting = pkgs.runCommand "openclaw-nix-formatting" {nativeBuildInputs = [pkgs.alejandra];} ''
        alejandra --check ${self}
        touch $out
      '';
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
  };
}
