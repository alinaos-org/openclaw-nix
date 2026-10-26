// Compaction (resolveEmbeddedCompactionTarget) and the pre-compaction memory flush
// (resolveMemoryFlushTiming) read only agents.defaults.compaction[.memoryFlush].model,
// with no per-agent override: AgentEntryBaseSchema has no compaction field at all, so
// an agent whose primary model is denylisted to a provider (for example an
// Abliteration-only agent that must never reach Anthropic/OpenAI/Google) still
// summarizes and flushes memory through the shared default model. Two call sites
// also drop the caller's agentId when they rebuild a fresh params object for a
// fallback/retry attempt, so even a config-level per-agent override would not have
// reached them:
//  - embedded-agent-runner's "compactPrepared" model-fallback retry path
//    (resolveEmbeddedCompactionTarget's second call site in compact-Cn8Yr-Sj.mjs and
//    its two worker-pool duplicates) omits agentId from the object it builds.
//  - the pre-compaction memory flush's own model resolution (prepareMemoryFlushAttempt
//    in memory-flush-prepare-Dd4LjrXk.mjs and its worker-pool duplicate) never passed
//    agentId to resolveMemoryFlushPlanForRun at all.
//
// This adds agents.entries.<id>.compaction.model and
// agents.entries.<id>.compaction.memoryFlush.model to AgentEntryBaseSchema (the same
// shape the existing defaults-level fields already use), and resolves them ahead of
// the shared default in resolveEmbeddedCompactionTarget and resolveMemoryFlushTiming,
// in every chunk that carries a copy of either function (the readable chunk and its
// worker-pool duplicates, which use the same esbuild short-name scheme in this
// release and so share identical anchors with the readable source). A locked model
// selection (modelSelectionLocked) is unaffected: resolveEmbeddedCompactionTarget
// already skips every override, default or per-agent, when locked.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
const atLeast = (version, minimum) => {
  const a = String(version).split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
};
assert(
  root && atLeast(version, "2026.10.7"),
  "agent-scoped-compaction-model hotfix requires a qualified stable release",
);

const MARKER = "openclaw-nix-agent-scoped-compaction-model-v1";
const dist = path.join(root, "dist");
const changes = [];

function replaceExact({ id, file, before, after, expectedCount = 1 }) {
  const target = path.join(dist, file);
  let source = fs.readFileSync(target, "utf8");
  const occurrences = source.split(before).length - 1;
  assert.equal(occurrences, expectedCount, `${id}: expected ${expectedCount} anchors in ${file}, found ${occurrences}`);
  source = source.replaceAll(before, after);
  fs.writeFileSync(target, source);
  changes.push({ id, file });
}

// --- Schema: agents.entries.<id>.compaction.model / .compaction.memoryFlush.model ---
replaceExact({
  id: "schema-agent-entry-compaction",
  file: "zod-schema.core-CTGi3UvT.mjs",
  before: `\tparams: record(string(), unknown()).optional(),\n\truntime: AgentRuntimeSchema\n});`,
  after: `\tparams: record(string(), unknown()).optional(),\n\tcompaction: strictObject({\n\t\tmodel: string().optional(),\n\t\tmemoryFlush: strictObject({ model: string().optional() }).optional()\n\t}).optional(), /* ${MARKER} */\n\truntime: AgentRuntimeSchema\n});`,
});

// --- resolveEmbeddedCompactionTarget: per-agent override ahead of the shared default ---
replaceExact({
  id: "compaction-target-readable",
  file: "context-engine-maintenance-DNdgNa58.mjs",
  before: `\tconst override = params.modelSelectionLocked ? void 0 : params.config?.agents?.defaults?.compaction?.model?.trim();`,
  after: `\tconst override = params.modelSelectionLocked ? void 0 : (params.agentId ? params.config?.agents?.entries?.[params.agentId]?.compaction?.model?.trim() : void 0) ?? params.config?.agents?.defaults?.compaction?.model?.trim(); /* ${MARKER} */`,
});
replaceExact({
  id: "compaction-target-sqlite-worker",
  file: "worker/sqlite-store.worker.mjs",
  before: `_n=Ot.modelSelectionLocked?void 0:Ot.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
  after: `_n=Ot.modelSelectionLocked?void 0:(Ot.agentId?Ot.config?.agents?.entries?.[Ot.agentId]?.compaction?.model?.trim():void 0)??Ot.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
});
replaceExact({
  id: "compaction-target-worker-chunk",
  file: "worker/worker-chunk-CewA2kek.mjs",
  before: `i=e.modelSelectionLocked?void 0:e.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
  after: `i=e.modelSelectionLocked?void 0:(e.agentId?e.config?.agents?.entries?.[e.agentId]?.compaction?.model?.trim():void 0)??e.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
});

