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
}
