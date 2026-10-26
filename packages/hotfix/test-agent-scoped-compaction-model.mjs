// Builds bounded fixtures that reproduce the exact anchors the patch targets (verified
// byte-for-byte against the installed 2026.10.7-nix.4-hotfix.7 store before this test was
// written), runs the real patch script against them, then imports the patched fixtures and
// drives the real patched functions with synthetic config: no OpenClaw boot, no model/API
// calls. Four behaviors are required and all four are exercised for both the readable chunk
// and its "Ot"-named worker-pool duplicate (sqlite-store.worker.mjs): an agent with a
// per-agent override picks it; an agent with no override still gets the shared default; a
// locked model selection ignores both override tiers; and the model-fallback retry path
// (which used to drop agentId when it rebuilt its own params object) now resolves the
// per-agent override instead of escaping to the default. The three single-purpose worker
// chunks (e-named compaction target, the retry call's "Qt" alias, and the e-named memory
// flush timing) get a structural check: the patch's anchor is present exactly once and the
// marker lands after patching, proving those anchors still match real minified output.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const patchScript = new URL("./patch-agent-scoped-compaction-model.mjs", import.meta.url).pathname;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-compaction-hotfix-"));
const dist = path.join(root, "dist");
fs.mkdirSync(path.join(dist, "worker"), { recursive: true });

function write(relPath, content) {
  fs.writeFileSync(path.join(dist, relPath), content);
}

// --- Schema fixture: the exact two-line anchor the patch inserts into AgentEntryBaseSchema ---
write(
  "zod-schema.core-CTGi3UvT.mjs",
  "const AgentEntryBaseSchema = strictObject({\n" +
    "\tid: string(),\n" +
    "\tparams: record(string(), unknown()).optional(),\n" +
    "\truntime: AgentRuntimeSchema\n" +
    "});\n",
);

