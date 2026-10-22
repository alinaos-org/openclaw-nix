# The hotfix layer's register: every patch openclaw-nix applies to upstream's build
# output, what it fixes, how the build proves it, where it stands upstream and when it
# goes. checks.hotfix-register fails a patch file with no entry here, an entry with no
# test (or a recorded reason there is none), a test file nobody registers, and a
# marker the package advertises that the register does not know.
#
# Policy (README, "Hotfix layer"): a patch is a last resort for a bug that breaks a
# supported deployment. It checks the exact code it replaces, found exactly once, so a
# release that moves or fixes that code fails the build; a test exercises the patched
# code in the build; and it is reported upstream, then removed when upstream's fix
# ships in a release openclaw-nix pins.
{
  mcpCloseRejection = {
    patch = ./patch-mcp-close-rejection.mjs;
    marker = "openclaw-mcp-observe-close-rejection-v1";
    since = "2026.9.3";
    fixes = ''
      MCP: a rejected close() during a failed initialize surfaced as an unhandled
      rejection and could stop the gateway. Upstream observes it itself since 2026.9.5;
      on those releases this file only verifies upstream's fix in the packaged code.
      Its one edit there is the Codex stale-registration fix
      (openclaw-codex-stale-registration-v1): drop a registered child that is gone or
      whose PID was reused, instead of two whole-host process scans after a crash.
    '';
    test = null;
    untested = ''
      The MCP part runs upstream's packaged connectMcpClient in a VM context and
      asserts the rejection is observed. The Codex stale-registration edit has no test.
    '';
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = ''
      Split the Codex stale-registration edit into its own patch with a test; the MCP
      verification then becomes a regression test. Remove the Codex patch when upstream
      skips stale registrations itself.
    '';
  };

  stopBudget = {
    patch = ./patch-stop-budget.mjs;
    marker = "openclaw-nix-stop-budget-v1";
    since = "2026.9.4";
    fixes = ''
      Shutdown: a plain stop drained for up to upstream's full budget. Clamp only the
      stop path to a 120 s drain and 180 s hard exit; every restart keeps upstream's.
      (30 s / 90 s until 2026.10.4, which cut running agent turns at a stop.)
    '';
    test = ./test-stop-budget.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream bounds the stop drain (or makes it configurable).";
  };

  nodeBootstrapLayout = {
    patch = ./patch-node-bootstrap-layout.mjs;
    marker = "openclaw-nix-node-bootstrap-layout-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: the node bootstrap packer assumes the npm layout, so every
      environments.create failed on the Nix gateway ("Unsafe package dist path").
      Skip the plugin node_modules symlinks it already omits, and copy the launchers
      and scripts the packer selects from the pinned source.
    '';
    test = ./test-node-bootstrap-layout.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream's packer accepts a non-npm install layout.";
  };

  cloudWorkerGatewayUrl = {
    patch = ./patch-cloud-worker-gateway-url.mjs;
    marker = "openclaw-nix-cloud-worker-gateway-url-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: node enrollment reuses the phone-pairing URL, so a gateway that
      keeps pairing on a private network leaves workers unable to reach it. Give
      enrollment its own URL (OPENCLAW_CLOUD_WORKER_GATEWAY_URL), with the same
      validation.
    '';
    test = ./test-cloud-worker-gateway-url.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream configures the enrollment URL separately from pairing.";
  };

  skillTreeStoreHardlinks = {
    patch = ./patch-skill-tree-store-hardlinks.mjs;
    marker = "openclaw-nix-skill-tree-store-hardlinks-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: skill bundles refuse hardlinked files, and Nix store optimisation
      hardlinks every identical store file, so every worker turn failed. Allow hard
      links only under /nix/store (immutable, world-readable); symlinks stay refused.
    '';
    test = ./test-skill-tree-store-hardlinks.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream accepts hard links from an immutable store.";
  };

  skillDeliveryDescription = {
    patch = ./patch-skill-delivery-description.mjs;
    marker = "openclaw-nix-skill-delivery-description-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: one skill description over the protocol's 1024 characters failed
      the whole catalog, so no worker turn ran. Clamp each description when the
      delivery is built.
    '';
    test = ./test-skill-delivery-description.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream clamps or validates descriptions per skill.";
  };

  controlUiStoreHardlinks = {
    patch = ./patch-control-ui-store-hardlinks.mjs;
    marker = "openclaw-nix-control-ui-store-hardlinks-v1";
    since = "2026.10.2";
    fixes = ''
      Native Control UI: bundled plugins' browser builds (workboard, slack, discord)
      were refused as missing because store optimisation hardlinks them. Allow hard
      links only under /nix/store; symlinks stay refused.
    '';
    test = ./test-control-ui-store-hardlinks.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream accepts hard links from an immutable store.";
  };

  codexCyberAccessProgram = {
    patch = ./patch-codex-cyber-access-program.mjs;
    marker = "openclaw-nix-codex-cyber-access-program-v1";
    since = "2026.10.4";
    fixes = ''
      Codex: OpenAI retires the gpt-daybreak-blue-latest / -red-latest aliases on
      2026-10-28 and makes Daybreak a per-request choice, which OpenClaw never sends.
      turn/start now carries cyberAccessProgram "daybreakBlue" for the agents listed in
      OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS and for the cyber-failover retry; the failover
      default moves to gpt-6-sol, and a plain refusal on that model is retried once with
      Daybreak. Every other turn omits the field, as upstream does.
    '';
    test = ./test-codex-cyber-access-program.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream sends cyberAccessProgram itself and its failover default leaves the alias.";
  };

  agentDbPreparationRetry = {
    patch = ./patch-agent-db-preparation-retry.mjs;
    marker = "openclaw-nix-agent-db-preparation-retry-v1";
    since = "2026.10.4";
    fixes = ''
      Agent databases: a start that defers an agent's database to background
      inspection (after a stop that left worker leases behind, main's 1.28 GB database
      on nova prod) prepares it after startup and refuses to publish if the runtime
      config object or the secrets revision changes meanwhile. Upstream then leaves the
      agent degraded until a restart ("Agent main startup preparation was superseded",
      2026-10-18). The admission owner now retries a superseded preparation with the
      current configuration for up to 600 s while the Gateway owns it, and each
      supersession names its cause (config changed, secrets revision a -> b, or the
      Gateway closing, which is not retried).
    '';
    test = ./test-agent-db-preparation-retry.mjs;
    upstream = null;
    upstreamStatus = "fixed on main by openclaw/openclaw#171054 (2026-10-13; issue #171018); 2026.10.x stable diverged before it, so 2026.10.5 lacks it. Reported as #177587, closed 2026-10-20: ships in the next stable release.";
    removeWhen = "The release carries openclaw/openclaw#171054 (AgentDatabaseStartupSupersededError and its bounded retry); this patch's anchors then fail, and it is dropped.";
  };

  pluginRuntimeOwnerGeneration = {
    patch = ./patch-plugin-runtime-owner-generation.mjs;
    marker = "openclaw-nix-plugin-runtime-owner-generation-v1";
    since = "2026.10.5";
    fixes = ''
      Plugin hooks: the Gateway authenticates an in-process plugin owner and persists
      that authority on the session, but agent admission omitted the owner when it
      selected the run's prepared model-runtime generation. The generation therefore
      contained the model provider but not the initiating plugin's llm_input or
      llm_output hooks. Carry only that authenticated owner into the admitted run's
      prepared registry; generation isolation remains authoritative.
    '';
    test = ./test-plugin-runtime-owner-generation.mjs;
    upstream = "https://github.com/openclaw/openclaw/pull/177903";
    upstreamStatus = "open";
    removeWhen = "An OpenClaw release carries the authenticated runtime plugin owner into the run-prepared generation.";
  };

  missingPluginAutoInstall = {
    patch = ./patch-missing-plugin-auto-install.mjs;
    marker = "openclaw-nix-missing-plugin-auto-install-v1";
    since = "2026.10.5";
    fixes = ''
      Configured plugins: doctor's repair downloads (npm or ClawHub) every configured
      plugin, channel or provider plugin it cannot discover, and writes the package and
      an install record into the state directory, beside the plugins Nix provides (stray
      records broke merlin once). Every caller goes through the two candidate loops of
      missing-configured-plugin-install (and its two worker copies):
      - `openclaw doctor --fix`: config repair, plugin convergence before state
        migrations, and the release install backfill. The config overlay runs it, with
        OPENCLAW_NIX_MODE=0, on the first start of each new release;
      - `openclaw update`: post-core plugin convergence;
      - model selection: the codex/copilot runtime repair after `openclaw models set`, a
        provider login (CLI, or the Gateway's models.auth.login) or a promotion claim;
      - plain doctor, doctor lint and the triage after a failed Gateway start read the
        detection loop only. The Gateway's own startup preflight only verifies payloads.
      Upstream nix-openclaw skips the loops only with OPENCLAW_NIX_MODE=1; prod and merlin
      run with 0. Both loops now skip every candidate unless
      OPENCLAW_NIX_ALLOW_RUNTIME_PLUGIN_INSTALL=1. The repair warns "plugin <id> is
      configured but not provided by Nix; add it to the gateway's runtime plugins" and
      reports the plugin failed, as for a failed download, so doctor keeps its config
      entry; detection reports it as not provided by Nix instead of offering an install.
      Recorded installs (updateNpmInstalledPlugins) and `openclaw plugins install` are
      unchanged.
    '';
    test = ./test-missing-plugin-auto-install.mjs;
    upstream = null;
    upstreamStatus = "not reported: upstream intends these installs; nix-openclaw disables them only with OPENCLAW_NIX_MODE=1";
    removeWhen = "Upstream (or nix-openclaw) can turn configured-plugin auto-install off independently of Nix mode, or these gateways run with OPENCLAW_NIX_MODE=1.";
  };
}
