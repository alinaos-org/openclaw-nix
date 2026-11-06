// Behavioural check for patch-heartbeat-respond-run.mjs, on the tree's own code. It follows
// one response from the runner's options to the classifier's verdict, with upstream's
// packaged tool, payload builder, response selector and classifier:
// - a heartbeat run enables the tool when it is isolated or its agent is enrolled, and leaves
//   a non-enrolled agent's shared session alone; the source reply mode still follows
//   shouldUseHeartbeatResponseToolPrompt, which still says no for "automatic";
// - with the tool enabled a call is accepted, and without it (an ordinary turn) refused;
// - notify=false classifies as a silent ack, notify=true as one delivery of its text, with
//   no warning payload, under "automatic" and with no source reply mode;
// - without the tool, plain alert text is still delivered, and HEARTBEAT_OK and NO_REPLY
//   stay silent;
// - isolated runs get the tool prompt, with the fallback for a run that has no such tool, and
//   keep the mode decision; shared ones keep theirs;
// - the Claude CLI path: only an isolated heartbeat run's loopback turn gets the tool, its
//   first accepted result is recorded, the run returns the embedded run's payload, and a CLI
//   failure afterwards keeps that payload, settles as completed and falls back to no model.
// It locates code by content, so on an unpatched tree it fails on the first behaviour.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const dist = path.join(root, "dist");
const MARKER = "openclaw-nix-heartbeat-respond-run-v1";

// The gateway code below runs on throwaway state, whatever this shell exports.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-respond-test-"));
for (const name of Object.keys(process.env)) if (name.startsWith("OPENCLAW_")) delete process.env[name];
fs.writeFileSync(path.join(scratch, "openclaw.json"), "{}");
Object.assign(process.env, { HOME: scratch, OPENCLAW_STATE_DIR: scratch, OPENCLAW_CONFIG_PATH: path.join(scratch, "openclaw.json") });

const chunk = (pattern, needle) => {
  const hits = fs.readdirSync(dist).filter((name) => pattern.test(name) && !fs.lstatSync(path.join(dist, name)).isSymbolicLink() && fs.readFileSync(path.join(dist, name), "utf8").includes(needle));
  assert.equal(hits.length, 1, `expected one chunk with ${needle}, got ${hits.join(", ") || "none"}`);
  return path.join(dist, hits[0]);
};
const read = (file) => fs.readFileSync(file, "utf8");
const between = (text, start, end) => {
  const from = text.indexOf(start);
  assert(from >= 0, `missing: ${start.slice(0, 70)}`);
  const to = text.indexOf(end, from + start.length);
  assert(to > from, `missing after ${start.slice(0, 50)}: ${end.slice(0, 50)}`);
  return text.slice(from, to);
};
// A top-level function, by its tab-indented closing brace.
const fn = (text, signature) => `${between(text, signature, "\n}\n")}\n}\n`;
// The named bindings a chunk imports, resolved to the packaged modules.
const bindImports = async (file, text, names) => {
  const scope = {};
  for (const match of text.matchAll(/^import \{([^}]*)\} from "(\.[^"]+)";$/gm)) {
    const wanted = match[1].split(",").map((part) => part.trim().split(/\s+as\s+/)).filter((pair) => names.includes(pair[pair.length - 1]));
    if (wanted.length === 0) continue;
    const module = await import(pathToFileURL(path.resolve(path.dirname(file), match[2])).href);
    for (const pair of wanted) scope[pair[pair.length - 1]] = module[pair[0]];
  }
  for (const name of names) assert(name in scope, `${path.basename(file)} no longer imports ${name}`);
  return scope;
};
const plain = (value) => JSON.parse(JSON.stringify(value));

const runnerFile = chunk(/^heartbeat-runner-run-.*\.mjs$/, "function shouldUseHeartbeatResponseToolPrompt(params) {");
const runner = read(runnerFile);

