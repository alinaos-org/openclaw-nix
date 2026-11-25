// Compaction (resolveEmbeddedCompactionTarget) reads only agents.defaults.compaction.model,
// with no per-agent override, so an agent whose primary model is denylisted to one provider
// (an Abliteration-only agent that must never reach Anthropic/OpenAI/Google) still
// summarizes through the shared default model. The embedded-agent-runner's
// "compactPrepared" model-fallback retry path (resolveEmbeddedCompactionTarget's second call
// site in compact-*.mjs, a worker chunk and, through 2026.11.9, sqlite-store.worker.mjs)
// also drops the caller's agentId when it rebuilds a fresh params object, so even a
// config-level per-agent override would not reach it.
//
// From release 2026.11.5 on, upstream carries its own strict per-agent compaction object,
// agents.entries.<id>.compaction = { maxSummaryChars }, and has retired
// compaction.memoryFlush.model outright (memory flushes now use the active session model;
// the doctor migration deletes agents.defaults.compaction.memoryFlush.model). This patch then
// adds `model` alongside maxSummaryChars in the AgentEntryBaseSchema copies in zod-schema.core
// and config-doctor/feishu.js and, through 2026.11.9, sqlite-store.worker.mjs. On 2026.11.10
// the worker pool's only schema copy is fully minified in dist/worker/worker-chunk-*.mjs.
// It stays unpatched, as did worker-chunk-vlAFN93o.mjs on 2026.11.9.
// The patch resolves the per-agent model ahead of the shared default in every copy of
// resolveEmbeddedCompactionTarget and threads agentId into every copy of the retry call.
// It no longer touches the memory flush: no per-agent memoryFlush field is admitted, so a
// config still carrying agents.entries.<id>.compaction.memoryFlush fails strict validation.
//
// Before 2026.11.5 (2026.10.7 through 2026.11.4) the legacy anchor set below also covers the
// pre-compaction memory flush, whose model upstream still read only from
// agents.defaults.compaction.memoryFlush.model:
//  - it adds agents.entries.<id>.compaction.memoryFlush.model to the schema, beside
//    compaction.model, and resolves it ahead of the shared default in
//    resolveMemoryFlushTiming, and ahead of every tier in resolveMemoryFlushPlanForRun's
//    final model line (which let a tools-arm plugin plan's own model, or any file-arm plan at
//    all, override every tier unconditionally);
//  - prepareMemoryFlushAttempt (memory-flush-prepare-*.mjs and its two worker-pool
//    duplicates, sqlite-store.worker.mjs and a worker/worker-chunk-*.mjs) never passed
//    agentId to resolveMemoryFlushPlanForRun at all; the rest of that same function already
//    defaults a missing agentId with resolveDefaultAgentId(cfg), so the call site now matches
//    it instead of using a bare possibly-undefined one.
//
// A locked model selection (modelSelectionLocked) is unaffected: resolveEmbeddedCompactionTarget
// already skips every override, default or per-agent, when locked. The direct-once gate in
// compactPrepared and ChatGPT V2 server-compaction eligibility still read only the shared
// default, exactly as before this patch.
//
// Targets are found by content, never by chunk filename: every release re-hashes the
// chunk names (2026.10.8 renamed all eleven files this touches while their code stayed
// byte-identical). One pass reads every regular .js/.mjs file under dist/ (symlinked
// node_modules are skipped), counts each anchor in each file, and requires the hits to
// land exactly in the expected places: `expect` maps a hash-agnostic location pattern
// (`*` matches within one path segment) to the anchor count it must carry. A target that
// vanished, moved to a differently named chunk, or gained an extra copy fails the build
// with the list of files it was actually found in.
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
const anchors = [];
const replaceExact = (anchor) => anchors.push(anchor);

