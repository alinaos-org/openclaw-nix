{
  description = "Current OpenClaw releases on Nix: a source-built gateway and a single-release package set";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Upstream Nix packaging. Used for its source build recipe, CLI tool bundle
    # and runtime-plugin builder; its own OpenClaw pin is replaced by ours.
    nix-openclaw = {
      url = "github:openclaw/nix-openclaw/e72fe70f6d23cf2efe8a2a693f0788090af9bde0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {
    self,
    nixpkgs,
    nix-openclaw,
  }: let
    lib = nixpkgs.lib;
    systems = ["x86_64-linux"];
    forAllSystems = lib.genAttrs systems;

    # The package set overlay, parameterised for consumers that customise the
    # gateway or trim the CLI bundle: (mkOverlay { sharedBuild = true; customize = ...; }).
    # mkPackageSetOverlay leaves out nix-openclaw's overlay, for consumers
    # that already apply it.
    mkPackageSetOverlay = args: import ./overlay.nix {inherit nix-openclaw self;} args;
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
    };

    overlays.default = mkOverlay {};

    # programs.openclaw.instances.<name>.configOverlay, for nix-openclaw's
    # Home Manager module.
    homeManagerModules.configOverlay = import ./modules/home-manager/config-overlay.nix {inherit self;};
    # Gateways as system services with their own users, state and hardening, for
    # servers (modules/nixos/openclaw.nix).
    nixosModules.openclaw = import ./modules/nixos/openclaw.nix {inherit self;};
    nixosModules.default = self.nixosModules.openclaw;

    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
    in {
      default = pkgs.openclaw-gateway;
      gateway = pkgs.openclaw-gateway;
      gateway-hotfixed = pkgs.openclawNix.hotfix pkgs.openclaw-gateway;
      openclaw = pkgs.openclaw;
      upgrade-skill = mkUpgradeSkill {inherit pkgs;};
      # The session menu's Icon library (native Control UI plugin).
      session-icons = pkgs.openclawRuntimePlugins.session-icons;
      runtime-plugins = pkgs.linkFarm "openclaw-runtime-plugins" (lib.mapAttrsToList (name: path: {inherit name path;}) (lib.filterAttrs (id: _: pkgs.openclawNix.pins.plugins ? ${id}) pkgs.openclawRuntimePlugins));
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
      # The Icon library plugin: its own tests run in its build.
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

          with subtest("the Icon library is a native Control UI plugin the gateway serves"):
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