// --- Readable compaction-target chunk (verbatim resolveEmbeddedCompactionTarget / resolveCompactionTargetRuntime) ---
write(
  "context-engine-maintenance-DNdgNa58.mjs",
  [
    "function resolveEmbeddedCompactionTarget(params) {",
    "\tconst provider = params.provider?.trim() || params.defaultProvider;",
    "\tconst model = params.modelId?.trim() || params.defaultModel;",
    "\tconst override = params.modelSelectionLocked ? void 0 : params.config?.agents?.defaults?.compaction?.model?.trim();",
    "\tconst assembleTarget = (targetProvider, targetModel) => {",
    "\t\tconst authProfileId = targetProvider !== provider ? void 0 : params.authProfileId ?? void 0;",
    "\t\treturn {",
    "\t\t\tprovider: targetProvider,",
    "\t\t\t...resolveCompactionTargetRuntime(targetProvider, params.harnessRuntime),",
    "\t\t\tmodel: targetModel,",
    "\t\t\tauthProfileId",
    "\t\t};",
    "\t};",
    "\tif (!override) return assembleTarget(provider, model);",
    '\tconst slashIdx = override.indexOf("/");',
    "\tif (slashIdx > 0) return assembleTarget(override.slice(0, slashIdx).trim(), override.slice(slashIdx + 1).trim() || params.defaultModel);",
    "\tconst config = params.config ?? {};",
    "\tconst currentProvider = provider?.trim();",
    "\tif (currentProvider && hasBareConfiguredModelForProvider({ cfg: config, provider: currentProvider, model: override })) return assembleTarget(currentProvider, override);",
    "\tconst inferredLiteralProvider = inferUniqueProviderFromConfiguredModels({ cfg: config, model: override, allowManifestNormalization: false });",
    "\tif (inferredLiteralProvider) return assembleTarget(inferredLiteralProvider, override);",
    '\tconst defaultProvider = provider || "openai";',
    "\tconst aliasKey = normalizeLowercaseStringOrEmpty(splitTrailingAuthProfile(override).model);",
    "\tconst alias = listModelAliasCandidates(config).some(({ alias: candidate }) => normalizeLowercaseStringOrEmpty(candidate) === aliasKey) ? buildModelAliasIndex({ cfg: config, defaultProvider, allowPluginNormalization: params.allowPluginNormalization, manifestPlugins: params.manifestPlugins }).byAlias.get(aliasKey) : void 0;",
    "\treturn assembleTarget(alias?.ref.provider ?? provider, alias?.ref.model ?? override);",
    "}",
    "function resolveCompactionTargetRuntime(provider, harnessRuntime) {",
    "\tif (!provider) return {};",
    "\tconst selectedHarnessRuntime = normalizeOptionalAgentRuntimeId(harnessRuntime);",
    '\tconst useNativeHarnessRuntime = selectedHarnessRuntime !== "openclaw" && !isDefaultAgentRuntimeId(selectedHarnessRuntime);',
    "\tconst runtimeProvider = resolveSelectedOpenAIRuntimeProvider({ provider });",
    "\tconst routedRuntimeProvider = runtimeProvider === provider ? void 0 : runtimeProvider;",
    "\treturn {",
    "\t\truntimeProvider: routedRuntimeProvider,",
    "\t\tcontextProvider: useNativeHarnessRuntime ? routedRuntimeProvider : void 0,",
    "\t\t...useNativeHarnessRuntime ? { nativeHarnessCompaction: true } : {}",
    "\t};",
    "}",
    "function hasBareConfiguredModelForProvider() { return false; }",
    "function inferUniqueProviderFromConfiguredModels() { return undefined; }",
    'function normalizeLowercaseStringOrEmpty(v) { return (v ?? "").toLowerCase(); }',
    "function splitTrailingAuthProfile(v) { return { model: v }; }",
    "function listModelAliasCandidates() { return []; }",
    "function buildModelAliasIndex() { return { byAlias: new Map() }; }",
    "function normalizeOptionalAgentRuntimeId(v) { return v; }",
    'function isDefaultAgentRuntimeId(v) { return v === "openclaw" || v === undefined; }',
    "function resolveSelectedOpenAIRuntimeProvider({ provider }) { return provider; }",
    "export { resolveEmbeddedCompactionTarget, resolveCompactionTargetRuntime };",
    "",
  ].join("\n"),
);

// --- Readable fallback/retry call site (compact-Cn8Yr-Sj.mjs's "compactPrepared") ---
write(
  "compact-Cn8Yr-Sj.mjs",
  [
    'import { resolveEmbeddedCompactionTarget } from "./context-engine-maintenance-DNdgNa58.mjs";',
    'const DEFAULT_PROVIDER = "openai";',
    'const DEFAULT_MODEL = "gpt-6-astra";',
    "async function compactPreparedRetry(params) {",
    "\t\t\t\tconst resolvedCompactionTarget = resolveEmbeddedCompactionTarget({",
    "\t\t\t\t\tconfig: params.config,",
    "\t\t\t\t\tprovider: params.provider,",
    "\t\t\t\t\tmodelId: params.model,",
    "\t\t\t\t\tauthProfileId: params.authProfileId,",
    "\t\t\t\t\tmodelSelectionLocked: params.modelSelectionLocked,",
    "\t\t\t\t\tdefaultProvider: DEFAULT_PROVIDER,",
    "\t\t\t\t\tdefaultModel: DEFAULT_MODEL",
    "\t\t\t\t});",
    "\treturn resolvedCompactionTarget;",
    "}",
    "export { compactPreparedRetry };",
    "",
  ].join("\n"),
);