// 1. The runner's reply options, as the dispatch builds them.
const optionsSource = between(runner, "heartbeatModelOverride: heartbeat?.model?.trim(),", "abortSignal: signal,");
const options = (usesHeartbeatResponseTool, kind = "isolated", enrolled = true) => vm.runInNewContext(`({${optionsSource}})`, {
  prepared: { usesHeartbeatResponseTool, run: { kind } }, heartbeat: {}, cfg: {}, agentId: "main",
  isHeartbeatEnabledForAgent: (cfg, agentId) => enrolled && agentId === "main",
});
const toolOn = { enableHeartbeatTool: true, forceHeartbeatTool: true };
assert.equal(options(false).enableHeartbeatTool, true, "a heartbeat run under \"automatic\" does not enable heartbeat_respond");
assert.equal(options(false).forceHeartbeatTool, true, "a heartbeat run under \"automatic\" does not force heartbeat_respond");
assert.equal(options(false).sourceReplyDeliveryMode, undefined, "\"automatic\" must not become a tool-only source reply mode");
assert.deepEqual(plain(options(true)), { ...toolOn, sourceReplyDeliveryMode: "message_tool_only" }, "upstream's message_tool path changed");
assert.deepEqual(plain(options(true, "session", false)), { ...toolOn, sourceReplyDeliveryMode: "message_tool_only" }, "upstream's message_tool path needs no enrollment");
assert.deepEqual(plain(options(false, "isolated", false)), toolOn, "an isolated run of an agent without a heartbeat block does not enable the tool");
assert.deepEqual(plain(options(false, "session", true)), toolOn, "an enrolled agent's shared session is offered the tool, so its heartbeat run must accept it");
assert.deepEqual(plain(options(false, "session", false)), {}, "a non-enrolled agent's shared session must not gain the tool for one turn");

// 2. The mode decision is upstream's own.
const modeScope = await bindImports(runnerFile, runner, ["normalizeChatType"]);
const shouldUse = vm.runInNewContext(`(${fn(runner, "function shouldUseHeartbeatResponseToolPrompt(params) {")})`, {
  ...modeScope,
  resolveHeartbeatModelRef: () => ({ provider: "x", model: "y" }),
  resolveEffectiveAgentRuntime: () => "codex",
});
const channel = (messages) => shouldUse({ cfg: { messages }, chatType: "channel" });
assert.equal(channel({ groupChat: { visibleReplies: "automatic" } }), false, "automatic group chat now selects the tool-only mode (fixed upstream? revisit this patch)");
assert.equal(channel({ groupChat: { visibleReplies: "message_tool" } }), true);
assert.equal(channel({}), true, "no setting on the codex runtime");
// The classifier's suppression reads the config, not this run: under "automatic" it stays
// off, which is what keeps plain alert text deliverable (section 5).
assert(runner.includes("suppressUnmarkedSourceReplies: resolveSourceReplyDeliveryMode({\n\t\t\tcfg,\n\t\t\tctx: {\n\t\t\t\tChatType: delivery.chatType,"), "the classifier's source reply suppression no longer follows the config");
const { resolveSourceReplyDeliveryMode } = await bindImports(runnerFile, runner, ["resolveSourceReplyDeliveryMode"]);
assert.equal(resolveSourceReplyDeliveryMode({ cfg: { messages: { groupChat: { visibleReplies: "automatic" } } }, ctx: { ChatType: "channel", Provider: "buzz" } }), "automatic");
// The codex harness accepts on the heartbeat trigger by itself, so no edit here covers it.
const codexDir = path.join(dist, "extensions", "codex", ".setup");
const codexBuilds = fs.readdirSync(codexDir).filter((name) => /^dynamic-tool-build-.*\.mjs$/.test(name) && read(path.join(codexDir, name)).includes("enableHeartbeatTool: params.trigger === \"heartbeat\" ||"));
assert.equal(codexBuilds.length, 1, "the codex harness no longer enables heartbeat_respond on the heartbeat trigger");

