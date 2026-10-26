// Two tiers. Part 1 builds bounded fixtures that reproduce every anchor the patch targets
// (verified byte-for-byte against the installed 2026.10.7-nix.4-hotfix.7 store before this
// test was written), runs the real patch script against them, then imports the patched
// fixtures and drives the real patched functions with synthetic config: no OpenClaw boot, no
// model/API calls. This proves the patch's text substitutions apply and, for the readable
// chunk and its "Ot"-named worker-pool duplicate (sqlite-store.worker.mjs), that the resulting
// logic behaves, including the three single-purpose worker chunks and the two previously-
// unpatched copies (sqlite-store.worker.mjs's inlined schema, worker-chunk-BOOgs202.mjs's
// prepareMemoryFlushAttempt) as a structural check: the patch's anchor is present exactly
// once and the marker lands after patching.
//
// Part 2 drives the actual packaged, already-patched gateway tree at `root` (the argument
// every other hotfix test in this package already takes): a real AgentEntryBaseSchema parse
// (native schema, not a hand-copied shape) and the real resolveMemoryFlushPlanForRun from
// memory-flush-plan-C2Zwg3cn.mjs, imported directly, driven through every precedence
// scenario -- the tools-arm plan with and without its own model, the file-arm plan, with and
// without a per-agent override, and with no memory plugin registered at all -- with a fake
// memory provider registered through the real plugin-registration-context scope
// (withPluginRegistrationContext), the same lightweight scope OpenClaw itself uses to bind a
// plugin's own registration calls; it carries no scheduler, HTTP route or session side
// effects, so it is safe to drive directly outside a running gateway. The worker-pool
// duplicates (sqlite-store.worker.mjs, worker-chunk-CcAJ0oHc.mjs) cannot be imported this way
// standalone -- both assume a live worker_threads/bundler-managed init graph the plain ESM
// loader never runs -- so Part 2 checks their patched anchors structurally against the real
// file text instead.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const patchScript = new URL("./patch-agent-scoped-compaction-model.mjs", import.meta.url).pathname;
const MARKER = "openclaw-nix-agent-scoped-compaction-model-v1";

// ============================================================================================
// Part 1: bounded fixtures
// ============================================================================================
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oc-compaction-hotfix-"));
const fixtureDist = path.join(fixtureRoot, "dist");
fs.mkdirSync(path.join(fixtureDist, "worker"), { recursive: true });
fs.mkdirSync(path.join(fixtureDist, "config-doctor"), { recursive: true });

function write(relPath, content) {
  fs.writeFileSync(path.join(fixtureDist, relPath), content);
}

// --- Schema fixture: the exact two-line anchor the patch inserts into AgentEntryBaseSchema ---
const schemaFixtureBody =
  "const AgentEntryBaseSchema = strictObject({\n" +
  "\tid: string(),\n" +
  "\tparams: record(string(), unknown()).optional(),\n" +
  "\truntime: AgentRuntimeSchema\n" +
  "});\n";
write("zod-schema.core-CTGi3UvT.mjs", schemaFixtureBody);
// The feishu config-doctor bundle carries its own full copy of the same schema instead of
// importing the shared chunk (every other config-doctor bundle imports it); never executed
// here, only checked structurally after patching.
write("config-doctor/feishu.js", schemaFixtureBody);

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

