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
      (30 s / 90 s until 2026.10.4, which cut running agent turns at a stop.) From
      2026.10.6 upstream bounds the stop drain itself (20 s, then cancellation and
      durable cleanup), so only the hard exit is clamped: upstream's is the whole
      native budget, about 325 s under a 6 min TimeoutStopSec.
    '';
    test = ./test-stop-budget.mjs;
    upstream = null;
    upstreamStatus = "drain bounded upstream from 2026.10.6 (openclaw/openclaw#171308); the hard exit is still the native budget; not reported";
    removeWhen = "Upstream bounds a stop's hard exit below the native budget (or makes it configurable).";
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
    marker = "openclaw-nix-control-ui-store-hardlinks-v2";
    since = "2026.10.2";
    fixes = ''
      Native Control UI: bundled plugins' browser builds (workboard, slack, discord)
      were refused as missing because store optimisation hardlinks them. Allow hard
      links only under /nix/store; symlinks stay refused.
      v2 (added with 2026.10.5; the code is unchanged since 2026.10.2): an explicit
      UI reload rereads the plugin's manifest with hard links refused, although
      discovery allows them for bundled plugins, so reloading a bundled panel failed
      ("Control UI assets could not be loaded"; workboard's manifest has 30 store
      links). The reload allows hard links for the same /nix/store roots only; a
      symlinked manifest is still refused.
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

  corpusRevisionReadOnly = {
    patch = ./patch-corpus-revision-read-only.mjs;
    marker = "openclaw-nix-corpus-revision-read-only-v1";
    since = "2026.10.5";
    fixes = ''
      Agent databases: memory's transcript corpus (the dreaming job, session backfill,
      memory forget) is read in the pooled session-history Workers, but each entry's
      content revision opened the agent database writable there
      (readTranscriptStatsSync). That lease stays in the Worker's handle cache until the
      process exits, and no stop releases it. On nova prod the 04:30 dreaming run left
      one on every agent database, so every later stop, however clean, ended
      `active-leases`, and the next start held all 16 agents for background inspection
      (92 s on 2026-10-22; main's boot run failed). The Worker inventory now projects
      read-only and its revisions come from readTranscriptStatsBatchReadOnlySync, which
      takes no lease; an unavailable transcript has no revision, as a failed read
      already had. Other callers keep the writable read. Checked in a lab copy of prod's
      state: `memory session-backfill` left one lease from a dead process before, none
      after, and all 13 of herald's revisions are identical on both readers.
    '';
    test = ./test-corpus-revision-read-only.mjs;
    upstream = null;
    upstreamStatus = "fixed on main by openclaw/openclaw#168631 (2026-10-13); 2026.10.x stable diverged before it, so 2026.10.5 and 2026.10.6 lack it. Not reported.";
    removeWhen = "The release carries openclaw/openclaw#168631 (readTranscriptContentRevisionSync's readOnly path); this patch's anchors then fail, and it is dropped.";
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

  mcpOAuthIssuerBinding = {
    patch = ./patch-mcp-oauth-issuer-binding.mjs;
    marker = "openclaw-nix-mcp-oauth-issuer-binding-v1";
    since = "2026.10.5";
    fixes = ''
      MCP OAuth (CVE-2026-104850, GHSA-6qxp-vccf-f47h): @modelcontextprotocol/sdk
      stamps the client information and tokens it saves with their authorization
      server (`issuer`) and discards a stamped value read back for another server, but
      still presents an unstamped one, saved by an earlier SDK, to whichever server
      discovery names. OpenClaw's provider (dist/mcp-oauth-*.mjs and its two worker
      copies) handed stored values to the SDK unchanged. Its clientInformation() and
      tokens() now read a value without an issuer as absent: a login registers again
      and stores stamped values (OpenClaw's store keeps the SDK's stamp), and a
      gateway refresh fails with "requires OAuth authorization. Run openclaw mcp login
      <server>" instead of registering in the background. A fresh access token still
      goes to its own MCP server until it expires. Servers whose credentials predate
      the stamp need `openclaw mcp logout <server>` and then `openclaw mcp login
      <server>` once (login alone returns early while the old access token is
      unexpired). On nova (2026-10-22) every prod MCP OAuth store is already stamped.
    '';
    test = ./test-mcp-oauth-issuer-binding.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "An openclaw/openclaw release whose MCP OAuth provider itself treats client information and tokens without an issuer as absent.";
  };

  agentScopedCompactionModel = {
    patch = ./patch-agent-scoped-compaction-model.mjs;
    marker = "openclaw-nix-agent-scoped-compaction-model-v1";
    since = "2026.10.7";
    fixes = ''
      Compaction and the pre-compaction memory flush read only
      agents.defaults.compaction[.memoryFlush].model; AgentEntryBaseSchema has no
      per-agent compaction field at all, so an agent whose primary model is denylisted
      to one provider (an Abliteration-only agent that must never reach
      Anthropic/OpenAI/Google) still summarizes and flushes memory through the shared
      default model. Two call sites also dropped the caller's agentId when they
      rebuilt a fresh params object for a retry: the embedded-agent-runner's
      model-fallback retry path (resolveEmbeddedCompactionTarget's second call site,
      compact-*.mjs and its two worker-pool duplicates) and the memory flush's own
      model resolution (prepareMemoryFlushAttempt, memory-flush-prepare-*.mjs and its
      two worker-pool duplicates, sqlite-store.worker.mjs and a
      worker/worker-chunk-*.mjs), so even a config-level override would not have
      reached them, and the one that did (sqlite-store.worker.mjs) used the run's bare
      possibly-undefined agentId instead of the resolveDefaultAgentId(cfg) fallback the
      rest of that same function already applies. resolveMemoryFlushPlanForRun's own
      final model line also let a tools-arm plugin plan's own model, or any file-arm
      plan at all, override every tier unconditionally, so the per-agent override and
      even the shared default could never reach a flush the file arm or a model-naming
      plugin owned.

      Adds agents.entries.<id>.compaction.model and
      agents.entries.<id>.compaction.memoryFlush.model (model only; the schema admits
      no per-agent .enabled) to AgentEntryBaseSchema -- both the shared chunk and the
      one config-doctor bundle that inlines its own full copy instead of importing it
      (feishu's) -- and resolves them ahead of the shared default in
      resolveEmbeddedCompactionTarget and resolveMemoryFlushTiming, and ahead of every
      tier (shared default and the resolution's own plan) in
      resolveMemoryFlushPlanForRun's final model line, in every chunk carrying a copy
      of any of the three; threads agentId, defaulted the same way the rest of each
      function already defaults it, into every retry/call site that dropped it,
      including the sqlite-store.worker.mjs and worker-chunk copies of
      prepareMemoryFlushAttempt. Every target is located by content, not by chunk
      filename, and must sit in exactly the expected chunks (2026.10.8 re-hashed all
      eleven with their code unchanged). A locked model selection is unaffected:
      resolveEmbeddedCompactionTarget already skips every override, default or
      per-agent, once modelSelectionLocked is set. Other agents' shared defaults, and
      every plugin-owned or file-arm model when no per-agent override is configured,
      are read exactly as before.
    '';
    test = ./test-agent-scoped-compaction-model.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream carries a native per-agent compaction/memory-flush model override through every resolution and retry path.";
  };

  # Not a patch: a check on the final tree, rerun after a plugin graft.
  mcpSdkFloor = {
    patch = null;
    marker = null;
    since = "2026.10.5";
    fixes = ''
      MCP OAuth (CVE-2026-104850, GHSA-6qxp-vccf-f47h): the build fails if any copy of
      @modelcontextprotocol/sdk in the final tree is older than 1.31.0, the line that
      binds saved OAuth client information and tokens to their authorization server and
      that mcpOAuthIssuerBinding relies on. A copy is any node_modules/@modelcontextprotocol/sdk
      package: the pnpm store, plugin node_modules under dist/extensions and
      dist-runtime/extensions, and grafted plugins, following module links out of the
      tree. 2026.10.5 ships 1.32.0 (2026.9.x shipped 1.30.0, without the binding).
      Bundled copies carry no version; the ones OpenClaw's provider calls are checked
      by test-mcp-oauth-issuer-binding.mjs.
    '';
    test = ./test-mcp-sdk-floor.mjs;
    upstream = null;
    upstreamStatus = "not applicable: a floor on a dependency, not an upstream bug";
    removeWhen = "OpenClaw's lockfile itself requires @modelcontextprotocol/sdk >= 1.31.0 for every package that depends on it; until then raise the floor for a later SDK advisory rather than drop it.";
  };

  claudeDeferredLoopbackTools = {
    patch = ./patch-claude-deferred-loopback-tools.mjs;
    marker = "openclaw-nix-claude-deferred-loopback-tools-v2";
    since = "2026.10.6";
    fixes = ''
      Claude CLI runs: the loopback MCP server that carries OpenClaw's tools is marked
      `alwaysLoad: true`, so Claude Code sends every tool's full schema on every turn
      instead of deferring it behind ToolSearch, as it does for other MCP servers. On
      nova that is 27-39 tools and 30-55K characters of schema per turn; a one-word
      canary on a Merlin lane wrote 78,534 prompt-cache tokens. For the agents listed in
      OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS the entry is built without `alwaysLoad`,
      so Claude Code's default tool search defers those tools; OpenClaw's Claude prompt
      already tells the model to load a deferred tool with ToolSearch first. From
      2026.10.7 ordinary Claude turns are mediated and start Claude with `--tools ""`,
      which removes ToolSearch, and Claude Code defers nothing without it (it also puts
      every configured MCP server's tools on this server); for the same agents a run
      with no native tools gets ToolSearch as its one native tool, in the run's own
      list so OpenClaw's permission hook allows it, and that ToolSearch skips the exec
      approval plan (a read-only or allowlist session would deny every search).
      Unset, the variable changes nothing. A trial switch, not a bug fix: it is here because the prepare step is
      the only place the entry and the run's tool list are built.
    '';
    test = ./test-claude-deferred-loopback-tools.mjs;
    upstream = null;
    upstreamStatus = "not reported: upstream's choice, not a bug";
    removeWhen = "Upstream makes the loopback server's alwaysLoad and the mediated runs' ToolSearch configurable (or defers by default), or the trial ends without adoption.";
  };
}