// 3. The prompt: tool wording on isolated runs, the mode flag untouched.
const promptSource = between(runner, "const resolveRunPrompt = (useHeartbeatResponseTool) =>", "let heartbeatRunPrompt = resolveRunPrompt(");
const promptScope = await bindImports(runnerFile, runner, ["isExecCompletionSystemEvent", "isCronSystemEvent", "buildExecEventPrompt", "buildCronEventPrompt", "resolveHeartbeatPromptCore", "resolveHeartbeatPromptForResponseTool", "HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS", "SILENT_REPLY_TOKEN", "isRelayableExecCompletionEvent"]);
const promptBuilder = vm.runInNewContext(`${[
  "function resolveHeartbeatPromptRaw(cfg, heartbeat) {",
  "function resolveConfiguredHeartbeatPrompt(cfg, heartbeat) {",
  "function resolveHeartbeatResponseToolPrompt(cfg, heartbeat) {",
  "function appendHeartbeatScratch(prompt, heartbeatScratchContent) {",
  "function resolveHeartbeatRunPrompt(params) {",
  "function openclawNixHeartbeatToolPrompt(resolved, usesHeartbeatResponseTool, toolWordingAdded) {",
].map((signature) => fn(runner, signature)).join("\n")}\n({ resolveHeartbeatRunPrompt, openclawNixHeartbeatToolPrompt })`, promptScope);
const FALLBACK = "If the heartbeat_respond tool is not available in this run";
const INSTRUCTIONS = promptScope.HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS;
const realPrompt = (kind, decision, { preflight = {}, scheduledTasks = [], canRelayToUser = true, heartbeat = {} } = {}) => vm.runInNewContext(`(() => { ${promptSource}; return resolveRunPrompt(decision); })()`, {
  ...promptBuilder, decision, run: { kind }, cfg: {}, heartbeat, canRelayToUser, scheduledTasks,
  preflight: { selectedEventEntries: [], session: {}, ...preflight },
});
const execEvents = { selectedEventEntries: [{ text: "Exec completed (abc, code 0) :: built", contextKey: "exec:abc" }], shouldInspectPendingEvents: true };
const toolPrompts = {
  "the default prompt": {},
  "a scheduled task": { scheduledTasks: [{ name: "backup", prompt: "check it", jobId: "j" }] },
  "an exec completion": { preflight: execEvents },
  "an exec completion without delivery": { preflight: execEvents, canRelayToUser: false },
  "a custom prompt": { heartbeat: { prompt: "Check the disk." } },
};
for (const [label, setup] of Object.entries(toolPrompts)) {
  const built = realPrompt("isolated", false, setup);
  assert.equal(built.usesHeartbeatResponseTool, false, `${label}: the prompt must not select the tool-only mode`);
  assert(built.prompt.includes(INSTRUCTIONS), `${label}: an isolated run did not get the tool wording`);
  assert.equal(built.prompt.split(FALLBACK).length - 1, 1, `${label}: an isolated run must say once what to do without the tool:\n${built.prompt}`);
  assert(built.prompt.split(FALLBACK)[1].includes(promptScope.SILENT_REPLY_TOKEN), `${label}: the fallback lost the silent reply`);
}
const emptyCron = promptBuilder.openclawNixHeartbeatToolPrompt({ prompt: promptScope.buildCronEventPrompt([], { useHeartbeatResponseTool: true }) }, false, true);
assert.equal(emptyCron.prompt.split(FALLBACK).length - 1, 1, "an empty cron wake on an isolated run has no fallback");
// A wake whose prompt names no tool stays as it was.
const reminder = { selectedEventEntries: [{ text: "Water the plants", contextKey: "cron:job" }], isCronWake: true };
assert.equal(realPrompt("isolated", false, { preflight: reminder }).prompt, realPrompt("session", false, { preflight: reminder }).prompt, "a reminder wake changed");
assert(realPrompt("session", false).prompt.includes(FALLBACK) === false && realPrompt("session", false).prompt.includes(INSTRUCTIONS) === false, "a run on a shared session keeps its prompt");
assert.equal(realPrompt("session", false).usesHeartbeatResponseTool, false);
assert.equal(realPrompt("session", true).usesHeartbeatResponseTool, true);
assert(realPrompt("session", true).prompt.includes(INSTRUCTIONS));
// Upstream's own choice keeps upstream's own wording, here and on an isolated run.
const execUpstream = realPrompt("isolated", true, { preflight: execEvents });
assert.equal(execUpstream.usesHeartbeatResponseTool, true);
assert.equal(execUpstream.prompt.includes(FALLBACK), false, "the message_tool path gained the fallback, which its tool-only mode would swallow");