// --- Readable memory-flush timing + resolution chunk: the real structure (resolveMemoryFlushPlan
// indirection, the tools-arm slot-owner and overlap checks, the final per-arm model line) so the
// two new final-model anchors land on the same anchors the real file carries, and the per-agent
// override's precedence over both arms is behaviorally provable here too, not only in Part 2. ---
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
    "let fakeFlushPlanResolver;",
    "function __setFakeFlushPlanResolver(fn) { fakeFlushPlanResolver = fn; }",
    "function resolveMemoryFlushPlan(params) {",
    "\tif (!fakeFlushPlanResolver) return null;",
    "\tconst plan = fakeFlushPlanResolver.resolve(params);",
    "\tif (!plan) return null;",
    "\treturn { plan, pluginId: fakeFlushPlanResolver.pluginId, selectedSlotOwner: fakeFlushPlanResolver.selectedSlotOwner === true };",
    "}",
    "function resolveMemoryFlushPlanForRun(params) {",
    "\tconst timing = resolveMemoryFlushTiming(params);",
    "\tif (!timing) return null;",
    "\tconst resolution = resolveMemoryFlushPlan(params);",
    "\tif (resolution && isToolsMemoryFlushPlan(resolution.plan) && !resolution.selectedSlotOwner) return null;",
    "\tif (!resolution) return null;",
    "\treturn {",
    "\t\t...resolution,",
    "\t\tplan: {",
    "\t\t\t...resolution.plan,",
    "\t\t\tsoftThresholdTokens: resolution.plan.softThresholdTokens ?? timing.softThresholdTokens,",
    "\t\t\tforceFlushTranscriptBytes: resolution.plan.forceFlushTranscriptBytes ?? timing.forceFlushTranscriptBytes,",
    "\t\t\treserveTokensFloor: resolution.plan.reserveTokensFloor ?? timing.reserveTokensFloor,",
    "\t\t\tmodel: isToolsMemoryFlushPlan(resolution.plan) ? resolution.plan.model ?? timing.model : resolution.plan.model",
    "\t\t}",
    "\t};",
    "}",
    "export { resolveMemoryFlushTiming, resolveMemoryFlushPlanForRun, isToolsMemoryFlushPlan, __setFakeFlushPlanResolver };",
    "",
  ].join("\n"),
);

// --- Readable memory-flush model consumption call site (memory-flush-prepare-Dd4LjrXk.mjs).
// A local resolveDefaultAgentId stub stands in for the real agent-scope-config resolver
// already imported there; the point under test is only that the real call site now falls
// back to it exactly as the rest of the function already does two lines below. ---
write(
  "memory-flush-prepare-Dd4LjrXk.mjs",
  [
    'import { resolveMemoryFlushPlanForRun } from "./memory-flush-plan-C2Zwg3cn.mjs";',
    'function resolveDefaultAgentId(cfg) { return cfg?.agents?.defaultAgentId; }',
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
// scheme as the readable chunk in this release, carrying all five functions this patch
// touches (plus the inlined schema's own anchor, never executed) so the minified variant
// gets the same full behavioral proof as the readable one. ---
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
    "let fakeFlushPlanResolver;function __setFakeFlushPlanResolver(Ot){fakeFlushPlanResolver=Ot}function resolveMemoryFlushPlan(Ot){if(!fakeFlushPlanResolver)return null;let Kt=fakeFlushPlanResolver.resolve(Ot);if(!Kt)return null;return{plan:Kt,pluginId:fakeFlushPlanResolver.pluginId,selectedSlotOwner:fakeFlushPlanResolver.selectedSlotOwner===!0}}",
    "function resolveMemoryFlushPlanForRun(Ot){let Kt=resolveMemoryFlushTiming(Ot);if(!Kt)return null;let Zt=resolveMemoryFlushPlan(Ot);if(Zt&&isToolsMemoryFlushPlan(Zt.plan)&&!Zt.selectedSlotOwner)return null;if(!Zt)return null;if(isToolsMemoryFlushPlan(Zt.plan)){}return{...Zt,plan:{...Zt.plan,softThresholdTokens:Zt.plan.softThresholdTokens??Kt.softThresholdTokens,forceFlushTranscriptBytes:Zt.plan.forceFlushTranscriptBytes??Kt.forceFlushTranscriptBytes,reserveTokensFloor:Zt.plan.reserveTokensFloor??Kt.reserveTokensFloor,model:isToolsMemoryFlushPlan(Zt.plan)?Zt.plan.model??Kt.model:Zt.plan.model}}}function memoryFlushResultIsSilent(Ot){return false}",
    "function resolveDefaultAgentId(Ot){return Ot?.agents?.defaultAgentId}",
    "async function prepareMemoryFlushAttempt(Ot){let Kt=resolveMemoryFlushPlanForRun({cfg:Ot.cfg,nowMs:Date.now(),contextWindowTokens:Ot.contextWindowTokens});if(!Kt)return null;return Kt.plan}",
    // Inlined-schema anchor, never executed: proves the generic patch applies to the same
    // string sqlite-store.worker.mjs's real AgentEntryBaseSchema carries.
    "const __schemaAnchor=\"params:record$2(string$3(),unknown()).optional(),runtime:AgentRuntimeSchema})\";",
    "export {resolveEmbeddedCompactionTarget,compactPreparedRetry,resolveMemoryFlushTiming,resolveMemoryFlushPlanForRun,prepareMemoryFlushAttempt,__setFakeFlushPlanResolver};",
    "",
  ].join("\n"),
);