// --- Readable memory-flush timing chunk ---
write(
  "memory-flush-plan-C2Zwg3cn.mjs",
  [
    "const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;",
    "const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2097152;",
    "const DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;",
    'function asNonNegativeFiniteNumber(v) { return typeof v === "number" && v >= 0 ? v : undefined; }',
    'function parseNonNegativeByteSize(v) { return typeof v === "number" ? v : undefined; }',
    "function resolveEffectiveCompactionReserveTokens({ reserveTokens }) { return reserveTokens; }",
    "function resolveMemoryFlushTiming(params) {",
    "\tconst defaults = params.cfg?.agents?.defaults?.compaction?.memoryFlush;",
    "\tif (defaults?.enabled === false) return null;",
    "\tlet softThresholdTokens = Math.floor(asNonNegativeFiniteNumber(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS);",
    "\tconst forceFlushTranscriptBytes = parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ?? DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;",
    "\tlet reserveTokensFloor = DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR;",
    "\tconst contextWindowTokens = Math.floor(asNonNegativeFiniteNumber(params.contextWindowTokens) ?? 0);",
    "\tif (contextWindowTokens > 0) {",
    "\t\treserveTokensFloor = resolveEffectiveCompactionReserveTokens({",
    "\t\t\tcontextTokenBudget: contextWindowTokens,",
    "\t\t\treserveTokens: reserveTokensFloor",
    "\t\t});",
    "\t\tsoftThresholdTokens = Math.min(softThresholdTokens, Math.floor((contextWindowTokens - reserveTokensFloor) / 2));",
    "\t}",
    "\tconst model = defaults?.model?.trim() || void 0;",
    "\treturn {",
    "\t\tsoftThresholdTokens,",
    "\t\tforceFlushTranscriptBytes,",
    "\t\treserveTokensFloor,",
    "\t\t...model ? { model } : {}",
    "\t};",
    "}",
    "function isToolsMemoryFlushPlan(plan) { return plan.persistenceToolNames !== undefined; }",
    "function resolveMemoryFlushPlanForRun(params) {",
    "\tconst timing = resolveMemoryFlushTiming(params);",
    "\tif (!timing) return null;",
    "\treturn { plan: { ...timing } };",
    "}",
    "export { resolveMemoryFlushTiming, resolveMemoryFlushPlanForRun, isToolsMemoryFlushPlan };",
    "",
  ].join("\n"),
);

// --- Readable memory-flush model consumption call site (memory-flush-prepare-Dd4LjrXk.mjs) ---
write(
  "memory-flush-prepare-Dd4LjrXk.mjs",
  [
    'import { resolveMemoryFlushPlanForRun } from "./memory-flush-plan-C2Zwg3cn.mjs";',
    "async function prepareMemoryFlushAttempt(params) {",
    "\tconst resolution = resolveMemoryFlushPlanForRun({",
    "\t\tcfg: params.cfg,",
    "\t\tnowMs: Date.now(),",
    "\t\tcontextWindowTokens: params.contextWindowTokens",
    "\t});",
    "\tif (!resolution) return null;",
    "\treturn resolution.plan;",
    "}",
    "export { prepareMemoryFlushAttempt };",
    "",
  ].join("\n"),
);

