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
#
# From 2026.11.5 upstream's build mangles local names in dist (tsdown keepNames,
# toplevel false), so an anchor on a local variable name holds only for one build:
# anchors match the code's shape, or carry a release-gated set of the minified names,
# and each must still occur exactly once. Entries name the dist/worker bundle copies
# of patched code that a patch leaves alone, where the port found them.
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

      From 2026.11.5 upstream loads isMcpRequestTimeoutError lazily in
      connectMcpClient's catch block. The verification points that one load (an
      import() of the mcp-error chunk, or the worker's inlined
      init_mcp_error()/mcp_error_exports) at a stub module, after checking that the
      load reaches a module exporting the helper. The Codex edit now awaits
      store.delete and refuses a second application.
    '';
    test = null;
    untested = ''
      The MCP part runs upstream's packaged connectMcpClient (main chunk and both
      worker copies) in a VM context, with the lazy mcp-error load stubbed from
      2026.11.5 on. It asserts that the close rejection is observed, the timeout check
      runs once and close is restored. The Codex stale-registration edit has no test.
    '';
    upstream = null;
    upstreamStatus = "not reported: the MCP part is fixed upstream since 2026.9.5; the Codex stale-registration part is still downstream";
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
      Shutdown: a plain stop's hard exit is upstream's whole native budget (about 325 s
      under a 6 min TimeoutStopSec). Clamp only the stop path's hard exit to 180 s;
      every restart keeps upstream's. Until 2026.10.6 this also clamped the drain
      (120 s; 30 s until 2026.10.4, which cut running agent turns at a stop). 10.6
      bounded the stop drain upstream (20 s), and 2026.11.5 removed the drain:
      shutdown aborts active work. From 11.5 the clamp sits in runAcceptedRequest's
      armForceExitTimer, which also bounds the cleanup deadline and the hard-exit
      watchdog. It applies to requests accepted as a stop; a SIGTERM that lands while
      a restart is already running finishes under the restart's own timer, as on
      2026.11.4. The receipt records stopDrainMs null, stopDrainOwner "none" and the
      clamped line.
    '';
    test = ./test-stop-budget.mjs;
    upstream = null;
    upstreamStatus = "drain bounded upstream from 2026.10.6 (openclaw/openclaw#171308) and removed in 2026.11.5 (stop aborts active work); the stop hard exit is still the native budget (armForceExitTimer(budget.timeoutMs)); not reported";
    removeWhen = "Upstream bounds a stop's hard exit below the native budget (or makes it configurable).";
  };

  nodeBootstrapLayout = {
    patch = ./patch-node-bootstrap-layout.mjs;
    marker = "openclaw-nix-node-bootstrap-layout-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: the node bootstrap packer assumes the npm layout, so every
      environments.create failed on the Nix gateway ("Unsafe package dist path").
      Skip the plugin node_modules symlinks it already omits. Copy the root runtime
      files it selects from the pinned source: through 2026.11.4, BOOTSTRAP_LAUNCHER_FILES
      and the scripts/ entries of package.json files; from 2026.11.5 on, every literal
      files entry under scripts/ or ending in .[cm]?[jt]s (53 files on 11.5).

      Not covered, as before: dist/worker/worker-chunk-*.mjs and
      sqlite-store.worker.mjs carry a minified copy of collectRelativeFiles that the
      node bootstrap path does not use (its build chunk imports package-dist-inventory).
    '';
    test = ./test-node-bootstrap-layout.mjs;
    upstream = null;
    upstreamStatus = "not reported; still needed on 2026.11.5 (a symlink is rejected before the omission check in collectRelativeFiles)";
    removeWhen = "Upstream's packer accepts a non-npm install layout, or the Nix gateway installs package.json files at the package root.";
  };

  cloudWorkerGatewayUrl = {
    patch = ./patch-cloud-worker-gateway-url.mjs;
    marker = "openclaw-nix-cloud-worker-gateway-url-v1";
    since = "2026.9.8";
    fixes = ''
      Cloud workers: node enrollment reuses the phone-pairing URL, so a gateway that
      keeps pairing on a private network leaves workers unable to reach it. Give
      enrollment its own URL (OPENCLAW_CLOUD_WORKER_GATEWAY_URL), with the same
      validation. From 2026.11.5 the anchors match the bundler's shortened local
      names.
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
      From 2026.11.5 on the bundle chunk ships minified locals; the patch selects the
      minified names by release and checks that each binds the same value (symlinks
      default, safe root, entries loop, rootReal) exactly once.

      Not covered, as before: the copies of readSkillBundleTree in
      dist/worker/worker-chunk-*.mjs and sqlite-store.worker.mjs.
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
      delivery is built. From 2026.11.5 upstream mangles local names in dist, so the
      anchors match the builder's shape with any identifiers there; each shape must
      still occur exactly once.

      Not covered, as before: the copies of prepareSkillResourceDelivery in
      dist/worker/worker-chunk-*.mjs and sqlite-store.worker.mjs (reached only with
      librarySelections, whose bundle imports already refuse long descriptions).
    '';
    test = ./test-skill-delivery-description.mjs;
    upstream = null;
    upstreamStatus = "not reported";
    removeWhen = "Upstream clamps or validates descriptions per skill.";
  };

  codexCyberAccessProgram = {
    patch = ./patch-codex-cyber-access-program.mjs;
    marker = "openclaw-nix-codex-cyber-access-program-v1";
    since = "2026.10.4";
    fixes = ''
      Codex: OpenAI retired the gpt-daybreak-blue-latest / -red-latest aliases on
      2026-10-28 and made Daybreak a per-request choice. Through 2026.11.4 OpenClaw
      never sends it: turn/start carries cyberAccessProgram "daybreakBlue" for the
      agents listed in OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS and for the cyber-failover
      retry, the failover default moves to gpt-6-sol, and a plain refusal on that
      model is retried once with Daybreak. From 2026.11.5 upstream sends
      cyberAccessProgram itself and its failover retries the same model with
      daybreak_blue, so only the per-agent default remains. A listed agent's Access
      resolves to daybreak_blue where it would be Standard; a session choice, the
      failover retry and an explicit daybreak_red setting still win. Upstream's own
      setting (params.accessPrograms on the model or agent) would move the turn off
      the Codex runtime, because any authored params entry is a request transport
      override that Codex declares it cannot reproduce.

      Known: on 2026.11.5 a listed agent's native-settings (supervision) turn, which
      has no runtime plan, also requests daybreak_blue; nothing on nova uses
      supervision bindings. 11.5 checks the program's entitlement before turn/start.
    '';
    test = ./test-codex-cyber-access-program.mjs;
    upstream = null;
    upstreamStatus = "not reported (worth reporting: hasAuthoredProviderRequestParams should exempt a valid accessPrograms value, as docs/providers/openai/models.md says native Codex accepts it)";
    removeWhen = ''
      Upstream lets params.accessPrograms.cyber on a Codex-runtime model keep the Codex
      harness (accessPrograms no longer counts as an authored request transport
      override); then set agents.entries.reverser.models."openai/gpt-6-sol".params.accessPrograms.cyber
      = "daybreak_blue" in alinaos and drop the env var.
    '';
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

      From 2026.11.5 the bundle renames every local binding, so the patch carries a
      second anchor set for the minified bindings, gated from 2026.11.5. The 11.5
      bundle also decides the configured-workspace fallback in three places
      (readPublishedModelRuntimeSnapshot, projectPublishedModelRuntimeOwner,
      projectNormalizedModelRuntimeOwner). 11.5's new borrowed-generation fast path
      goes through preparedPluginGenerationSupportsSelections and so needs the owner.
    '';
    test = ./test-plugin-runtime-owner-generation.mjs;
    upstream = "https://github.com/openclaw/openclaw/pull/177903";
    upstreamStatus = "open (2026-11-17); 2026.11.5 does not carry the owner";
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
      gateway refresh fails with `MCP server "<server>" requires OAuth authorization.
      <sign-in hint>` (before 2026.11.5: "... Run openclaw mcp login <server>")
      instead of registering in the background. A fresh access token still goes to
      its own MCP server until it expires. Servers whose credentials predate the stamp
      need `openclaw mcp logout <server>` and then `openclaw mcp login <server>` once
      (login alone returns early while the old access token is unexpired); both run
      only with the gateway stopped, so on a running gateway use the Control UI's
      Settings, MCP sign-in. On nova (2026-10-22) every prod MCP OAuth store is
      already stamped.

      From 2026.11.5 the provider calls @modelcontextprotocol/client 2.x auth()
      (SEP-2352). It also uses an unstamped value: it warns, stamps the value with the
      issuer it resolved (metadata.issuer, else the AS URL) and refreshes or registers
      with it. Upstream's new bindTokensIssuer mutation only binds OpenClaw's own
      tokensAuthorizationServerUrl, and only when discoveryState exists, so this
      hotfix is still needed. The 11.5 tokens() has a refreshClaim guard before its
      return, and the patch anchors past it.
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
      Compaction reads only agents.defaults.compaction.model
      (resolveEmbeddedCompactionTarget); there is no per-agent override. An agent
      whose primary model is denylisted to one provider (an Abliteration-only agent)
      therefore still summarizes through the shared default. The compactPrepared
      model-fallback retry (compact-*.mjs and its sqlite-store.worker.mjs and
      worker-chunk duplicates) also rebuilds its params without agentId.

      From 2026.11.5 on, the patch adds `model` to upstream's own strict per-agent
      compaction object, agents.entries.<id>.compaction {maxSummaryChars}, in the
      AgentEntryBaseSchema copies the gateway and doctor validate with: zod-schema.core,
      config-doctor/feishu.js and sqlite-store.worker.mjs. A fourth, fully minified
      copy in dist/worker/worker-chunk-*.mjs is not patched (2026.11.4's equivalent
      was not either; nova's paths do not validate the config with it). It adds no
      second key, so maxSummaryChars survives. It resolves the per-agent model ahead
      of the shared default in every resolveEmbeddedCompactionTarget copy and threads
      agentId into every retry copy. It does not touch the memory flush: 11.5 retired
      compaction.memoryFlush.model, flushes use the active session model, and no
      per-agent memoryFlush is admitted.

      From 2026.10.7 to 2026.11.4 the legacy anchor set also adds and resolves
      agents.entries.<id>.compaction.memoryFlush.model (resolveMemoryFlushTiming,
      resolveMemoryFlushPlanForRun's final model line, and prepareMemoryFlushAttempt's
      agentId).

      Targets are located by content and must sit in exactly the expected chunks. A
      locked model selection skips every override. The direct-once gate and ChatGPT
      V2 eligibility still read only the shared default. Known limit on 2026.11.5:
      buildAfterTurnRuntimeContext passes no agentId, so a context engine's afterTurn
      resolves the shared default (the built-in legacy engine has no afterTurn).
    '';
    test = ./test-agent-scoped-compaction-model.mjs;
    upstream = null;
    upstreamStatus = "not reported; 2026.11.5 added a per-agent compaction object (maxSummaryChars) but no per-agent model";
    removeWhen = "Upstream resolves a per-agent compaction model (agents.entries.<id>.compaction.model or equivalent) in resolveEmbeddedCompactionTarget and carries agentId through the compactPrepared retry.";
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
      It now also requires every @modelcontextprotocol/client copy to be 2.3.1 or
      later (the version qualified for 2026.11.5, whose MCP OAuth provider calls it),
      and fails if a package the tree's package.json depends on, sdk or client, has no
      copy, so a layout change is caught. 2026.11.5 ships client 2.3.1 and sdk 1.32.1.
      Bundled copies carry no version; the ones OpenClaw's provider calls are checked
      by test-mcp-oauth-issuer-binding.mjs.
    '';
    test = ./test-mcp-sdk-floor.mjs;
    upstream = null;
    upstreamStatus = "not applicable: a floor on a dependency, not an upstream bug";
    removeWhen = "OpenClaw's lockfile itself requires @modelcontextprotocol/sdk >= 1.31.0 and @modelcontextprotocol/client >= 2.3.1 for every package that depends on them; until then raise the floor for a later SDK advisory rather than drop it.";
  };

  spawnTargetOwnedMcp = {
    patch = ./patch-spawn-target-owned-mcp.mjs;
    marker = "openclaw-nix-spawn-target-owned-mcp-v1";
    since = "2026.10.8";
    fixes = ''
      sessions_spawn: a child inherits the requester's explicit deny list and, under a
      restrictive profile such as "coding", the concrete names of the requester's own
      tools, which never include MCP tools. A host that keeps an MCP server to one agent
      (codex.agents plus a `<server>__*` deny on every other agent) therefore gave a
      child of that agent none of it: on nova a DISSECT spawned by main had none of its
      88 REA tools, while sessions_send to DISSECT's own session had all of them. For a
      cross-agent spawn by the owner (not sender-restricted), servers the config scopes
      to the target and not to the requester follow the target agent: their
      `<server>__*` deny is not inherited and they join an inherited allowlist. The
      target agent's own tool policy still applies; everything else is inherited as
      before. Hidden children and visible sessions both.

      From 2026.11.5 upstream's build shortens local names and spawnSubagentDirect
      first applies a plugin subagent profile into a const ctx; the patch captures the
      shortened names, makes that binding a let, and never releases a server the
      profile denies. A rewritten hidden-spawn context keeps the parent's execution
      identity (upstream keys it on the context object), which the earlier object copy
      dropped. Not covered, as before: the copies of spawnSubagentDirect and
      maybeSpawnVisibleSession in dist/worker/ (a spawn from a turn on a cloud worker).
    '';
    test = ./test-spawn-target-owned-mcp.mjs;
    upstream = null;
    upstreamStatus = "not reported: upstream keeps a child within its requester by design. 2026.10.10 adds an operator grant, agents.entries.<id>.subagents.delegateToolsTo, that waives the requester's own tools.deny for named native targets, but only for deny-only requesters on a Gateway-native surface (an inherited allowlist refuses the spawn), and it waives the whole local deny, not only the target's MCP servers. 2026.11.5: still inherits ctx.inheritedToolAllowlist/Denylist unchanged (subagent-spawn.ts:247-249, 415-416)";
    removeWhen = "Upstream lets a cross-agent child keep the target agent's own scoped MCP servers (or the host moves to delegateToolsTo and its restrictions fit), or nova stops scoping MCP servers to single agents.";
  };
}