// 4. Upstream's tool: enabled accepts once, offered only refuses.
const toolsFile = chunk(/^openclaw-tools-.*\.mjs$/, "function createHeartbeatResponseTool(options = {}) {");
const toolsText = read(toolsFile);
const responseFile = chunk(/^heartbeat-tool-response-.*\.mjs$/, "function normalizeHeartbeatToolResponse(value) {");
const responseText = read(responseFile);
const responseExports = await import(pathToFileURL(responseFile).href);
const exported = (name) => responseExports[new RegExp(`\\b${name} as (\\w+)\\b`).exec(responseText)[1]];
const normalizeHeartbeatToolResponse = exported("normalizeHeartbeatToolResponse");
const selectHeartbeatToolResponse = exported("selectHeartbeatToolResponse");
const toolSource = between(toolsText, "function resolveHeartbeatTools(options, agentId) {", "//#endregion");
const toolScope = {
  HEARTBEAT_RESPONSE_TOOL_NAME: "heartbeat_respond",
  HeartbeatResponseToolSchema: {},
  ToolInputError: class ToolInputError extends Error {},
  isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  readSnakeCaseParamRaw: (args, key) => args[key],
  assertCronJobScratchContent: () => {},
  normalizeHeartbeatToolResponse,
  isHeartbeatEnabledForAgent: () => true,
  textResult: (text, details) => ({ content: [{ type: "text", text }], details }),
  Buffer,
  JSON,
  Object,
};
const { resolveHeartbeatTools, resolveHeartbeatResponseTool } = vm.runInNewContext(`${toolSource}\n({ resolveHeartbeatTools, resolveHeartbeatResponseTool })`, toolScope);
const toolFor = (runOptions) => {
  const decided = resolveHeartbeatTools({ ...runOptions, config: {} }, "main");
  return resolveHeartbeatResponseTool({ enableHeartbeatTool: decided.enableHeartbeatTool, offerHeartbeatTool: decided.offerHeartbeatTool });
};
const quiet = { outcome: "no_change", notify: false, summary: "nothing new" };
const alert = { outcome: "needs_attention", notify: true, summary: "disk", notificationText: "Disk is full" };
await assert.rejects(toolFor({}).execute("call", quiet), /only accepted during a heartbeat run/, "an ordinary turn must keep refusing the tool");
const { enableHeartbeatTool, forceHeartbeatTool } = options(false);
const accepted = await toolFor({ enableHeartbeatTool, forceHeartbeatTool }).execute("call", quiet);
assert.equal(accepted.details.status, "accepted", "the runner's options do not make the tool accept");
const oneShot = toolFor({ enableHeartbeatTool, forceHeartbeatTool });
await oneShot.execute("call", quiet);
await assert.rejects(oneShot.execute("call", quiet), /already accepted/, "the tool is no longer one-shot");
const alertResult = await toolFor({ enableHeartbeatTool, forceHeartbeatTool }).execute("call", alert);

// 5. Upstream's payload builder and classifier: the response decides, with no tool-only mode.
const payloadsFile = chunk(/^payloads-.*\.mjs$/, "function buildEmbeddedRunPayloads(params) {");
const payloadsText = read(payloadsFile);
const buildEmbeddedRunPayloads = (await import(pathToFileURL(payloadsFile).href))[/\bbuildEmbeddedRunPayloads as (\w+)\b/.exec(payloadsText)[1]];
const embedded = (extra) => buildEmbeddedRunPayloads({ assistantTexts: [], lastAssistant: undefined, sessionKey: "agent:main:main:heartbeat", provider: "google", model: "flash", isHeartbeatTrigger: true, ...extra });
const classifierNames = ["getHeartbeatToolNotificationText", "getReplyPayloadMetadata", "copyReplyPayloadMetadata", "hasOutboundReplyContent", "resolveSendableOutboundReplyParts", "isSilentReplyPayloadText", "stripHeartbeatToken", "escapeRegExp", "replaceGenericExternalRunFailureText"];
const classifierScope = await bindImports(runnerFile, runner, classifierNames);
const classifierSource = [
  between(runner, "function stripLeadingHeartbeatResponsePrefix(text, responsePrefix) {", "//#endregion"),
  fn(runner, "function truncateHeartbeatPreview(value) {"),
].join("\n");
const classify = vm.runInNewContext(`${classifierSource}\nclassifyHeartbeatAgentOutcome`, { ...classifierScope, STREAM_ERROR_FALLBACK_TEXT: "\u0000stream error", truncateUtf16Safe: (value) => value, RegExp });
const verdict = (payloads) => {
  const selected = selectHeartbeatToolResponse(payloads);
  return classify({
    agentRun: { agentRunFailed: false, heartbeatToolResponse: selected?.response, heartbeatTerminalToolFailure: undefined, replyPayload: payloads[payloads.length - 1] },
    useHeartbeatFailureCopy: false, hasRelayableExecCompletion: false, suppressUnmarkedSourceReplies: false, responsePrefix: undefined, ackMaxChars: 300,
  });
};
const silent = verdict(embedded({ heartbeatToolResponse: normalizeHeartbeatToolResponse(accepted.details) }));
assert.equal(silent.kind, "ack", "notify=false is not a silent ack");
assert.equal(silent.response.notify, false);
const delivered = verdict(embedded({ heartbeatToolResponse: normalizeHeartbeatToolResponse(alertResult.details) }));
assert.equal(delivered.kind, "delivery", "notify=true is not delivered");
assert.equal(delivered.normalized.text, "Disk is full");
assert.equal(delivered.replyPayload, undefined, "only the response's text is delivered");
const summaryOnly = verdict(embedded({ heartbeatToolResponse: { outcome: "blocked", notify: true, summary: "Blocked on login" } }));
assert.equal(summaryOnly.normalized.text, "Blocked on login", "notify=true without notificationText must fall back to the summary");
// The response wins over the model's closing prose, on either path.
assert.equal(embedded({ heartbeatToolResponse: normalizeHeartbeatToolResponse(accepted.details), assistantTexts: ["All quiet, boss."] }).length, 1);
// No tool call: a real alert is not swallowed; the acks stay silent.
const noCall = (text) => verdict([{ text }]);
const plainAlert = noCall("The backup failed at 03:00");
assert.equal(plainAlert.kind, "delivery", "a plain text alert is swallowed");
assert.equal(plainAlert.normalized.text, "The backup failed at 03:00");
assert.equal(noCall("HEARTBEAT_OK").kind, "ack", "HEARTBEAT_OK is delivered");
assert.equal(noCall("NO_REPLY").kind, "ack", "NO_REPLY is delivered");
assert.equal(classify({ agentRun: { agentRunFailed: false }, useHeartbeatFailureCopy: false, hasRelayableExecCompletion: false, suppressUnmarkedSourceReplies: false, ackMaxChars: 300 }).kind, "ack", "an empty run is delivered");