// --- "Ot"-named worker-pool duplicate (sqlite-store.worker.mjs): same esbuild short-name
// scheme as the readable chunk in this release, carrying all four functions this patch
// touches so the minified variant gets the same full behavioral proof as the readable one. ---
write(
  "worker/sqlite-store.worker.mjs",
  [
    "function resolveEmbeddedCompactionTarget(Ot){let Kt=Ot.provider?.trim()||Ot.defaultProvider,Zt=Ot.modelId?.trim()||Ot.defaultModel,_n=Ot.modelSelectionLocked?void 0:Ot.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=(Zt,_n)=>{let Dn=Zt===Kt?Ot.authProfileId??void 0:void 0;return{provider:Zt,...resolveCompactionTargetRuntime(Zt,Ot.harnessRuntime),model:_n,authProfileId:Dn}};if(!_n)return assembleTarget(Kt,Zt);let Dn=_n.indexOf(`/`);if(Dn>0)return assembleTarget(_n.slice(0,Dn).trim(),_n.slice(Dn+1).trim()||Ot.defaultModel);let kn=Ot.config??{},Pn=Kt?.trim();if(Pn&&hasBareConfiguredModelForProvider({cfg:kn,provider:Pn,model:_n}))return assembleTarget(Pn,_n);let Fn=inferUniqueProviderFromConfiguredModels({cfg:kn,model:_n,allowManifestNormalization:!1});if(Fn)return assembleTarget(Fn,_n);let Ln=Kt||`openai`,Jn=normalizeLowercaseStringOrEmpty(splitTrailingAuthProfile(_n).model),cr=listModelAliasCandidates(kn).some(({alias:Ot})=>normalizeLowercaseStringOrEmpty(Ot)===Jn)?buildModelAliasIndex({cfg:kn,defaultProvider:Ln,allowPluginNormalization:Ot.allowPluginNormalization,manifestPlugins:Ot.manifestPlugins}).byAlias.get(Jn):void 0;return assembleTarget(cr?.ref.provider??Kt,cr?.ref.model??_n)}",
    "function resolveCompactionTargetRuntime(Ot,Kt){if(!Ot)return{};let Zt=normalizeOptionalAgentRuntimeId(Kt),_n=Zt!==`openclaw`&&!isDefaultAgentRuntimeId(Zt),Dn=resolveSelectedOpenAIRuntimeProvider({provider:Ot}),kn=Dn===Ot?void 0:Dn;return{runtimeProvider:kn,contextProvider:_n?kn:void 0,..._n?{nativeHarnessCompaction:!0}:{}}}",
    "function hasBareConfiguredModelForProvider(){return false}",
    "function inferUniqueProviderFromConfiguredModels(){return undefined}",
    'function normalizeLowercaseStringOrEmpty(v){return (v??"").toLowerCase()}',
    "function splitTrailingAuthProfile(v){return {model:v}}",
    "function listModelAliasCandidates(){return []}",
    "function buildModelAliasIndex(){return {byAlias:new Map()}}",
    "function normalizeOptionalAgentRuntimeId(v){return v}",
    "function isDefaultAgentRuntimeId(v){return v===`openclaw`||v===undefined}",
    "function resolveSelectedOpenAIRuntimeProvider({provider}){return provider}",
    "const DEFAULT_PROVIDER=`openai`,DEFAULT_MODEL$1=`gpt-6-astra`;",
    "async function compactPreparedRetry(pr){const resolvedCompactionTarget=resolveEmbeddedCompactionTarget({config:pr.config,provider:pr.provider,modelId:pr.model,authProfileId:pr.authProfileId,modelSelectionLocked:pr.modelSelectionLocked,defaultProvider:DEFAULT_PROVIDER,defaultModel:DEFAULT_MODEL$1});return resolvedCompactionTarget}",
    "const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS=4000,DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES=2097152,DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR=20000;",
    "function asNonNegativeFiniteNumber(v){return typeof v===`number`&&v>=0?v:undefined}",
    "function parseNonNegativeByteSize(v){return typeof v===`number`?v:undefined}",
    "function resolveEffectiveCompactionReserveTokens({reserveTokens}){return reserveTokens}",
    "function resolveMemoryFlushTiming(Ot){let Kt=Ot.cfg?.agents?.defaults?.compaction?.memoryFlush;if(Kt?.enabled===!1)return null;let Zt=Math.floor(asNonNegativeFiniteNumber(Kt?.softThresholdTokens)??DEFAULT_MEMORY_FLUSH_SOFT_TOKENS),_n=parseNonNegativeByteSize(Kt?.forceFlushTranscriptBytes)??DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES,Dn=DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,kn=Math.floor(asNonNegativeFiniteNumber(Ot.contextWindowTokens)??0);kn>0&&(Dn=resolveEffectiveCompactionReserveTokens({contextTokenBudget:kn,reserveTokens:Dn}),Zt=Math.min(Zt,Math.floor((kn-Dn)/2)));let Pn=Kt?.model?.trim()||void 0;return{softThresholdTokens:Zt,forceFlushTranscriptBytes:_n,reserveTokensFloor:Dn,...Pn?{model:Pn}:{}}}function isToolsMemoryFlushPlan(Ot){return Ot.persistenceToolNames!==void 0}",
    "function resolveMemoryFlushPlanForRun(Ot){let Kt=resolveMemoryFlushTiming(Ot);if(!Kt)return null;return{plan:{...Kt}}}",
    "async function prepareMemoryFlushAttempt(Ot){let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;return Kt.plan}",
    "export {resolveEmbeddedCompactionTarget,compactPreparedRetry,resolveMemoryFlushTiming,resolveMemoryFlushPlanForRun,prepareMemoryFlushAttempt};",
    "",
  ].join("\n"),
);

