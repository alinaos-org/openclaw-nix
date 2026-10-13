# A workstation running OpenClaw gateways as user units of one desktop user, from
# openclaw-nix's workstation module. Start with `nix flake init -t
# github:alinaos-org/openclaw-nix#workstation`, then set the host, user and secrets.
{
  inputs = {
    # Pin a release tag rather than main (README, "Versions and support").
    openclaw-nix.url = "github:alinaos-org/openclaw-nix";
    nixpkgs.follows = "openclaw-nix/nixpkgs";
    home-manager.follows = "openclaw-nix/nix-openclaw/home-manager";
  };

  # The gateway build is cached; without this it compiles locally.
  nixConfig = {
    extra-substituters = ["https://alinaos-openclaw-nix.cachix.org"];
    extra-trusted-public-keys = ["alinaos-openclaw-nix.cachix.org-1:vLkWgaUe6XR3H+bIMF6QvMvxbrZJLFL9WyaVyrRD8Jo="];
  };

  outputs = {
    nixpkgs,
    home-manager,
    openclaw-nix,
    ...
  }: {
    nixosConfigurations.workstation = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./hardware-configuration.nix
        home-manager.nixosModules.home-manager
        openclaw-nix.nixosModules.workstation
        ./gateways.nix
      ];
    };
  };
}