// 6. The Claude CLI path.
const scopedFile = chunk(/^tool-resolution-.*\.mjs$/, "async function resolveGatewayScopedTools(params, assertPreparationCurrent) {");
const scoped = read(scopedFile);
const loopbackRun = vm.runInNewContext(`(${fn(scoped, "function openclawNixHeartbeatLoopbackRun(params) {")})`);
const isolated = { surface: "loopback", trigger: "heartbeat", sessionKey: "agent:main:main:heartbeat" };
assert.equal(loopbackRun(isolated), true, "an isolated heartbeat run's Claude turn has no heartbeat_respond");
for (const [label, params] of Object.entries({
  "an ordinary Claude turn": { ...isolated, trigger: "user" },
  "a cron turn": { ...isolated, trigger: "cron" },
  "a heartbeat on a shared session": { ...isolated, sessionKey: "agent:main:main" },
  "the HTTP surface": { ...isolated, surface: "http" },
  "no session key": { ...isolated, sessionKey: undefined },
})) assert.equal(loopbackRun(params), false, `${label} must not be offered the tool`);
for (const needed of [
  "...openclawNixHeartbeatLoopbackRun(params) ? [\"heartbeat_respond\"] : []",
  "...openclawNixHeartbeatLoopbackRun(params) ? { enableHeartbeatTool: true, offerHeartbeatTool: true } : {},",
]) assert.equal(scoped.split(needed).length - 1, 1, `loopback edit missing: ${needed}`);
assert(scoped.indexOf("{ enableHeartbeatTool: true, offerHeartbeatTool: true }") < scoped.indexOf("await createOpenClawToolsAsync(openClawToolOptions,"), "the tool options come too late");