// --- compactPrepared fallback/retry: carry agentId into its own resolveEmbeddedCompactionTarget call ---
replaceExact({
  id: "compaction-retry-readable",
  file: "compact-Cn8Yr-Sj.mjs",
  before: `\t\t\t\tconst resolvedCompactionTarget = resolveEmbeddedCompactionTarget({\n\t\t\t\t\tconfig: params.config,\n\t\t\t\t\tprovider: params.provider,\n\t\t\t\t\tmodelId: params.model,\n\t\t\t\t\tauthProfileId: params.authProfileId,\n\t\t\t\t\tmodelSelectionLocked: params.modelSelectionLocked,\n\t\t\t\t\tdefaultProvider: DEFAULT_PROVIDER,\n\t\t\t\t\tdefaultModel: DEFAULT_MODEL\n\t\t\t\t});`,
  after: `\t\t\t\tconst resolvedCompactionTarget = resolveEmbeddedCompactionTarget({\n\t\t\t\t\tconfig: params.config,\n\t\t\t\t\tagentId: params.agentId, /* ${MARKER} */\n\t\t\t\t\tprovider: params.provider,\n\t\t\t\t\tmodelId: params.model,\n\t\t\t\t\tauthProfileId: params.authProfileId,\n\t\t\t\t\tmodelSelectionLocked: params.modelSelectionLocked,\n\t\t\t\t\tdefaultProvider: DEFAULT_PROVIDER,\n\t\t\t\t\tdefaultModel: DEFAULT_MODEL\n\t\t\t\t});`,
});
replaceExact({
  id: "compaction-retry-sqlite-worker",
  file: "worker/sqlite-store.worker.mjs",
  before: `resolveEmbeddedCompactionTarget({config:pr.config,provider:pr.provider,modelId:pr.model,authProfileId:pr.authProfileId,modelSelectionLocked:pr.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
  after: `resolveEmbeddedCompactionTarget({config:pr.config,agentId:pr.agentId,/*${MARKER}*/provider:pr.provider,modelId:pr.model,authProfileId:pr.authProfileId,modelSelectionLocked:pr.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
});
replaceExact({
  id: "compaction-retry-worker-chunk",
  file: "worker/worker-chunk-CBzfKKNd.mjs",
  before: `Qt({config:s.config,provider:s.provider,modelId:s.model,authProfileId:s.authProfileId,modelSelectionLocked:s.modelSelectionLocked,defaultProvider:G,defaultModel:W})`,
  after: `Qt({config:s.config,agentId:s.agentId,/*${MARKER}*/provider:s.provider,modelId:s.model,authProfileId:s.authProfileId,modelSelectionLocked:s.modelSelectionLocked,defaultProvider:G,defaultModel:W})`,
});

// --- resolveMemoryFlushTiming: per-agent override ahead of the shared default ---
replaceExact({
  id: "memory-flush-timing-readable",
  file: "memory-flush-plan-C2Zwg3cn.mjs",
  before: `\tconst defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;\n\tif (defaults?.enabled === false) return null;`,
  after: `\tconst defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;\n\tconst agentOverride = params.agentId ? params.cfg?.agents?.entries?.[params.agentId]?.compaction?.memoryFlush : void 0; /* ${MARKER} */\n\tif ((agentOverride?.enabled ?? defaults?.enabled) === false) return null;`,
});
replaceExact({
  id: "memory-flush-timing-readable-model",
  file: "memory-flush-plan-C2Zwg3cn.mjs",
  before: `\tconst model = defaults?.model?.trim() || void 0;`,
  after: `\tconst model = agentOverride?.model?.trim() || defaults?.model?.trim() || void 0; /* ${MARKER} */`,
});
replaceExact({
  id: "memory-flush-timing-sqlite-worker",
  file: "worker/sqlite-store.worker.mjs",
  before: `function resolveMemoryFlushTiming(Ot){let Kt=Ot.cfg?.agents?.defaults?.compaction?.memoryFlush;if(Kt?.enabled===!1)return null;`,
  after: `function resolveMemoryFlushTiming(Ot){let Kt=Ot.cfg?.agents?.defaults?.compaction?.memoryFlush,qn=Ot.agentId?Ot.cfg?.agents?.entries?.[Ot.agentId]?.compaction?.memoryFlush:void 0;/*${MARKER}*/if((qn?.enabled??Kt?.enabled)===!1)return null;`,
});
replaceExact({
  id: "memory-flush-timing-sqlite-worker-model",
  file: "worker/sqlite-store.worker.mjs",
  before: `let Pn=Kt?.model?.trim()||void 0;return{softThresholdTokens:Zt,forceFlushTranscriptBytes:_n,reserveTokensFloor:Dn,...Pn?{model:Pn}:{}}}function isToolsMemoryFlushPlan(Ot){return Ot.persistenceToolNames!==void 0}`,
  after: `let Pn=qn?.model?.trim()||Kt?.model?.trim()||void 0;/*${MARKER}*/return{softThresholdTokens:Zt,forceFlushTranscriptBytes:_n,reserveTokensFloor:Dn,...Pn?{model:Pn}:{}}}function isToolsMemoryFlushPlan(Ot){return Ot.persistenceToolNames!==void 0}`,
});
replaceExact({
  id: "memory-flush-timing-worker-chunk",
  file: "worker/worker-chunk-CcAJ0oHc.mjs",
  before: `function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush;if(n?.enabled===!1)return null;`,
  after: `function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush,qo=e.agentId?e.cfg?.agents?.entries?.[e.agentId]?.compaction?.memoryFlush:void 0;/*${MARKER}*/if((qo?.enabled??n?.enabled)===!1)return null;`,
});
replaceExact({
  id: "memory-flush-timing-worker-chunk-model",
  file: "worker/worker-chunk-CcAJ0oHc.mjs",
  before: `let c=n?.model?.trim()||void 0;return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}`,
  after: `let c=qo?.model?.trim()||n?.model?.trim()||void 0;/*${MARKER}*/return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}`,
});

// --- prepareMemoryFlushAttempt: the only call site that actually consumes plan.model;
// thread agentId into its resolveMemoryFlushPlanForRun call so the per-agent override above
// is reachable. (Other resolveMemoryFlushPlanForRun callers only read timing/reserve
// fields, never .model, so they are left untouched.) ---
replaceExact({
  id: "memory-flush-prepare-call-readable",
  file: "memory-flush-prepare-Dd4LjrXk.mjs",
  before: `\tconst resolution = resolveMemoryFlushPlanForRun({\n\t\tcfg: params.cfg,\n\t\tnowMs: Date.now(),\n\t\tcontextWindowTokens: params.contextWindowTokens\n\t});`,
  after: `\tconst resolution = resolveMemoryFlushPlanForRun({\n\t\tcfg: params.cfg,\n\t\tagentId: params.followupRun.run.agentId, /* ${MARKER} */\n\t\tnowMs: Date.now(),\n\t\tcontextWindowTokens: params.contextWindowTokens\n\t});`,
});
replaceExact({
  id: "memory-flush-prepare-call-sqlite-worker",
  file: "worker/sqlite-store.worker.mjs",
  before: `let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;`,
  after: `let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,agentId:Ot.followupRun.run.agentId,/*${MARKER}*/nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;`,
});

fs.writeFileSync(
  path.join(root, ".agent-scoped-compaction-model-hotfix.json"),
  `${JSON.stringify({ id: MARKER, upstreamVersion: version, changes }, null, 2)}\n`,
);
console.log(
  `Agent-scoped compaction/memory-flush model override applied across ${new Set(changes.map((c) => c.file)).size} files`,
);
