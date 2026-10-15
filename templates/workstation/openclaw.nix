# The gateway and its secrets. The secrets live in secrets/openclaw.yaml, encrypted
# for this machine's SSH host key and your own age key (secrets/.sops.yaml). Change
# them with `sops secrets/openclaw.yaml`, never in the clear.
{
  config,
  lib,
  ...
}: let
  user = "@USER@";
  # The variable your model provider's API key goes in, or "" when you sign in with
  # a subscription instead (`oc-main models auth login`, README.md).
  providerKeyVariable = "@PROVIDER_KEY_VARIABLE@";
in {
  sops = {
    defaultSopsFile = ./secrets/openclaw.yaml;
    age.sshKeyPaths = ["/etc/ssh/ssh_host_ed25519_key"];
    secrets =
      {openclaw_gateway_token = {};}
      // lib.optionalAttrs (providerKeyVariable != "") {provider_api_key = {};};
    # The gateway reads its secrets from one env file that only you can read.
    templates."openclaw.env" = {
      owner = user;
      mode = "0400";
      content =
        ''
          OPENCLAW_GATEWAY_TOKEN=${config.sops.placeholder.openclaw_gateway_token}
        ''
        + lib.optionalString (providerKeyVariable != "") ''
          ${providerKeyVariable}=${config.sops.placeholder.provider_api_key}
        '';
    };
  };

  services.openclaw.workstation = {
    inherit user;
    sharedEnvironmentFile = config.sops.templates."openclaw.env".path;
    interactiveInstance = "main";
    instances.main = {
      configFile = ./openclaw/main.json;
      gatewayPort = 18789;
      # The Control UI may save settings within its policy; `openclaw-overlay-main`
      # shows what it changed, to fold back into openclaw/main.json. It needs a
      # writable runtime config rendered at each start: the identity filter.
      uiOverlay.enable = true;
      runtimeConfigJqFilter = ".";
    };
  };
}