// The real resolution behind the loopback server: past the tool policy, under a restrictive
// profile too, and accepting the call; absent from an ordinary turn and a shared session.
const exportOf = (file, name) => new RegExp(`\\b${name} as (\\w+)\\b`).exec(read(file))?.[1];
const snapshotFile = chunk(/^runtime-snapshot-.*\.mjs$/, "function readRuntimeConfig() {");
const setRuntimeConfigSnapshot = (await import(pathToFileURL(snapshotFile).href))[exportOf(snapshotFile, "setRuntimeConfigSnapshot")];
const resolveGatewayScopedTools = (await import(pathToFileURL(scopedFile).href))[exportOf(scopedFile, "resolveGatewayScopedTools")];
const loopbackTool = async (profile, extra) => {
  const cfg = { tools: { profile }, agents: { list: [{ id: "main", default: true }] } };
  setRuntimeConfigSnapshot(cfg);
  const { tools } = await resolveGatewayScopedTools({ cfg, surface: "loopback", senderIsOwner: true, messageProvider: "buzz", agentId: "main", runId: "test", ...extra });
  return tools.find((tool) => tool.name === "heartbeat_respond");
};
for (const profile of ["coding", "minimal"]) {
  const tool = await loopbackTool(profile, { trigger: "heartbeat", sessionKey: isolated.sessionKey });
  assert(tool, `the loopback server does not offer heartbeat_respond under the ${profile} profile`);
  assert.equal((await tool.execute("call", quiet)).details.status, "accepted", "the loopback tool refuses a heartbeat run");
  assert.equal(await loopbackTool(profile, { trigger: "user", sessionKey: isolated.sessionKey }), undefined, "an ordinary Claude turn gained heartbeat_respond");
  assert.equal(await loopbackTool(profile, { trigger: "heartbeat", sessionKey: "agent:main:main" }), undefined, "a shared session gained heartbeat_respond");
}

const trackingFile = chunk(/^execute\.runtime-.*\.mjs$/, "function createCliToolTracking(context) {");
const tracking = read(trackingFile);
const trackingScope = await bindImports(trackingFile, tracking, ["openclawNixNormalizeHeartbeatResponse", "readToolResultDetails"]);
const responseOf = vm.runInNewContext(`(${fn(tracking, "function openclawNixHeartbeatResponseOf(toolName, call) {")})`, trackingScope);
const scratchResult = { content: [], details: { status: "accepted", ...quiet } };
Object.defineProperty(scratchResult.details, "scratch", { value: "watch the backup", enumerable: false });
assert.equal(responseOf("heartbeat_respond", { outcome: "completed", result: scratchResult }).scratch, "watch the backup", "the scratch proposal is lost");
assert.equal(responseOf("heartbeat_respond", { outcome: "completed", result: alertResult }).notificationText, "Disk is full");
assert.equal(responseOf("heartbeat_respond", { outcome: "failed", result: alertResult }), undefined, "a failed call counted as a response");
assert.equal(responseOf("heartbeat_respond", { outcome: "blocked" }), undefined, "a blocked call counted as a response");
assert.equal(responseOf("message", { outcome: "completed", result: alertResult }), undefined, "another tool counted as a response");
const trackingBody = between(tracking, "function createCliToolTracking(context) {", "attachDeliveryEvidence(error) {");
const recordLine = "openclawNixHeartbeatResponse ??= openclawNixHeartbeatResponseOf(toolName, call);";
assert.equal(trackingBody.split(recordLine).length - 1, 1, "the loopback result is not recorded");
assert(trackingBody.indexOf("onToolCallResult: (call) => {") < trackingBody.indexOf(recordLine) && trackingBody.indexOf(recordLine) < trackingBody.indexOf("withExecutionEvidence(output) {"), "the record line moved");
// The loopback tool's one-shot guard lasts as long as its 30 s cache entry, so the first
// response has to win here, as it does on an embedded run.
const recordFirst = vm.runInNewContext(`(() => { let openclawNixHeartbeatResponse; const openclawNixHeartbeatResponseOf = (toolName, call) => call; return (toolName, call) => { ${recordLine} return openclawNixHeartbeatResponse; }; })()`);
const firstCall = { notify: true };
assert.equal(recordFirst("heartbeat_respond", undefined), undefined);
assert.equal(recordFirst("heartbeat_respond", firstCall), firstCall);
assert.equal(recordFirst("heartbeat_respond", { notify: false }), firstCall, "a later response replaced the first");
assert.equal(trackingBody.split("heartbeatToolResponse: openclawNixHeartbeatResponse\n\t});").length - 1, 1, "the tracking's evidence does not carry the response");
assert.equal(trackingBody.split("...current.heartbeatToolResponse ? { heartbeatToolResponse: current.heartbeatToolResponse } : {}").length - 1, 1, "the attempt's output does not carry the response");
assert(tracking.includes("if (runFailed) throw toolTracking.attachDeliveryEvidence(runError);"), "a failed attempt no longer attaches the tracking's evidence");
assert(tracking.includes("attachDeliveryEvidence(error) {\n\t\t\treturn attachCliMessagingDeliveryEvidence(error, evidence());"), "the tracking no longer attaches its evidence");