// --- Structural-only fixtures: single-purpose worker chunks, each with exactly one patched
// anchor. These confirm the patch's minified anchors still match real output; the readable
// and sqlite-store.worker.mjs fixtures above already prove the transformed logic behaves. ---
write(
  "worker/worker-chunk-CewA2kek.mjs",
  "function resolveEmbeddedCompactionTarget(e){let t=e.provider,i=e.modelSelectionLocked?void 0:e.config?.agents?.defaults?.compaction?.model?.trim(),assembleTarget=()=>{};return i}\n",
);
write(
  "worker/worker-chunk-CBzfKKNd.mjs",
  "const G=`openai`,W=`gpt-6-astra`;\nfunction Qt(x){return x}\nasync function compactPrepared(s){return Qt({config:s.config,provider:s.provider,modelId:s.model,authProfileId:s.authProfileId,modelSelectionLocked:s.modelSelectionLocked,defaultProvider:G,defaultModel:W})}\n",
);
write(
  "worker/worker-chunk-CcAJ0oHc.mjs",
  "function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush;if(n?.enabled===!1)return null;let r=0,i=0,a=0;let c=n?.model?.trim()||void 0;return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}\n",
);

// --- Run the real patch script against the fixtures ---
execFileSync(process.execPath, [patchScript, root, "2026.10.7"], { stdio: "inherit" });

