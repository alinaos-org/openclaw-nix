# Post-build fixes for bugs upstream has not fixed yet, applied to a copy of the
# built gateway tree. A real copy (not symlinks) keeps worker-relative imports
# and bundled-plugin trust boundaries intact; the copy is self-contained
# (../copy-layer.nix).
#
# Each patch-*.mjs checks the exact code it replaces, found exactly once, and a
# matching test-*.mjs exercises the result; a release that moves or fixes that
# code fails the build there. Then drop the patch (upstream fixed it) or
# re-port its anchors (upstream moved it).
{
  lib,
  stdenvNoCC,
  gateway,
  # Bump when the patch set changes for the same gateway.
  revision ? "hotfix.8",
}: let
  # A correction release (2026.7.1-2) is its base release's code, so the patches'
  # release gates read the base.
  upstreamVersion = lib.head (lib.splitString "-" gateway.passthru.upstreamVersion);
  # The gateway's own Node, which the patched tree runs on.
  node = "${gateway.passthru.node}/bin/node";
  root = "$out/lib/openclaw";
  # This test invokes its sibling patcher; retain their directory in the store
  # for both the initial build and downstream plugin-graft rechecks.
  agentScopedCompactionTest = "${./.}/${baseNameOf ./test-agent-scoped-compaction-model.mjs}";
  copyLayer = import ../copy-layer.nix {inherit lib;};