const compact = atLeast(version, "2026.11.10");
if (atLeast(version, "2026.11.5")) {
  // --- Schema: extend upstream's own agents.entries.<id>.compaction strictObject with
  // `model`, so maxSummaryChars survives (a second `compaction` key would shadow it). ---
  replaceExact({
    id: "schema-agent-entry-compaction",
    // The shared chunk and the feishu config-doctor bundle carry the identical readable copy.
    expect: { "zod-schema.core-*.mjs": 1, "config-doctor/feishu.js": 1 },
    before: /maxSummaryChars:\s*AgentCompactionMaxSummaryCharsSchema\.optional\(\)\s*\}\)\.optional\(\),\s*params:\s*record\(string\(\),\s*unknown\(\)\)\.optional\(\),\s*runtime:\s*AgentRuntimeSchema\s*\}\);/g,
    after: (match) => match.replace("AgentCompactionMaxSummaryCharsSchema.optional()", `AgentCompactionMaxSummaryCharsSchema.optional(),\n\tmodel: string().optional() /* ${MARKER} */`),
  });
  // The 11.10 SQLite store worker no longer bundles the schema, target or retry.
  if (!compact) replaceExact({
    id: "schema-agent-entry-compaction-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `compaction:strictObject({maxSummaryChars:AgentCompactionMaxSummaryCharsSchema.optional()}).optional(),params:record(string$3(),unknown()).optional(),runtime:AgentRuntimeSchema})`,
    after: `compaction:strictObject({maxSummaryChars:AgentCompactionMaxSummaryCharsSchema.optional(),model:string$3().optional()/*${MARKER}*/}).optional(),params:record(string$3(),unknown()).optional(),runtime:AgentRuntimeSchema})`,
  });

  // --- resolveEmbeddedCompactionTarget: per-agent override ahead of the shared default.
  // 2026.11.5 mangles the readable chunk's locals too (params is `e`, the override `r`). ---
  replaceExact({
    id: "compaction-target-readable",
    expect: { "compaction-runtime-context-*.mjs": 1 },
    before: /const ([\w$]+)\s*=\s*([\w$]+)\.modelSelectionLocked\s*\?\s*void 0\s*:\s*\2\.config\?\.agents\?\.defaults\?\.compaction\?\.model\?\.trim\(\);/g,
    after: (_, result, p) => `const ${result} = ${p}.modelSelectionLocked ? void 0 : (${p}.agentId ? ${p}.config?.agents?.entries?.[${p}.agentId]?.compaction?.model?.trim() : void 0) ?? ${p}.config?.agents?.defaults?.compaction?.model?.trim(); /* ${MARKER} */`,
  });
  if (!compact) replaceExact({
    id: "compaction-target-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `Ye=N.modelSelectionLocked?void 0:N.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
    after: `Ye=N.modelSelectionLocked?void 0:(N.agentId?N.config?.agents?.entries?.[N.agentId]?.compaction?.model?.trim():void 0)??N.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
  });
  replaceExact({
    id: "compaction-target-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    ...(compact ? {
      before: /([\w$]+)=([\w$]+)\.modelSelectionLocked\?void 0:\2\.config\?\.agents\?\.defaults\?\.compaction\?\.model\?\.trim\(\),assembleTarget=/g,
      after: (_, result, p) => `${result}=${p}.modelSelectionLocked?void 0:(${p}.agentId?${p}.config?.agents?.entries?.[${p}.agentId]?.compaction?.model?.trim():void 0)??${p}.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
    } : {
      before: `i=e.modelSelectionLocked?void 0:e.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
      after: `i=e.modelSelectionLocked?void 0:(e.agentId?e.config?.agents?.entries?.[e.agentId]?.compaction?.model?.trim():void 0)??e.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
    }),
  });

  // --- compactPrepared fallback/retry: carry agentId into its own resolveEmbeddedCompactionTarget
  // call (params is `c` in the readable chunk and its worker-chunk duplicate, `_t` in
  // sqlite-store.worker.mjs). ---
  replaceExact({
    id: "compaction-retry-readable",
    expect: { "compact-*.mjs": 1 },
    before: /const ([\w$]+)\s*=\s*resolveEmbeddedCompactionTarget\(\{\s*config:\s*([\w$]+)\.config,\s*provider:\s*\2\.provider,\s*modelId:\s*\2\.model,\s*authProfileId:\s*\2\.authProfileId,\s*modelSelectionLocked:\s*\2\.modelSelectionLocked,\s*defaultProvider:\s*DEFAULT_PROVIDER,\s*defaultModel:\s*DEFAULT_MODEL\s*\}\);/g,
    after: (match, _, p) => match.replace(`${p}.config,`, () => `${p}.config,agentId:${p}.agentId,/*${MARKER}*/`),
  });
  if (!compact) replaceExact({
    id: "compaction-retry-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `resolveEmbeddedCompactionTarget({config:_t.config,provider:_t.provider,modelId:_t.model,authProfileId:_t.authProfileId,modelSelectionLocked:_t.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
    after: `resolveEmbeddedCompactionTarget({config:_t.config,agentId:_t.agentId,/*${MARKER}*/provider:_t.provider,modelId:_t.model,authProfileId:_t.authProfileId,modelSelectionLocked:_t.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
  });
  // The retry imports resolveEmbeddedCompactionTarget (export o) and the defaults
  // (exports i/n) under release-specific aliases. Check the bindings in the calling
  // chunk as well as the call. The test verifies their exporters and the default values.
  const retry = compact
    ? { target: "Sn", provider: "K", model: "ie" }
    : atLeast(version, "2026.11.7")
    ? { target: "Qn", provider: "U", model: "W" }
    : atLeast(version, "2026.11.6")
    ? { target: "pn", provider: "R", model: "z" }
    : { target: "pn", provider: "z", model: "B" };
  replaceExact({
    id: "compaction-retry-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    alsoRequires: [`o as ${retry.target},`, `i as ${retry.provider},n as ${retry.model},`],
    before: new RegExp(String.raw`\b${retry.target}\(\{config:([\w$]+)\.config,provider:\1\.provider,modelId:\1\.model,authProfileId:\1\.authProfileId,modelSelectionLocked:\1\.modelSelectionLocked,defaultProvider:${retry.provider},defaultModel:${retry.model}\}\)`, "g"),
    after: (match, p) => match.replace(`${p}.config,`, () => `${p}.config,agentId:${p}.agentId,/*${MARKER}*/`),
  });
} else {
  // ===== Legacy anchor set: 2026.10.7 through 2026.11.4 (compaction and memory flush) =====
  // --- Schema: agents.entries.<id>.compaction.model / .compaction.memoryFlush.model ---
  replaceExact({
    id: "schema-agent-entry-compaction",
    // The shared chunk and the feishu config-doctor bundle carry the identical readable copy.
    expect: { "zod-schema.core-*.mjs": 1, "config-doctor/feishu.js": 1 },
    before: `\tparams: record(string(), unknown()).optional(),\n\truntime: AgentRuntimeSchema\n});`,
    after: `\tparams: record(string(), unknown()).optional(),\n\tcompaction: strictObject({\n\t\tmodel: string().optional(),\n\t\tmemoryFlush: strictObject({ model: string().optional() }).optional()\n\t}).optional(), /* ${MARKER} */\n\truntime: AgentRuntimeSchema\n});`,
  });

  // --- resolveEmbeddedCompactionTarget: per-agent override ahead of the shared default ---
  replaceExact({
    id: "compaction-target-readable",
    expect: { "context-engine-maintenance-*.mjs": 1 },
    before: `\tconst override = params.modelSelectionLocked ? void 0 : params.config?.agents?.defaults?.compaction?.model?.trim();`,
    after: `\tconst override = params.modelSelectionLocked ? void 0 : (params.agentId ? params.config?.agents?.entries?.[params.agentId]?.compaction?.model?.trim() : void 0) ?? params.config?.agents?.defaults?.compaction?.model?.trim(); /* ${MARKER} */`,
  });
  replaceExact({
    id: "compaction-target-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `_n=Ot.modelSelectionLocked?void 0:Ot.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
    after: `_n=Ot.modelSelectionLocked?void 0:(Ot.agentId?Ot.config?.agents?.entries?.[Ot.agentId]?.compaction?.model?.trim():void 0)??Ot.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
  });
  replaceExact({
    id: "compaction-target-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `i=e.modelSelectionLocked?void 0:e.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=`,
    after: `i=e.modelSelectionLocked?void 0:(e.agentId?e.config?.agents?.entries?.[e.agentId]?.compaction?.model?.trim():void 0)??e.config?.agents?.defaults?.compaction?.model?.trim(),/*${MARKER}*/assembleTarget=`,
  });

  // --- compactPrepared fallback/retry: carry agentId into its own resolveEmbeddedCompactionTarget call ---
  replaceExact({
    id: "compaction-retry-readable",
    expect: { "compact-*.mjs": 1 },
    before: `\t\t\t\tconst resolvedCompactionTarget = resolveEmbeddedCompactionTarget({\n\t\t\t\t\tconfig: params.config,\n\t\t\t\t\tprovider: params.provider,\n\t\t\t\t\tmodelId: params.model,\n\t\t\t\t\tauthProfileId: params.authProfileId,\n\t\t\t\t\tmodelSelectionLocked: params.modelSelectionLocked,\n\t\t\t\t\tdefaultProvider: DEFAULT_PROVIDER,\n\t\t\t\t\tdefaultModel: DEFAULT_MODEL\n\t\t\t\t});`,
    after: `\t\t\t\tconst resolvedCompactionTarget = resolveEmbeddedCompactionTarget({\n\t\t\t\t\tconfig: params.config,\n\t\t\t\t\tagentId: params.agentId, /* ${MARKER} */\n\t\t\t\t\tprovider: params.provider,\n\t\t\t\t\tmodelId: params.model,\n\t\t\t\t\tauthProfileId: params.authProfileId,\n\t\t\t\t\tmodelSelectionLocked: params.modelSelectionLocked,\n\t\t\t\t\tdefaultProvider: DEFAULT_PROVIDER,\n\t\t\t\t\tdefaultModel: DEFAULT_MODEL\n\t\t\t\t});`,
  });
  replaceExact({
    id: "compaction-retry-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `resolveEmbeddedCompactionTarget({config:pr.config,provider:pr.provider,modelId:pr.model,authProfileId:pr.authProfileId,modelSelectionLocked:pr.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
    after: `resolveEmbeddedCompactionTarget({config:pr.config,agentId:pr.agentId,/*${MARKER}*/provider:pr.provider,modelId:pr.model,authProfileId:pr.authProfileId,modelSelectionLocked:pr.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1})`,
  });
  // The worker chunks' minified import aliases change between releases. 2026.10.10 calls
  // resolveEmbeddedCompactionTarget as Zt (was Qt), DEFAULT_PROVIDER/DEFAULT_MODEL as de/ue
  // (were G/W, the same exports of the same chunk), resolveMemoryFlushPlanForRun as j (was
  // k) and resolveDefaultAgentId as o (was a); each checked against its chunk's exports.
  // 2026.11.3 imports DEFAULT_PROVIDER as le (was de); DEFAULT_MODEL stays ue
  // (worker-chunk-*.mjs: `import{i as le,n as ue,o as de}`, where i is `openai`).
  const minified = atLeast(version, "2026.11.3")
    ? { target: "Zt", provider: "le", model: "ue", plan: "j", defaultAgent: "o", followup: "a" }
    : atLeast(version, "2026.10.10")
    ? { target: "Zt", provider: "de", model: "ue", plan: "j", defaultAgent: "o", followup: "a" }
    : { target: "Qt", provider: "G", model: "W", plan: "k", defaultAgent: "a", followup: "o" };
  replaceExact({
    id: "compaction-retry-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `${minified.target}({config:s.config,provider:s.provider,modelId:s.model,authProfileId:s.authProfileId,modelSelectionLocked:s.modelSelectionLocked,defaultProvider:${minified.provider},defaultModel:${minified.model}})`,
    after: `${minified.target}({config:s.config,agentId:s.agentId,/*${MARKER}*/provider:s.provider,modelId:s.model,authProfileId:s.authProfileId,modelSelectionLocked:s.modelSelectionLocked,defaultProvider:${minified.provider},defaultModel:${minified.model}})`,
  });

  // --- resolveMemoryFlushTiming: per-agent override ahead of the shared default. The schema
  // below only admits agents.entries.<id>.compaction.memoryFlush.model (no .enabled), so this
  // reads the per-agent entry for its model only; the enabled fence stays default-only, exactly
  // as before any per-agent entry exists. ---
  replaceExact({
    id: "memory-flush-timing-readable",
    expect: { "memory-flush-plan-*.mjs": 1 },
    before: `\tconst defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;\n\tif (defaults?.enabled === false) return null;`,
    after: `\tconst defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;\n\tconst agentOverride = params.agentId ? params.cfg?.agents?.entries?.[params.agentId]?.compaction?.memoryFlush : void 0; /* ${MARKER} */\n\tif (defaults?.enabled === false) return null;`,
  });
  replaceExact({
    id: "memory-flush-timing-readable-model",
    expect: { "memory-flush-plan-*.mjs": 1 },
    before: `\tconst model = defaults?.model?.trim() || void 0;`,
    after: `\tconst model = agentOverride?.model?.trim() || defaults?.model?.trim() || void 0; /* ${MARKER} */`,
  });
  replaceExact({
    id: "memory-flush-timing-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `function resolveMemoryFlushTiming(Ot){let Kt=Ot.cfg?.agents?.defaults?.compaction?.memoryFlush;if(Kt?.enabled===!1)return null;`,
    after: `function resolveMemoryFlushTiming(Ot){let Kt=Ot.cfg?.agents?.defaults?.compaction?.memoryFlush,qn=Ot.agentId?Ot.cfg?.agents?.entries?.[Ot.agentId]?.compaction?.memoryFlush:void 0;/*${MARKER}*/if(Kt?.enabled===!1)return null;`,
  });
  replaceExact({
    id: "memory-flush-timing-sqlite-worker-model",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `let Pn=Kt?.model?.trim()||void 0;return{softThresholdTokens:Zt,forceFlushTranscriptBytes:_n,reserveTokensFloor:Dn,...Pn?{model:Pn}:{}}}function isToolsMemoryFlushPlan(Ot){return Ot.persistenceToolNames!==void 0}`,
    after: `let Pn=qn?.model?.trim()||Kt?.model?.trim()||void 0;/*${MARKER}*/return{softThresholdTokens:Zt,forceFlushTranscriptBytes:_n,reserveTokensFloor:Dn,...Pn?{model:Pn}:{}}}function isToolsMemoryFlushPlan(Ot){return Ot.persistenceToolNames!==void 0}`,
  });
  replaceExact({
    id: "memory-flush-timing-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush;if(n?.enabled===!1)return null;`,
    after: `function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush,qo=e.agentId?e.cfg?.agents?.entries?.[e.agentId]?.compaction?.memoryFlush:void 0;/*${MARKER}*/if(n?.enabled===!1)return null;`,
  });

  // --- resolveMemoryFlushPlanForRun's own final model line: the per-agent override must beat
  // BOTH the tools-arm plugin plan's own model and the file-arm plan, which previously ignored
  // timing (and so the agent override) unconditionally. No agent override present keeps the
  // exact prior per-arm precedence (plugin plan wins on the tools arm; the file arm never
  // consulted timing at all). ---
  replaceExact({
    id: "memory-flush-plan-final-override-readable",
    expect: { "memory-flush-plan-*.mjs": 1 },
    before: `function resolveMemoryFlushPlanForRun(params) {\n\tconst timing = resolveMemoryFlushTiming(params);\n\tif (!timing) return null;`,
    after: `function resolveMemoryFlushPlanForRun(params) {\n\tconst timing = resolveMemoryFlushTiming(params);\n\tif (!timing) return null;\n\tconst agentOverrideModel = params.agentId ? params.cfg?.agents?.entries?.[params.agentId]?.compaction?.memoryFlush?.model?.trim() || void 0 : void 0; /* ${MARKER} */`,
  });
  replaceExact({
    id: "memory-flush-plan-final-model-readable",
    expect: { "memory-flush-plan-*.mjs": 1 },
    before: `\t\t\tmodel: isToolsMemoryFlushPlan(resolution.plan) ? resolution.plan.model ?? timing.model : resolution.plan.model`,
    after: `\t\t\tmodel: agentOverrideModel ?? (isToolsMemoryFlushPlan(resolution.plan) ? resolution.plan.model ?? timing.model : resolution.plan.model) /* ${MARKER} */`,
  });
  replaceExact({
    id: "memory-flush-plan-final-override-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `if(!Zt)return null;if(isToolsMemoryFlushPlan(Zt.plan)){`,
    after: `if(!Zt)return null;let agentOverrideModel=Ot.agentId?Ot.cfg?.agents?.entries?.[Ot.agentId]?.compaction?.memoryFlush?.model?.trim()||void 0:void 0;/*${MARKER}*/if(isToolsMemoryFlushPlan(Zt.plan)){`,
  });
  replaceExact({
    id: "memory-flush-plan-final-model-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `model:isToolsMemoryFlushPlan(Zt.plan)?Zt.plan.model??Kt.model:Zt.plan.model}}}function memoryFlushResultIsSilent`,
    after: `model:agentOverrideModel??(isToolsMemoryFlushPlan(Zt.plan)?Zt.plan.model??Kt.model:Zt.plan.model)}}}function memoryFlushResultIsSilent`,
  });
  replaceExact({
    id: "memory-flush-plan-final-override-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `if(!n)return null;if(isToolsMemoryFlushPlan(n.plan)){`,
    after: `if(!n)return null;let agentOverrideModel=e.agentId?e.cfg?.agents?.entries?.[e.agentId]?.compaction?.memoryFlush?.model?.trim()||void 0:void 0;/*${MARKER}*/if(isToolsMemoryFlushPlan(n.plan)){`,
  });
  replaceExact({
    id: "memory-flush-plan-final-model-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `model:isToolsMemoryFlushPlan(n.plan)?n.plan.model??t.model:n.plan.model}}}function memoryFlushResultIsSilent`,
    after: `model:agentOverrideModel??(isToolsMemoryFlushPlan(n.plan)?n.plan.model??t.model:n.plan.model)}}}function memoryFlushResultIsSilent`,
  });

  // --- The inlined AgentEntryBaseSchema copies the first schema edit above missed: the
  // sqlite-store.worker.mjs bundle inlines the whole schema instead of importing it, and the
  // feishu config-doctor bundle (the one config-doctor bundle that carries its own full copy
  // instead of importing the shared chunk) does too. Both must admit the same per-agent field
  // or a config using it fails strictObject validation in the worker and in that doctor. ---
  replaceExact({
    id: "schema-agent-entry-compaction-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `params:record$2(string$3(),unknown()).optional(),runtime:AgentRuntimeSchema})`,
    after: `params:record$2(string$3(),unknown()).optional(),compaction:strictObject({model:string$3().optional(),memoryFlush:strictObject({model:string$3().optional()}).optional()}).optional(),/*${MARKER}*/runtime:AgentRuntimeSchema})`,
  });
  replaceExact({
    id: "memory-flush-timing-worker-chunk-model",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    before: `let c=n?.model?.trim()||void 0;return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}`,
    after: `let c=qo?.model?.trim()||n?.model?.trim()||void 0;/*${MARKER}*/return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}`,
  });

  // --- prepareMemoryFlushAttempt: the only call site that actually consumes plan.model;
  // thread agentId into its resolveMemoryFlushPlanForRun call so the per-agent override above
  // is reachable. (Other resolveMemoryFlushPlanForRun callers only read timing/reserve
  // fields, never .model, so they are left untouched.) ---
  // The real call sites default a missing agentId with resolveDefaultAgentId(cfg) (used just
  // below this call for the rest of the attempt); the per-agent override lookup must see that
  // same default, not a bare possibly-undefined run.agentId, or an agent whose run omits an
  // explicit agentId never reaches its own override. ---
  replaceExact({
    id: "memory-flush-prepare-call-readable",
    expect: { "memory-flush-prepare-*.mjs": 1 },
    before: `\tconst resolution = resolveMemoryFlushPlanForRun({\n\t\tcfg: params.cfg,\n\t\tnowMs: Date.now(),\n\t\tcontextWindowTokens: params.contextWindowTokens\n\t});`,
    after: `\tconst resolution = resolveMemoryFlushPlanForRun({\n\t\tcfg: params.cfg,\n\t\tagentId: params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg), /* ${MARKER} */\n\t\tnowMs: Date.now(),\n\t\tcontextWindowTokens: params.contextWindowTokens\n\t});`,
  });
  replaceExact({
    id: "memory-flush-prepare-call-sqlite-worker",
    expect: { "worker/sqlite-store.worker.mjs": 1 },
    before: `let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;`,
    after: `let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,agentId:Ot.followupRun.run.agentId??resolveDefaultAgentId(Ot.cfg),/*${MARKER}*/nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;`,
  });
  // A worker/worker-chunk-*.mjs is a third worker-pool duplicate of prepareMemoryFlushAttempt
  // (sqlite-store.worker.mjs's own copy is patched above); its call never passed agentId at
  // all, so the per-agent override above was unreachable through this path. `a` is this
  // chunk's import alias for resolveDefaultAgentId, used the same way just below in the same
  // function once `o` (followupRun) is destructured from `e`; `alsoRequires` holds that use
  // to the same file so a re-minified alias fails here instead of calling the wrong import. ---
  replaceExact({
    id: "memory-flush-prepare-call-worker-chunk",
    expect: { "worker/worker-chunk-*.mjs": 1 },
    alsoRequires: [`let{sessionKey:r,sessionEntry:i,followupRun:${minified.followup}}=e;`, `let s=${minified.followup}.run.agentId??${minified.defaultAgent}(e.cfg),`],
    before: `let t=${minified.plan}({cfg:e.cfg,nowMs:Date.now(),contextWindowTokens:e.contextWindowTokens});if(!t)return null;`,
    after: `let t=${minified.plan}({cfg:e.cfg,agentId:e.followupRun.run.agentId??${minified.defaultAgent}(e.cfg),/*${MARKER}*/nowMs:Date.now(),contextWindowTokens:e.contextWindowTokens});if(!t)return null;`,
  });
}

