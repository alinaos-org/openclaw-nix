# The gateway and its secrets. Every variable the gateway needs is in
# requiredEnvironment: the ${VAR} references in openclaw/main.json, plus the
# provider key OpenClaw reads implicitly. Each one is a key of
# secrets/openclaw.yaml under its lower-case name (OPENCLAW_GATEWAY_TOKEN is
# openclaw_gateway_token), encrypted for this machine's SSH host key and your own
# age key (.sops.yaml). Add or change one with `sops secrets/openclaw.yaml`; a
# reference without its key fails the build and names the key.
{
  config,
  lib,
  ...
}: let
  user = "@USER@";
  provider = "@PROVIDER@";
  # The variable your model provider's API key goes in, or "" when you sign in with
  # a subscription instead (`openclaw models auth login`, README.md).
  providerKeyVariable = "@PROVIDER_KEY_VARIABLE@";
  required = config.services.openclaw.workstation.instances.main.requiredEnvironment;
in {
  sops = {
    defaultSopsFile = ./secrets/openclaw.yaml;
    age.sshKeyPaths = ["/etc/ssh/ssh_host_ed25519_key"];
    secrets = lib.genAttrs (map lib.toLower required) (_: {});
    # The gateway reads them from one env file that only you can read.
    templates."openclaw.env" = {
      owner = user;
      mode = "0400";
      content = lib.concatMapStrings (name: "${name}=${config.sops.placeholder.${lib.toLower name}}\n") required;
    };
  };

  services.openclaw.workstation = {
    inherit user;
    # OpenAI's models run through OpenClaw's Codex harness, a plugin built
    # separately from the gateway and copied into its trusted tree.
    bundledRuntimePlugins = lib.optional (provider == "openai") "codex";
    sharedEnvironmentFile = config.sops.templates."openclaw.env".path;
    interactiveInstance = "main";
    instances.main = {
      configFile = ./openclaw/main.json;
      gatewayPort = 18789;
      extraRequiredEnvironment = lib.optional (providerKeyVariable != "") providerKeyVariable;
      # The gateway drops OPENAI_API_KEY by default, so a stray key never
      # overrides a subscription sign-in; keep it when it is how you sign in.
      unsetOpenAIApiKey = providerKeyVariable != "OPENAI_API_KEY";
      # The Control UI may save settings within its policy; `openclaw-overlay-main`
      # shows what it changed, to fold back into openclaw/main.json. It needs a
      # writable runtime config rendered at each start: the identity filter.
      uiOverlay.enable = true;
      runtimeConfigJqFilter = ".";
    };
  };
}