const cliRunnerFile = chunk(/^cli-runner-.*\.mjs$/, "function resolveCliSourceReplyMirror(params) {");
const cliRunner = read(cliRunnerFile);
const mirror = vm.runInNewContext(`(${fn(cliRunner, "function resolveCliSourceReplyMirror(params) {")})`, { buildEmbeddedRunPayloads });
const cliRun = (evidence) => mirror({ evidence, modelId: "sonnet", runParams: { sessionKey: isolated.sessionKey, provider: "claude-cli", agentId: "main", runId: "r" } });
const cliQuiet = cliRun({ heartbeatToolResponse: responseOf("heartbeat_respond", { outcome: "completed", result: accepted }) });
assert.equal(cliQuiet.delivered, true, "the CLI run's response does not replace its final text");
assert.equal(verdict(cliQuiet.payloads).kind, "ack", "a CLI notify=false is not a silent ack");
const cliAlert = cliRun({ heartbeatToolResponse: responseOf("heartbeat_respond", { outcome: "completed", result: alertResult }) });
assert.equal(verdict(cliAlert.payloads).normalized.text, "Disk is full", "a CLI notify=true is not delivered");
const ordinary = cliRun({});
assert.deepEqual(plain(ordinary.payloads), [], "a turn without a response gained payloads");
assert.equal(ordinary.delivered, false, "a turn without a response counts as delivered");