// --- Locate every anchor by content in one pass over dist/, then apply in order. ---
const candidates = [];
(function walk(dir) {
  // Sorted, so the receipt lists files in the same order on every filesystem.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) candidates.push(full);
  }
})(dist);
const count = (text, needle) => needle instanceof RegExp ? [...text.matchAll(needle)].length : text.split(needle).length - 1;
const globToRegExp = (glob) =>
  new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
const hits = new Map(anchors.map((anchor) => [anchor.id, []]));
const sources = new Map();
for (const file of candidates) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(dist, file).split(path.sep).join("/");
  assert(!text.includes(MARKER), `agent-scoped-compaction-model hotfix already applied (${rel} carries ${MARKER})`);
  if (compact && rel === "worker/sqlite-store.worker.mjs") {
    assert(!/resolveEmbeddedCompactionTarget|AgentEntryBaseSchema|AgentCompactionMaxSummaryCharsSchema|function compactPrepared\(/.test(text),
      "SQLite store worker bundles compaction code again");
    assert(!/compaction:[\w$]+\(\{maxSummaryChars:[\w$]+\.optional\(\)\}\)\.optional\(\),params:/.test(text),
      "SQLite store worker bundles the minified per-agent compaction schema again");
  }
  let matched = false;
  for (const anchor of anchors) {
    const n = count(text, anchor.before);
    if (n) {
      hits.get(anchor.id).push({ rel, n });
      matched = true;
    }
  }
  if (matched) sources.set(rel, text);
}
for (const anchor of anchors) {
  const found = hits.get(anchor.id);
  const where = found.map(({ rel, n }) => `${rel} (${n})`).join(", ") || "nowhere";
  const patterns = Object.entries(anchor.expect).map(([glob, n]) => ({ glob, n, re: globToRegExp(glob), seen: 0 }));
  for (const { rel, n } of found) {
    const owners = patterns.filter(({ re }) => re.test(rel));
    assert.equal(owners.length, 1, `${anchor.id}: anchor found in unexpected file ${rel}; found in ${where}`);
    owners[0].seen += n;
  }
  for (const { glob, n, seen } of patterns) {
    assert.equal(seen, n, `${anchor.id}: expected ${n} anchor(s) in ${glob}, found ${seen}; found in ${where}`);
  }
  for (const { rel } of found) {
    for (const needed of anchor.alsoRequires ?? []) {
      assert.equal(count(sources.get(rel), needed), 1, `${anchor.id}: ${rel} no longer carries ${needed}`);
    }
  }
}
for (const anchor of anchors) {
  for (const { rel, n } of hits.get(anchor.id)) {
    const text = sources.get(rel);
    assert.equal(count(text, anchor.before), n, `${anchor.id}: an earlier edit changed the anchor in ${rel}`);
    sources.set(rel, text.replaceAll(anchor.before, anchor.after));
    changes.push({ id: anchor.id, file: rel });
  }
}
for (const rel of new Set(changes.map((c) => c.file))) fs.writeFileSync(path.join(dist, rel), sources.get(rel));

fs.writeFileSync(
  path.join(root, ".agent-scoped-compaction-model-hotfix.json"),
  `${JSON.stringify({ id: MARKER, upstreamVersion: version, changes }, null, 2)}\n`,
);
console.log(
  `Agent-scoped ${atLeast(version, "2026.11.5") ? "compaction" : "compaction/memory-flush"} model override applied across ${new Set(changes.map((c) => c.file)).size} files`,
);
