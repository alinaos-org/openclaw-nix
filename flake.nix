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

    pkgsFor = system:
      import nixpkgs {
        inherit system;
        overlays = [self.overlays.default];
      };
  in {
    lib = {
      inherit mkOverlay mkPackageSetOverlay mkUpgradeSkill;
      release = import ./release.nix;
    };

    overlays.default = mkOverlay {};

    packages = forAllSystems (system: let
      pkgs = pkgsFor system;
    in {
      default = pkgs.openclaw-gateway;
      gateway = pkgs.openclaw-gateway;
      gateway-hotfixed = pkgs.openclawNix.hotfix pkgs.openclaw-gateway;
      openclaw = pkgs.openclaw;
      upgrade-skill = mkUpgradeSkill {inherit pkgs;};
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
      formatting = pkgs.runCommand "openclaw-nix-formatting" {nativeBuildInputs = [pkgs.alejandra];} ''
        alejandra --check ${self}
        touch $out
      '';
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
  };
}