// A CLI failure after an accepted response, through upstream's evidence, failure builder,
// terminal outcome and fallback classifier.
const deliveryFile = chunk(/^delivery-evidence-.*\.mjs$/, "function snapshotCliMessagingDeliveryEvidence(output) {");
const deliveryModule = await import(pathToFileURL(deliveryFile).href);
const attachEvidence = deliveryModule[exportOf(deliveryFile, "attachCliMessagingDeliveryEvidence")];
const readEvidence = deliveryModule[exportOf(deliveryFile, "getCliMessagingDeliveryEvidence")];
const failureNames = ["formatErrorMessage", "resolveExplicitFinalSourceReplyDeliveryEvidence", "shouldClearFailedCliSessionBinding", "projectCliMessagingDeliveryEvidence"];
const warnings = [];
const failureSource = [
  "function resolveCliSourceReplyMirror(params) {",
  "function buildCliExecutionMetadata(context, attempt) {",
  "function buildCliDeliveredFailure(params) {",
  "function openclawNixCliDeliveredFailure(params) {",
].map((signature) => fn(cliRunner, signature)).join("\n");
const buildFailure = vm.runInNewContext(`${failureSource}\nbuildCliDeliveredFailure`, {
  ...await bindImports(cliRunnerFile, cliRunner, failureNames),
  buildEmbeddedRunPayloads,
  cliBackendLog: { warn: (line) => warnings.push(line) },
  Date,
});
const failed = (error, output) => {
  const attached = attachEvidence(error, output);
  const evidence = readEvidence(attached);
  if (!evidence) return { attached };
  return {
    attached,
    result: buildFailure({
      context: { started: Date.now(), modelId: "sonnet", params: { sessionKey: isolated.sessionKey, provider: "claude-cli", agentId: "main", runId: "r" }, preparedBackend: { backend: {} } },
      error: attached, evidence, preparedContextAgentMeta: {}, reusableCliSessionId: undefined, sessionBindingDisabled: false, bindingReplacedDuringRun: false,
    }),
  };
};
const terminalFile = chunk(/^agent-run-terminal-outcome-.*\.mjs$/, "function buildAgentRunTerminalOutcomeFromLifecycleEvent(input) {");
const terminalOutcome = (await import(pathToFileURL(terminalFile).href))[exportOf(terminalFile, "buildAgentRunTerminalOutcomeFromLifecycleEvent")];
const fallbackFile = chunk(/^result-fallback-classifier-.*\.mjs$/, "function classifyEmbeddedAgentRunResultForModelFallback(params) {");
const fallbackFor = (await import(pathToFileURL(fallbackFile).href))[exportOf(fallbackFile, "classifyEmbeddedAgentRunResultForModelFallback")];
const settlesClean = (label, result) => {
  // The run entry's own reading of a result (resolveRunEntryTerminalOutcome).
  assert(read(chunk(/^run-entry-.*\.mjs$/, "function resolveRunEntryTerminalOutcome(params) {")).includes("phase: params.fallbackExhausted || meta.error ? \"error\" : \"end\","), "the run entry reads a result differently");
  const outcome = terminalOutcome({ phase: result.meta.error ? "error" : "end", data: { ...result.meta, error: result.meta.error?.message } });
  assert.equal(outcome.status, "ok", `${label}: the run still counts as failed`);
  assert.equal(outcome.reason, "completed", `${label}: the run still counts as failed`);
  const again = fallbackFor({ result, provider: "claude-cli", model: "sonnet" });
  assert(!again, `${label}: a fallback model would run the heartbeat again: ${JSON.stringify(again)}`);
};
const quietResponse = responseOf("heartbeat_respond", { outcome: "completed", result: accepted });
const alertResponse = responseOf("heartbeat_respond", { outcome: "completed", result: alertResult });
const quietFailure = failed(new Error("overloaded"), { heartbeatToolResponse: quietResponse }).result;
assert(quietFailure, "the accepted response did not survive the CLI failure");
assert.equal(verdict(quietFailure.payloads).kind, "ack", "a silent run turned into a post after a CLI failure");
assert.equal(quietFailure.didSendViaMessagingTool, undefined, "a run that sent nothing claims a message tool send");
settlesClean("notify=false", quietFailure);
assert.equal(quietFailure.meta.executionTrace.attempts[0].result, "error", "the CLI error is gone from the trace");
assert(warnings.some((line) => line.includes("overloaded")), "the CLI error is gone from the log");
const alertFailure = failed(new Error("usage limit"), { heartbeatToolResponse: alertResponse }).result;
assert.equal(verdict(alertFailure.payloads).normalized.text, "Disk is full", "a real alert was lost to a CLI failure");
settlesClean("notify=true", alertFailure);
// The scratch proposal survives it too, and a message tool send stays on the record.
const scratchFailure = failed(new Error("overloaded"), { heartbeatToolResponse: responseOf("heartbeat_respond", { outcome: "completed", result: scratchResult }) }).result;
assert.equal(selectHeartbeatToolResponse(scratchFailure.payloads)?.response?.notify, false);
const sentFailure = failed(new Error("overloaded"), { heartbeatToolResponse: alertResponse, didSendViaMessagingTool: true, messagingToolSentTexts: ["x"] }).result;
assert.equal(sentFailure.didSendViaMessagingTool, true, "a confirmed send was dropped");
settlesClean("with a send", sentFailure);
// A frozen error still carries it, and the failure is upstream's own without a response.
assert(failed(Object.freeze(new Error("overloaded")), { heartbeatToolResponse: quietResponse }).result, "a frozen error lost the response");
const plainFailure = new Error("overloaded");
assert.deepEqual(failed(plainFailure, {}), { attached: plainFailure }, "a failure without a response must stay a failure");
const upstreamFailure = failed(new Error("overloaded"), { didSendViaMessagingTool: true, messagingToolSentTexts: ["x"] }).result;
assert.equal(upstreamFailure.meta.stopReason, "error", "upstream's delivered failure changed");
assert.equal(upstreamFailure.didSendViaMessagingTool, true, "upstream's delivered failure changed");
assert.equal(terminalOutcome({ phase: "end", data: upstreamFailure.meta }).status, "error", "upstream's delivered failure no longer counts as failed");

// 7. Every edit is there once, and the chunks still load.
const receipt = JSON.parse(read(path.join(root, ".heartbeat-respond-run-hotfix.json")));
assert.equal(receipt.id, MARKER);
const expectedMarkers = { [runnerFile]: 3, [scopedFile]: 3, [trackingFile]: 1, [deliveryFile]: 1, [cliRunnerFile]: 2 };
assert.deepEqual([...receipt.patchedFiles].sort(), Object.keys(expectedMarkers).map((file) => path.relative(root, file)).sort());
for (const [file, markers] of Object.entries(expectedMarkers)) {
  assert.equal(read(file).split(MARKER).length - 1, markers, `${path.basename(file)}: expected ${markers} markers`);
  execFileSync(process.execPath, ["--check", file]);
  await import(pathToFileURL(file).href);
}

console.log("heartbeat_respond: accepted, consumed and delivered on heartbeat runs; ordinary turns unchanged");
// Imported gateway modules may keep timers alive.
process.exit(0);
