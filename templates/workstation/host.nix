# The machine and its one user. Bring over what you still need from your old
# /etc/nixos/configuration.nix (desktop, printers, extra packages) here.
{pkgs, ...}: {
  networking.hostName = "@HOSTNAME@";
  networking.networkmanager.enable = true;
  time.timeZone = "@TIME_ZONE@";
  i18n.defaultLocale = "en_US.UTF-8";

  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  users.users."@USER@" = {
    isNormalUser = true;
    description = "@FULL_NAME@";
    extraGroups = ["wheel" "networkmanager"];
  };
  home-manager.users."@USER@".home.stateVersion = "@STATE_VERSION@";

  nix.settings = {
    experimental-features = ["nix-command" "flakes"];
    # openclaw-nix's cache, so a rebuild downloads the gateway instead of compiling it.
    extra-substituters = ["https://alinaos-openclaw-nix.cachix.org"];
    extra-trusted-public-keys = ["alinaos-openclaw-nix.cachix.org-1:vLkWgaUe6XR3H+bIMF6QvMvxbrZJLFL9WyaVyrRD8Jo="];
  };
  environment.systemPackages = [pkgs.git pkgs.sops];

  # The NixOS release this machine was installed with; never change it afterwards.
  system.stateVersion = "@STATE_VERSION@";
}