in
  assert lib.assertMsg (lib.versionAtLeast upstreamVersion "2026.10.1")
  "openclaw-nix hotfixes are qualified from 2026.10.1 (got ${upstreamVersion})";
    stdenvNoCC.mkDerivation {
      pname = "openclaw-gateway";
      version = "${gateway.version}-${revision}";
      dontUnpack = true;
      phases = ["installPhase"];
      # The finished tree leads to no tree it was copied from.
      disallowedRequisites = copyLayer.pathsOf (copyLayer.treesOf gateway);
      installPhase = ''
        ${copyLayer.copyTree gateway}

        # MCP: observe close() rejections so a failed transport close cannot
        # surface as an unhandled rejection and stop the gateway.
        ${node} ${./patch-mcp-close-rejection.mjs} "${root}" "${upstreamVersion}"

        # Shutdown: bound the non-restart stop drain and force-exit timer.
        ${node} ${./patch-stop-budget.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-stop-budget.mjs} "${root}"

        # Cloud workers: make the Nix layout packable as the node bootstrap,
        # give node enrollment its own gateway URL
        # (OPENCLAW_CLOUD_WORKER_GATEWAY_URL), allow Nix-store hard links in
        # shipped skill trees, and clamp skill descriptions to the worker
        # protocol's 1024-character limit.
        ${node} ${./patch-node-bootstrap-layout.mjs} "${root}" "${gateway.passthru.upstreamSource}" "${upstreamVersion}"
        ${node} ${./patch-cloud-worker-gateway-url.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-cloud-worker-gateway-url.mjs} "${root}"
        ${node} ${./patch-skill-tree-store-hardlinks.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-skill-tree-store-hardlinks.mjs} "${root}"
        ${node} ${./patch-skill-delivery-description.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-skill-delivery-description.mjs} "${root}"
        ${node} ${./test-node-bootstrap-layout.mjs} "${root}"

        # Codex: request Daybreak Blue per turn (cyberAccessProgram) for the agents in
        # OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS and for the cyber-failover retry, whose
        # default moves off the retiring gpt-daybreak-blue-latest alias to gpt-6-sol.
        ${node} ${./patch-codex-cyber-access-program.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-codex-cyber-access-program.mjs} "${root}"

        # Native Control UI: serve and reload bundled plugins' browser builds
        # although Nix store optimisation hard-links their files and manifests.
        ${node} ${./patch-control-ui-store-hardlinks.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-control-ui-store-hardlinks.mjs} "${root}"

        # Agent databases: retry a deferred agent's preparation that a runtime
        # config or secrets republish superseded, instead of leaving the agent
        # degraded until a restart, and name which republish it was.
        ${node} ${./patch-agent-db-preparation-retry.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-agent-db-preparation-retry.mjs} "${root}"

        # Agent databases: memory's transcript corpus (dreaming, backfill) reads each
        # entry's content revision read-only in the history Workers, instead of a
        # writable open whose lease outlives every stop.
        ${node} ${./patch-corpus-revision-read-only.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-corpus-revision-read-only.mjs} "${root}"

        # Plugin-owned runs: carry the authenticated initiating plugin into the
        # run's prepared generation without widening generation-scoped hooks.
        ${node} ${./patch-plugin-runtime-owner-generation.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-plugin-runtime-owner-generation.mjs} "${root}"

        # Claude CLI runs: for the agents in OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS,
        # build the loopback MCP server entry without alwaysLoad and (from 2026.10.7)
        # keep Claude Code's ToolSearch in the run's native tools, so Claude Code
        # defers their OpenClaw tools behind it.
        ${node} ${./patch-claude-deferred-loopback-tools.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-claude-deferred-loopback-tools.mjs} "${root}"

        # Configured plugins: never download a configured plugin that Nix does not
        # provide (doctor --fix, update, model selection); report it instead.
        # OPENCLAW_NIX_ALLOW_RUNTIME_PLUGIN_INSTALL=1 restores upstream's installs.
        ${node} ${./patch-missing-plugin-auto-install.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-missing-plugin-auto-install.mjs} "${root}"

        # MCP OAuth: a saved client or token set without the authorization
        # server's issuer stamp reads as absent (CVE-2026-104850), so it is never
        # presented to an authorization server the SDK cannot bind it to.
        ${node} ${./patch-mcp-oauth-issuer-binding.mjs} "${root}" "${upstreamVersion}"
        ${node} ${./test-mcp-oauth-issuer-binding.mjs} "${root}"
        # Every @modelcontextprotocol/sdk copy has that binding (1.31.0 or later).
        ${node} ${./test-mcp-sdk-floor.mjs} "${root}"

        # Compaction and the pre-compaction memory flush: resolve
        # agents.entries.<id>.compaction[.memoryFlush].model ahead of the shared
        # agents.defaults override, and carry agentId into the two retry/call sites
        # that used to drop it when rebuilding their own params object.
        ${node} ${./patch-agent-scoped-compaction-model.mjs} "${root}" "${upstreamVersion}"
        ${node} ${agentScopedCompactionTest} "${root}"
      '';
      passthru =
        (gateway.passthru or {})
        // {
          hotfixes = {
            mcpCloseRejection = "openclaw-mcp-observe-close-rejection-v1";
            stopBudget = "openclaw-nix-stop-budget-v1";
            nodeBootstrapLayout = "openclaw-nix-node-bootstrap-layout-v1";
            cloudWorkerGatewayUrl = "openclaw-nix-cloud-worker-gateway-url-v1";
            skillTreeStoreHardlinks = "openclaw-nix-skill-tree-store-hardlinks-v1";
            skillDeliveryDescription = "openclaw-nix-skill-delivery-description-v1";
            controlUiStoreHardlinks = "openclaw-nix-control-ui-store-hardlinks-v2";
            codexCyberAccessProgram = "openclaw-nix-codex-cyber-access-program-v1";
            agentDbPreparationRetry = "openclaw-nix-agent-db-preparation-retry-v1";
            corpusRevisionReadOnly = "openclaw-nix-corpus-revision-read-only-v1";
            pluginRuntimeOwnerGeneration = "openclaw-nix-plugin-runtime-owner-generation-v1";
            missingPluginAutoInstall = "openclaw-nix-missing-plugin-auto-install-v1";
            mcpOAuthIssuerBinding = "openclaw-nix-mcp-oauth-issuer-binding-v1";
            claudeDeferredLoopbackTools = "openclaw-nix-claude-deferred-loopback-tools-v2";
            agentScopedCompactionModel = "openclaw-nix-agent-scoped-compaction-model-v1";
          };
          # Layers that change dist/extensions afterwards (a plugin graft)
          # rerun these on their final tree.
          hotfixTests = {
            nodeBootstrapLayout = ./test-node-bootstrap-layout.mjs;
            cloudWorkerGatewayUrl = ./test-cloud-worker-gateway-url.mjs;
            skillTreeStoreHardlinks = ./test-skill-tree-store-hardlinks.mjs;
            skillDeliveryDescription = ./test-skill-delivery-description.mjs;
            controlUiStoreHardlinks = ./test-control-ui-store-hardlinks.mjs;
            codexCyberAccessProgram = ./test-codex-cyber-access-program.mjs;
            agentDbPreparationRetry = ./test-agent-db-preparation-retry.mjs;
            corpusRevisionReadOnly = ./test-corpus-revision-read-only.mjs;
            pluginRuntimeOwnerGeneration = ./test-plugin-runtime-owner-generation.mjs;
            missingPluginAutoInstall = ./test-missing-plugin-auto-install.mjs;
            mcpOAuthIssuerBinding = ./test-mcp-oauth-issuer-binding.mjs;
            mcpSdkFloor = ./test-mcp-sdk-floor.mjs;
            claudeDeferredLoopbackTools = ./test-claude-deferred-loopback-tools.mjs;
            agentScopedCompactionModel = agentScopedCompactionTest;
          };
          # What each patch fixes, its test, upstream status and removal condition.
          hotfixRegister = import ./register.nix;
          unpatchedGateway = gateway;
          # A later layer that changes the tree (a plugin graft) can extend this
          # copy instead of making another one.
          copyLayerOf = gateway;
        };
      meta = gateway.meta or {};
    }