// --- Structural-only fixtures: single-purpose worker chunks, each with exactly one or more
// patched anchors. These confirm the patch's minified anchors still match real output; the
// readable and sqlite-store.worker.mjs fixtures above already prove the transformed logic
// behaves. Never imported. ---
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
  "function resolveMemoryFlushTiming(e){let n=e.cfg?.agents?.defaults?.compaction?.memoryFlush;if(n?.enabled===!1)return null;let r=0,i=0,a=0;let c=n?.model?.trim()||void 0;return{softThresholdTokens:r,forceFlushTranscriptBytes:i,reserveTokensFloor:a,...c?{model:c}:{}}}function isToolsMemoryFlushPlan(e){return e.persistenceToolNames!==void 0}function resolveMemoryFlushPlan(e){return null}function resolveMemoryFlushPlanForRun(e){let t=resolveMemoryFlushTiming(e);if(!t)return null;let n=resolveMemoryFlushPlan(e);if(n&&isToolsMemoryFlushPlan(n.plan)&&!n.selectedSlotOwner)return null;if(!n)return null;if(isToolsMemoryFlushPlan(n.plan)){}return{...n,plan:{...n.plan,softThresholdTokens:n.plan.softThresholdTokens??t.softThresholdTokens,forceFlushTranscriptBytes:n.plan.forceFlushTranscriptBytes??t.forceFlushTranscriptBytes,reserveTokensFloor:n.plan.reserveTokensFloor??t.reserveTokensFloor,model:isToolsMemoryFlushPlan(n.plan)?n.plan.model??t.model:n.plan.model}}}function memoryFlushResultIsSilent(e){return false}\n",
);
// Third worker-pool duplicate of prepareMemoryFlushAttempt; `a` stands in for the chunk's own
// resolveDefaultAgentId import alias. Never imported.
write(
  "worker/worker-chunk-BOOgs202.mjs",
  "function a(cfg){return cfg?.agents?.defaultAgentId}\nfunction k(x){return x}\nasync function prepareMemoryFlushAttempt(e){let t=k({cfg:e.cfg,nowMs:Date.now(),contextWindowTokens:e.contextWindowTokens});if(!t)return null;return t}\n",
);

// --- Run the real patch script against the fixtures ---
execFileSync(process.execPath, [patchScript, fixtureRoot, "2026.10.7"], { stdio: "inherit" });

const receipt = JSON.parse(fs.readFileSync(path.join(fixtureRoot, ".agent-scoped-compaction-model-hotfix.json"), "utf8"));
assert.equal(receipt.id, MARKER);
assert.equal(receipt.changes.length, 24, `expected 24 anchor replacements, got ${receipt.changes.length}`);
const touchedFiles = new Set(receipt.changes.map((c) => c.file));
assert.equal(touchedFiles.size, 11, `expected 11 distinct files touched, got ${touchedFiles.size}`);

const importFixture = (relPath) => import(pathToFileURL(path.join(fixtureDist, relPath)).href);

