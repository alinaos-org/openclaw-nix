# The gateways. Each instance is a user unit, openclaw-gateway-<name>, with its
# state in ~/.openclaw-<name>. Options: openclaw-nix README, "Workstations".
{
  users.users.alice.isNormalUser = true;
  home-manager.users.alice.home.stateVersion = "25.11";

  services.openclaw.workstation = {
    user = "alice";
    # VAR=value lines, readable by the user: OPENCLAW_GATEWAY_TOKEN and the
    # provider keys the config references (for example a sops-nix secret).
    sharedEnvironmentFile = "/run/secrets/openclaw.env";
    interactiveInstance = "main";
    instances.main = {
      configFile = ./main.json;
      gatewayPort = 18789;
      # Render a writable runtime config at each start, so the Control UI can
      # save within its policy.
      uiOverlay.enable = true;
    };
  };
}
