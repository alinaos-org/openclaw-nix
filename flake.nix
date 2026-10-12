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

    pkgsFor = system:
      import nixpkgs {
        inherit system;
        overlays = [self.overlays.default];
      };
  in {
    lib = {
      inherit mkOverlay mkPackageSetOverlay;
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
      formatting = pkgs.runCommand "openclaw-nix-formatting" {nativeBuildInputs = [pkgs.alejandra];} ''
        alejandra --check ${self}
        touch $out
      '';
    });

    formatter = forAllSystems (system: (pkgsFor system).alejandra);
  };
}