// --- Schema: the per-agent compaction field landed inside AgentEntryBaseSchema, in both the
// shared chunk and the feishu config-doctor bundle's own copy ---
for (const schemaFile of ["zod-schema.core-CTGi3UvT.mjs", "config-doctor/feishu.js"]) {
  const schemaSource = fs.readFileSync(path.join(fixtureDist, schemaFile), "utf8");
  assert.ok(schemaSource.includes(`compaction: strictObject({`), `${schemaFile}: compaction field missing`);
  assert.ok(schemaSource.includes(`memoryFlush: strictObject({ model: string().optional() }).optional()`), `${schemaFile}: memoryFlush field missing`);
  assert.ok(schemaSource.includes(MARKER), `${schemaFile}: marker missing`);
  assert.ok(schemaSource.indexOf("compaction: strictObject(") < schemaSource.indexOf("runtime: AgentRuntimeSchema"), `${schemaFile}: compaction field is not inside AgentEntryBaseSchema`);
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

async function runMemoryFlushScenarios(label, { resolveMemoryFlushPlanForRun, __setFakeFlushPlanResolver }) {
  const config = abliterationConfig();
  const fileArmPlan = { resolve: () => ({ relativePath: "memory.md", systemPrompt: "x" }), pluginId: "fake-memory" };
  const toolsArmPlanNoModel = { resolve: () => ({ persistenceToolNames: ["remember"] }), pluginId: "fake-memory", selectedSlotOwner: true };
  const toolsArmPlanWithModel = { resolve: () => ({ persistenceToolNames: ["remember"], model: "plugin/own-model" }), pluginId: "fake-memory", selectedSlotOwner: true };

  // 5. The per-agent override wins on the file arm, which previously ignored the per-agent
  // (and the shared default) model unconditionally.
  __setFakeFlushPlanResolver(fileArmPlan);
  const onyxFile = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "onyx", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(onyxFile.plan.model, "abliteration/abliterated-model-large-flash", `${label}: onyx file-arm override did not win`);

  // 6. An agent with no override on the file arm keeps the exact prior behavior: the file arm
  // never consulted the shared default either, so the model stays unset.
  const heraldFile = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "herald", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(heraldFile.plan.model, undefined, `${label}: herald file-arm model should stay unset, exactly as before any override existed`);

  // 7. The per-agent override wins on the tools arm even when the plugin names its own model.
  __setFakeFlushPlanResolver(toolsArmPlanWithModel);
  const onyxToolsOwnModel = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "onyx", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(onyxToolsOwnModel.plan.model, "abliteration/abliterated-model-large-flash", `${label}: onyx tools-arm override must beat the plugin's own model`);

  // 8. No override: the plugin's own model still wins on the tools arm, exactly as before.
  const heraldToolsOwnModel = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "herald", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(heraldToolsOwnModel.plan.model, "plugin/own-model", `${label}: herald tools-arm should keep the plugin's own model unchanged`);

  // 9. Plugin names no model on the tools arm: the per-agent override still wins over the
  // shared default fallback.
  __setFakeFlushPlanResolver(toolsArmPlanNoModel);
  const onyxToolsNoModel = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "onyx", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(onyxToolsNoModel.plan.model, "abliteration/abliterated-model-large-flash", `${label}: onyx tools-arm (no plugin model) override did not win`);

  // 10. No override, no plugin model: falls back to the shared default, exactly as before.
  const heraldToolsNoModel = resolveMemoryFlushPlanForRun({ cfg: config, agentId: "herald", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(heraldToolsNoModel.plan.model, "anthropic/claude-sonnet-5", `${label}: herald tools-arm (no plugin model) should keep the shared default`);

  // 11. The pre-existing defaults.enabled:false behavior for agents with no override is
  // unchanged (the schema admits no per-agent .enabled at all; see the schema test above).
  const defaultDisabledConfig = abliterationConfig();
  defaultDisabledConfig.agents.defaults.compaction.memoryFlush.enabled = false;
  const defaultDisabled = resolveMemoryFlushPlanForRun({ cfg: defaultDisabledConfig, agentId: "herald", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(defaultDisabled, null, `${label}: default enabled:false must still disable memory flush for agents without an override`);
  // ...and an agent with its own model override is fenced by the same default-level flag too:
  // the schema has no per-agent .enabled to fence it independently.
  const onyxUnderDefaultDisabled = resolveMemoryFlushPlanForRun({ cfg: defaultDisabledConfig, agentId: "onyx", nowMs: Date.now(), contextWindowTokens: 100000 });
  assert.equal(onyxUnderDefaultDisabled, null, `${label}: default enabled:false must fence every agent; there is no per-agent .enabled to opt back in`);

  __setFakeFlushPlanResolver(undefined);
  console.log(`ok - ${label}: memory-flush scenarios (file/tools arms, plugin model/no model, onyx override, default fallback, default fence unchanged)`);
}

async function runAgentDefaultFallbackScenario(label, { prepareMemoryFlushAttempt, __setFakeFlushPlanResolver }) {
  __setFakeFlushPlanResolver({ resolve: () => ({ relativePath: 'memory.md' }), pluginId: 'fake-memory' });
  // 12. The real call site defaults a missing followupRun.run.agentId with
  // resolveDefaultAgentId(cfg), the same resolver the rest of prepareMemoryFlushAttempt already
  // falls back to; the per-agent override lookup must see that same default, not a bare
  // possibly-undefined agentId, or an agent whose run omits an explicit agentId never reaches
  // its own override.
  const config = abliterationConfig();
  config.agents.defaultAgentId = "onyx";
  const plan = await prepareMemoryFlushAttempt({ cfg: config, contextWindowTokens: 100000, followupRun: { run: {} } });
  assert.equal(plan.model, "abliteration/abliterated-model-large-flash", `${label}: omitted agentId should still resolve onyx's override through resolveDefaultAgentId(cfg)`);

  // 13. An explicit agentId on the run is still used as-is, not overridden by the default.
  const config2 = abliterationConfig();
  config2.agents.defaultAgentId = "onyx";
  const heraldPlan = await prepareMemoryFlushAttempt({ cfg: config2, contextWindowTokens: 100000, followupRun: { run: { agentId: "herald" } } });
  assert.equal(heraldPlan.model, undefined, `${label}: an explicit agentId must not be overridden by resolveDefaultAgentId(cfg); herald's file-arm model stays unset, exactly as before any override existed`);

  __setFakeFlushPlanResolver(undefined);
  console.log(`ok - ${label}: prepareMemoryFlushAttempt resolves a missing agentId with resolveDefaultAgentId(cfg)`);
}

const readableTarget = await importFixture("context-engine-maintenance-DNdgNa58.mjs");
const readableRetry = await importFixture("compact-Cn8Yr-Sj.mjs");
await runCompactionTargetScenarios("readable chunk", {
  resolveEmbeddedCompactionTarget: readableTarget.resolveEmbeddedCompactionTarget,
  compactPreparedRetry: readableRetry.compactPreparedRetry,
});

const readableMemoryFlushPlan = await importFixture("memory-flush-plan-C2Zwg3cn.mjs");
const readableMemoryFlushPrepare = await importFixture("memory-flush-prepare-Dd4LjrXk.mjs");
await runMemoryFlushScenarios("readable chunk", readableMemoryFlushPlan);
await runAgentDefaultFallbackScenario("readable chunk", { ...readableMemoryFlushPrepare, __setFakeFlushPlanResolver: readableMemoryFlushPlan.__setFakeFlushPlanResolver });

const sqliteWorker = await importFixture("worker/sqlite-store.worker.mjs");
await runCompactionTargetScenarios("sqlite-store.worker.mjs (Ot-named)", {
  resolveEmbeddedCompactionTarget: sqliteWorker.resolveEmbeddedCompactionTarget,
  compactPreparedRetry: sqliteWorker.compactPreparedRetry,
});
await runMemoryFlushScenarios("sqlite-store.worker.mjs (Ot-named)", sqliteWorker);
await runAgentDefaultFallbackScenario("sqlite-store.worker.mjs (Ot-named)", sqliteWorker);


// --- Structural-only proof for the single-purpose worker chunks and the two previously-
// unpatched copies: the marker landed, so the patch's minified anchors still matched real
// output and the transformation applied. ---
const structuralExpectations = {
  "worker/worker-chunk-CewA2kek.mjs": ["agents?.entries?.["], // the per-agent compaction-target lookup itself
  "worker/worker-chunk-CBzfKKNd.mjs": ["agentId:s.agentId"], // threads agentId into the retry call so the lookup above can see it
  "worker/worker-chunk-CcAJ0oHc.mjs": [
    "agents?.entries?.[", // the per-agent memory-flush lookup itself
    "agentOverrideModel??(isToolsMemoryFlushPlan(n.plan)?n.plan.model??t.model:n.plan.model)", // the final per-arm precedence fix
  ],
  "worker/worker-chunk-BOOgs202.mjs": ["agentId:e.followupRun.run.agentId??a(e.cfg)"], // the third prepareMemoryFlushAttempt duplicate now threads agentId with the same default
};
for (const [file, expectations] of Object.entries(structuralExpectations)) {
  const source = fs.readFileSync(path.join(fixtureDist, file), "utf8");
  assert.ok(source.includes(MARKER), `${file}: marker missing after patching`);
  for (const expected of expectations) {
    assert.ok(source.includes(expected), `${file}: expected "${expected}" missing after patching`);
  }
}
console.log("ok - structural anchors matched in every single-purpose or previously-unpatched worker chunk");

fs.rmSync(fixtureRoot, { recursive: true, force: true });
console.log(`Part 1 (bounded fixtures): all scenarios passed across ${touchedFiles.size} files (${receipt.changes.length} anchors)`);

// ============================================================================================
// Part 2: the actual packaged, already-patched gateway tree
// ============================================================================================
const root = process.argv[2];
const realDist = path.join(root, "dist");
const realReceipt = JSON.parse(fs.readFileSync(path.join(root, ".agent-scoped-compaction-model-hotfix.json"), "utf8"));
assert.equal(realReceipt.id, MARKER);
assert.equal(realReceipt.changes.length, 24, `expected 24 anchor replacements in the real tree, got ${realReceipt.changes.length}`);

// --- Native schema: the real AgentEntryBaseSchema (not a hand-copied shape) accepts the new
// per-agent fields and still rejects everything the schema was never asked to carry. ---
{
  const { z: AgentEntryBaseSchema } = await import(pathToFileURL(path.join(realDist, "zod-schema.core-CTGi3UvT.mjs")).href);
  const parsed = AgentEntryBaseSchema.parse({
    id: "onyx",
    compaction: { model: "abliteration/abliterated-model-large-flash", memoryFlush: { model: "abliteration/abliterated-model-large-flash" } },
  });
  assert.equal(parsed.compaction.model, "abliteration/abliterated-model-large-flash");
  assert.equal(parsed.compaction.memoryFlush.model, "abliteration/abliterated-model-large-flash");
  assert.throws(
    () => AgentEntryBaseSchema.parse({ id: "onyx", compaction: { memoryFlush: { model: "x", enabled: false } } }),
    /unrecognized/i,
    "the real schema must still reject memoryFlush.enabled: nothing in this hotfix asked for it",
  );
  console.log("ok - real AgentEntryBaseSchema accepts the per-agent model fields and rejects memoryFlush.enabled");
}

// --- Real resolver chain: resolveMemoryFlushPlanForRun imported directly from the patched
// packaged module, driven through every precedence scenario with a fake memory provider
// registered through the real plugin-registration-context scope (no scheduler, HTTP route or
// session side effects -- see the header comment). ---
{
  const { E: withPluginRegistrationContext } = await import(pathToFileURL(path.join(realDist, "runtime-CCZWjmme.mjs")).href);
  const { r: resolveMemoryFlushPlanForRun } = await import(pathToFileURL(path.join(realDist, "memory-flush-plan-C2Zwg3cn.mjs")).href);

  const config = abliterationConfig();
  const run = (capability, agentId, cfg = config) => {
    const fakeRegistry = { memoryCapabilities: [{ pluginId: "fake-memory", capability, memorySlotSelected: true }] };
    return withPluginRegistrationContext(fakeRegistry, "fake-memory", () =>
      resolveMemoryFlushPlanForRun({ cfg, agentId, nowMs: Date.now(), contextWindowTokens: 100000 }),
    );
  };

  const fileArm = { flushPlanResolver: () => ({ relativePath: "memory.md", systemPrompt: "x" }) };
  const toolsArmNoModel = { flushPlanResolver: () => ({ persistenceToolNames: ["remember"] }) };
  const toolsArmWithModel = { flushPlanResolver: () => ({ persistenceToolNames: ["remember"], model: "plugin/own-model" }) };

  assert.equal(run(fileArm, "onyx")?.plan.model, "abliteration/abliterated-model-large-flash", "real: onyx file-arm override did not win");
  assert.equal(run(fileArm, "herald")?.plan.model, undefined, "real: herald file-arm model should stay unset, exactly as before any override existed");
  assert.equal(run(toolsArmWithModel, "onyx")?.plan.model, "abliteration/abliterated-model-large-flash", "real: onyx tools-arm override must beat the plugin's own model");
  assert.equal(run(toolsArmWithModel, "herald")?.plan.model, "plugin/own-model", "real: herald tools-arm should keep the plugin's own model unchanged");
  assert.equal(run(toolsArmNoModel, "onyx")?.plan.model, "abliteration/abliterated-model-large-flash", "real: onyx tools-arm (no plugin model) override did not win");
  assert.equal(run(toolsArmNoModel, "herald")?.plan.model, "anthropic/claude-sonnet-5", "real: herald tools-arm (no plugin model) should keep the shared default");

  const noPluginRegistered = withPluginRegistrationContext({ memoryCapabilities: [] }, "fake-memory", () =>
    resolveMemoryFlushPlanForRun({ cfg: config, agentId: "onyx", nowMs: Date.now(), contextWindowTokens: 100000 }),
  );
  assert.equal(noPluginRegistered, null, "real: no memory plugin registered must resolve to null");

  const defaultDisabledConfig = abliterationConfig();
  defaultDisabledConfig.agents.defaults.compaction.memoryFlush.enabled = false;
  assert.equal(run(toolsArmNoModel, "onyx", defaultDisabledConfig), null, "real: default enabled:false must fence every agent, including one with its own override");

  console.log("ok - real resolveMemoryFlushPlanForRun: file/tools arms, plugin model/no model, onyx override, default fallback, no plugin, default fence");
}

// --- The worker-pool duplicates (sqlite-store.worker.mjs, worker-chunk-CcAJ0oHc.mjs) assume a
// live worker_threads/bundler init graph the plain ESM loader never runs standalone, so these
// are checked structurally against the real patched file text instead. ---
{
  const sqliteWorkerSource = fs.readFileSync(path.join(realDist, "worker/sqlite-store.worker.mjs"), "utf8");
  assert.ok(sqliteWorkerSource.includes("compaction:strictObject({model:string$3().optional(),memoryFlush:strictObject({model:string$3().optional()}).optional()}).optional()"), "real sqlite-store.worker.mjs: inlined schema missing the per-agent compaction field");
  assert.ok(sqliteWorkerSource.includes("model:agentOverrideModel??(isToolsMemoryFlushPlan(Zt.plan)?Zt.plan.model??Kt.model:Zt.plan.model)"), "real sqlite-store.worker.mjs: final per-arm model precedence fix missing");
  assert.ok(sqliteWorkerSource.includes("agentId:Ot.followupRun.run.agentId??resolveDefaultAgentId(Ot.cfg)"), "real sqlite-store.worker.mjs: prepareMemoryFlushAttempt does not default agentId with resolveDefaultAgentId(cfg)");

  const workerChunkSource = fs.readFileSync(path.join(realDist, "worker/worker-chunk-CcAJ0oHc.mjs"), "utf8");
  assert.ok(workerChunkSource.includes("model:agentOverrideModel??(isToolsMemoryFlushPlan(n.plan)?n.plan.model??t.model:n.plan.model)"), "real worker-chunk-CcAJ0oHc.mjs: final per-arm model precedence fix missing");

  const boogsSource = fs.readFileSync(path.join(realDist, "worker/worker-chunk-BOOgs202.mjs"), "utf8");
  assert.ok(boogsSource.includes("agentId:e.followupRun.run.agentId??a(e.cfg)"), "real worker-chunk-BOOgs202.mjs: prepareMemoryFlushAttempt does not thread agentId with the same default");

  const feishuSource = fs.readFileSync(path.join(realDist, "config-doctor/feishu.js"), "utf8");
  assert.ok(feishuSource.includes("compaction: strictObject({") && feishuSource.includes(MARKER), "real config-doctor/feishu.js: inlined schema missing the per-agent compaction field");

  const readableSource = fs.readFileSync(path.join(realDist, "memory-flush-prepare-Dd4LjrXk.mjs"), "utf8");
  assert.ok(readableSource.includes("agentId: params.followupRun.run.agentId ?? resolveDefaultAgentId(params.cfg)"), "real memory-flush-prepare-Dd4LjrXk.mjs: prepareMemoryFlushAttempt does not default agentId with resolveDefaultAgentId(cfg)");

  console.log("ok - structural checks on the real worker-pool duplicates and the two previously-unpatched copies (sqlite-store.worker.mjs schema, worker-chunk-BOOgs202.mjs)");
}

console.log(`Agent-scoped compaction/memory-flush model override: Part 1 + Part 2 passed (${realReceipt.changes.length} anchors across ${new Set(realReceipt.changes.map((c) => c.file)).size} files in the real tree)`);
