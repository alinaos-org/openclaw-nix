// Behavioural check for patch-heartbeat-respond-run.mjs, on the tree's own code. It follows
// one response from the runner's options to the classifier's verdict, with upstream's
// packaged tool, payload builder, response selector and classifier:
// - every heartbeat run enables the tool; the source reply mode still follows
//   shouldUseHeartbeatResponseToolPrompt, which still says no for "automatic";
// - with the tool enabled a call is accepted, and without it (an ordinary turn) refused;
// - notify=false classifies as a silent ack, notify=true as one delivery of its text, with
//   no warning payload, under "automatic" and with no source reply mode;
// - without the tool, plain alert text is still delivered, and HEARTBEAT_OK and NO_REPLY
//   stay silent;
// - isolated runs get the tool prompt and keep the mode decision; shared ones keep theirs;
// - the Claude CLI path: only an isolated heartbeat run's loopback turn gets the tool, its
//   accepted result is recorded, and the run returns the embedded run's payload.
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
const options = (usesHeartbeatResponseTool) => vm.runInNewContext(`({${optionsSource}})`, { prepared: { usesHeartbeatResponseTool }, heartbeat: {} });
assert.equal(options(false).enableHeartbeatTool, true, "a heartbeat run under \"automatic\" does not enable heartbeat_respond");
assert.equal(options(false).forceHeartbeatTool, true, "a heartbeat run under \"automatic\" does not force heartbeat_respond");
assert.equal(options(false).sourceReplyDeliveryMode, undefined, "\"automatic\" must not become a tool-only source reply mode");
assert.deepEqual(plain(options(true)), { enableHeartbeatTool: true, forceHeartbeatTool: true, sourceReplyDeliveryMode: "message_tool_only" }, "upstream's message_tool path changed");

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
const prompt = (kind, decision) => vm.runInNewContext(`(() => { ${promptSource}; return resolveRunPrompt(decision); })()`, {
  decision, run: { kind }, cfg: {}, heartbeat: {}, preflight: {}, canRelayToUser: true, scheduledTasks: [],
  resolveHeartbeatRunPrompt: (params) => ({ prompt: params.useHeartbeatResponseTool ? "tool" : "plain", usesHeartbeatResponseTool: params.useHeartbeatResponseTool }),
});
assert.deepEqual(plain(prompt("isolated", false)), { prompt: "tool", usesHeartbeatResponseTool: false }, "an isolated run must get the tool prompt without the tool-only mode");
assert.deepEqual(plain(prompt("isolated", true)), { prompt: "tool", usesHeartbeatResponseTool: true });
assert.deepEqual(plain(prompt("session", false)), { prompt: "plain", usesHeartbeatResponseTool: false }, "a run on a shared session keeps its prompt");
assert.deepEqual(plain(prompt("session", true)), { prompt: "tool", usesHeartbeatResponseTool: true });

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
const recordLine = "openclawNixHeartbeatResponse = openclawNixHeartbeatResponseOf(toolName, call) ?? openclawNixHeartbeatResponse;";
assert.equal(trackingBody.split(recordLine).length - 1, 1, "the loopback result is not recorded");
assert(trackingBody.indexOf("onToolCallResult: (call) => {") < trackingBody.indexOf(recordLine) && trackingBody.indexOf(recordLine) < trackingBody.indexOf("withExecutionEvidence(output) {"), "the record line moved");
assert.equal(trackingBody.split("...openclawNixHeartbeatResponse ? { heartbeatToolResponse: openclawNixHeartbeatResponse } : {}").length - 1, 1, "the attempt's output does not carry the response");

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

// 7. Every edit is there once, and the chunks still load.
const receipt = JSON.parse(read(path.join(root, ".heartbeat-respond-run-hotfix.json")));
assert.equal(receipt.id, MARKER);
const expectedMarkers = { [runnerFile]: 2, [scopedFile]: 3, [trackingFile]: 1, [cliRunnerFile]: 1 };
assert.deepEqual([...receipt.patchedFiles].sort(), Object.keys(expectedMarkers).map((file) => path.relative(root, file)).sort());
for (const [file, markers] of Object.entries(expectedMarkers)) {
  assert.equal(read(file).split(MARKER).length - 1, markers, `${path.basename(file)}: expected ${markers} markers`);
  execFileSync(process.execPath, ["--check", file]);
  await import(pathToFileURL(file).href);
}

console.log("heartbeat_respond: accepted, consumed and delivered on heartbeat runs; ordinary turns unchanged");
// Imported gateway modules may keep timers alive.
process.exit(0);