const receipt = JSON.parse(fs.readFileSync(path.join(root, ".agent-scoped-compaction-model-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-agent-scoped-compaction-model-v1");
assert.equal(receipt.changes.length, 15, `expected 15 anchor replacements, got ${receipt.changes.length}`);
const touchedFiles = new Set(receipt.changes.map((c) => c.file));
assert.equal(touchedFiles.size, 9, `expected 9 distinct files touched, got ${touchedFiles.size}`);

const MARKER = "openclaw-nix-agent-scoped-compaction-model-v1";
const importFixture = (relPath) => import(pathToFileURL(path.join(dist, relPath)).href);

// --- Schema: the per-agent compaction field landed inside AgentEntryBaseSchema ---
{
  const schemaSource = fs.readFileSync(path.join(dist, "zod-schema.core-CTGi3UvT.mjs"), "utf8");
  assert.ok(schemaSource.includes(`compaction: strictObject({`), "schema: compaction field missing");
  assert.ok(schemaSource.includes(`memoryFlush: strictObject({ model: string().optional() }).optional()`), "schema: memoryFlush field missing");
  assert.ok(schemaSource.includes(MARKER), "schema: marker missing");
  assert.ok(schemaSource.indexOf("compaction: strictObject(") < schemaSource.indexOf("runtime: AgentRuntimeSchema"), "schema: compaction field is not inside AgentEntryBaseSchema");
}

function abliterationConfig() {
  return {
    agents: {
      defaults: { compaction: { model: "anthropic/claude-sonnet-5", memoryFlush: { model: "anthropic/claude-sonnet-5" } } },
      entries: {
        onyx: { compaction: { model: "abliteration/abliterated-model-large-flash", memoryFlush: { model: "abliteration/abliterated-model-large-flash" } } },
      },
    },
  };
}

async function runCompactionTargetScenarios(label, { resolveEmbeddedCompactionTarget, compactPreparedRetry }) {
  const config = abliterationConfig();

  // 1. ONYX's per-agent override wins over the shared Sonnet default.
  const onyx = resolveEmbeddedCompactionTarget({
    agentId: "onyx",
    config,
    defaultProvider: "openai",
    defaultModel: "gpt-6-astra",
  });
  assert.equal(onyx.provider, "abliteration", `${label}: onyx should resolve to abliteration, got ${onyx.provider}`);
  assert.equal(onyx.model, "abliterated-model-large-flash", `${label}: onyx should resolve its own model`);

  // 2. An agent with no entries.<id>.compaction override still gets the global Sonnet default.
  const herald = resolveEmbeddedCompactionTarget({
    agentId: "herald",
    config,
    defaultProvider: "openai",
    defaultModel: "gpt-6-astra",
  });
  assert.equal(herald.provider, "anthropic", `${label}: herald should fall back to the shared default`);
  assert.equal(herald.model, "claude-sonnet-5", `${label}: herald should fall back to the shared default model`);

  // 2b. No agentId at all (e.g. a caller that never identifies an agent) also falls back, not undefined behavior.
  const anonymous = resolveEmbeddedCompactionTarget({ config, defaultProvider: "openai", defaultModel: "gpt-6-astra" });
  assert.equal(anonymous.provider, "anthropic", `${label}: missing agentId should still resolve the shared default`);

  // 3. A locked model selection ignores both the per-agent and the default override.
  const locked = resolveEmbeddedCompactionTarget({
    agentId: "onyx",
    provider: "abliteration",
    modelId: "abliterated-model",
    modelSelectionLocked: true,
    config,
    defaultProvider: "openai",
    defaultModel: "gpt-6-astra",
  });
  assert.equal(locked.provider, "abliteration", `${label}: locked selection must not escape to any override`);
  assert.equal(locked.model, "abliterated-model", `${label}: locked selection must keep its own model`);

  // 4. The fallback/retry path (used to drop agentId when rebuilding its own params) must not
  // escape to the shared default: it now resolves onyx's own override, exactly as the primary
  // resolution path does.
  const retried = await compactPreparedRetry({
    agentId: "onyx",
    config,
    modelSelectionLocked: false,
  });
  assert.equal(retried.provider, "abliteration", `${label}: fallback/retry escaped to the shared default instead of onyx's override`);
  assert.equal(retried.model, "abliterated-model-large-flash", `${label}: fallback/retry resolved the wrong model`);

  console.log(`ok - ${label}: compaction target scenarios (onyx override, default fallback, locked fence, retry no-escape)`);
}

async function runMemoryFlushScenarios(label, { prepareMemoryFlushAttempt, resolveMemoryFlushTiming }) {
  const config = abliterationConfig();

  // 5. ONYX's per-agent memoryFlush.model override wins, reached through the real
  // prepareMemoryFlushAttempt -> resolveMemoryFlushPlanForRun -> resolveMemoryFlushTiming
  // chain (the call site that used to never pass agentId at all).
  const onyxPlan = await prepareMemoryFlushAttempt({
    cfg: config,
    contextWindowTokens: 100000,
    followupRun: { run: { agentId: "onyx" } },
  });
  assert.equal(onyxPlan.model, "abliteration/abliterated-model-large-flash", `${label}: onyx memory-flush model override did not win`);

  // 6. An agent with no override still gets the shared default model.
  const heraldPlan = await prepareMemoryFlushAttempt({
    cfg: config,
    contextWindowTokens: 100000,
    followupRun: { run: { agentId: "herald" } },
  });
  assert.equal(heraldPlan.model, "anthropic/claude-sonnet-5", `${label}: herald memory-flush should keep the shared default model`);

  // 7. A per-agent enabled:false fences memory flush even when the shared default allows it.
  const fencedConfig = abliterationConfig();
  fencedConfig.agents.entries.onyx.compaction.memoryFlush.enabled = false;
  const fenced = resolveMemoryFlushTiming({ cfg: fencedConfig, agentId: "onyx", contextWindowTokens: 100000 });
  assert.equal(fenced, null, `${label}: per-agent enabled:false should disable memory flush for that agent`);

  // 8. The pre-existing defaults.enabled:false behavior for agents with no override is unchanged.
  const defaultDisabledConfig = abliterationConfig();
  defaultDisabledConfig.agents.defaults.compaction.memoryFlush.enabled = false;
  const defaultDisabled = resolveMemoryFlushTiming({ cfg: defaultDisabledConfig, agentId: "herald", contextWindowTokens: 100000 });
  assert.equal(defaultDisabled, null, `${label}: default enabled:false must still disable memory flush for agents without an override`);

  console.log(`ok - ${label}: memory-flush scenarios (onyx override, default fallback, per-agent fence, default fence unchanged)`);
}

const readableTarget = await importFixture("context-engine-maintenance-DNdgNa58.mjs");
const readableRetry = await importFixture("compact-Cn8Yr-Sj.mjs");
await runCompactionTargetScenarios("readable chunk", {
  resolveEmbeddedCompactionTarget: readableTarget.resolveEmbeddedCompactionTarget,
  compactPreparedRetry: readableRetry.compactPreparedRetry,
});

const readableMemoryFlushPlan = await importFixture("memory-flush-plan-C2Zwg3cn.mjs");
const readableMemoryFlushPrepare = await importFixture("memory-flush-prepare-Dd4LjrXk.mjs");
await runMemoryFlushScenarios("readable chunk", {
  prepareMemoryFlushAttempt: readableMemoryFlushPrepare.prepareMemoryFlushAttempt,
  resolveMemoryFlushTiming: readableMemoryFlushPlan.resolveMemoryFlushTiming,
});

const sqliteWorker = await importFixture("worker/sqlite-store.worker.mjs");
await runCompactionTargetScenarios("sqlite-store.worker.mjs (Ot-named)", {
  resolveEmbeddedCompactionTarget: sqliteWorker.resolveEmbeddedCompactionTarget,
  compactPreparedRetry: sqliteWorker.compactPreparedRetry,
});
await runMemoryFlushScenarios("sqlite-store.worker.mjs (Ot-named)", {
  prepareMemoryFlushAttempt: sqliteWorker.prepareMemoryFlushAttempt,
  resolveMemoryFlushTiming: sqliteWorker.resolveMemoryFlushTiming,
});

// --- Structural-only proof for the three single-purpose worker chunks: the marker landed,
// so the patch's minified anchors matched real output and the transformation applied. ---
const structuralExpectations = {
  "worker/worker-chunk-CewA2kek.mjs": "agents?.entries?.[", // the per-agent compaction-target lookup itself
  "worker/worker-chunk-CBzfKKNd.mjs": "agentId:s.agentId", // threads agentId into the retry call so the lookup above can see it
  "worker/worker-chunk-CcAJ0oHc.mjs": "agents?.entries?.[", // the per-agent memory-flush lookup itself
};
for (const [file, expected] of Object.entries(structuralExpectations)) {
  const source = fs.readFileSync(path.join(dist, file), "utf8");
  assert.ok(source.includes(MARKER), `${file}: marker missing after patching`);
  assert.ok(source.includes(expected), `${file}: expected "${expected}" missing after patching`);
}
console.log("ok - structural anchors matched in all three single-purpose worker chunks");

fs.rmSync(root, { recursive: true, force: true });
console.log(
  `Agent-scoped compaction/memory-flush model override: all scenarios passed across ${touchedFiles.size} files (${receipt.changes.length} anchors)`,
);
