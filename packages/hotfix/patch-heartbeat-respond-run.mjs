// A heartbeat-enabled agent is offered heartbeat_respond on every turn, and the embedded
// runtime accepts it only when the heartbeat runner asks for it: the runner did so only
// when shouldUseHeartbeatResponseToolPrompt said so, which needs
// messages.[groupChat.]visibleReplies = "message_tool" or, with neither set, the codex
// runtime. With "automatic" (nova's prod and merlin, for ordinary group replies) or with
// no setting on another runtime (rescue), a heartbeat run offered the tool and threw "only
// accepted during a heartbeat run", even during one. That error became an isError payload,
// the heartbeat classifier delivered it, and "Heartbeat Respond failed" went to the
// heartbeat's channel. The codex harness already accepts on any heartbeat trigger, and the
// Claude CLI loopback server never offered the tool at all.
//
// What decides a heartbeat's outcome (buildEmbeddedRunPayloads, selectHeartbeatToolResponse,
// classifyHeartbeatAgentOutcome) reads the recorded response and not the source reply mode,
// so accepting the tool is enough for its result to be used. Edits, all heartbeat-only:
// - the runner enables the tool on every heartbeat run, and asks for
//   sourceReplyDeliveryMode "message_tool_only" only when upstream's setting says so. That
//   mode stays out of it for "automatic": it adds "without the tool the user gets nothing",
//   forces a message tool that needs an explicit target here (a failed send is a terminal
//   tool failure), and the heartbeat's reply goes through the runner's own delivery anyway;
// - an isolated heartbeat run gets upstream's tool prompt, whose fallback keeps plain alert
//   text working. A run on a shared session keeps its prompt, since a Claude CLI turn on a
//   shared session cannot be offered the tool (below);
// - the loopback server offers and accepts the tool on an isolated heartbeat run. Isolated
//   only: each such run starts a new session, whereas adding a tool to one turn of a shared
//   session invalidates its Claude session (prompt-tools) on that turn and on the next;
// - the CLI runner records the accepted response from the loopback call and returns it as
//   the same heartbeat payload an embedded run returns.
// Ordinary turns are untouched: non-heartbeat calls are still refused, and the worker
// bundles' copies stay as they are, since the runner runs on the gateway's main thread.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.11.1"), "heartbeat_respond hotfix is qualified from 2026.11.1");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-heartbeat-respond-run-v1 */";
const count = (text, needle) => text.split(needle).length - 1;
const ownFiles = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs")).map((name) => path.join(dist, name)).filter((file) => !fs.lstatSync(file).isSymbolicLink());
const chunkWith = (label, pattern, needle) => {
  const hits = ownFiles.filter((file) => pattern.test(path.basename(file)) && fs.readFileSync(file, "utf8").includes(needle));
  assert.equal(hits.length, 1, `expected one ${label} chunk, got ${hits.map((f) => path.basename(f)).join(", ") || "none"}`);
  return hits[0];
};
const edit = (file, edits, prepend) => {
  const name = path.basename(file);
  let text = fs.readFileSync(file, "utf8");
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  for (const [before, after] of edits) {
    assert.equal(count(text, before), 1, `anchor changed in ${name}: ${before.slice(0, 80)}`);
    text = text.replace(before, () => after);
  }
  if (prepend) text = `${prepend}\n${text}`;
  fs.writeFileSync(file, text);
  return path.relative(root, file);
};
const assertOrder = (file, ...anchors) => {
  const text = fs.readFileSync(file, "utf8");
  const at = anchors.map((anchor) => text.indexOf(anchor));
  for (let i = 0; i < at.length; i++) assert(at[i] >= 0 && (i === 0 || at[i - 1] < at[i]), `${path.basename(file)}: ${anchors[i].slice(0, 70)} moved`);
  return text.slice(at[0], at[at.length - 1]);
};

// The runner: the tool on every heartbeat run, the source reply mode only as upstream says.
const runnerAnchor = "function shouldUseHeartbeatResponseToolPrompt(params) {";
const runnerFile = chunkWith("heartbeat runner", /^heartbeat-runner-run-.*\.mjs$/, runnerAnchor);
const optionsBefore = [
  "...prepared.usesHeartbeatResponseTool ? {",
  "\t\t\t\t\tenableHeartbeatTool: true,",
  "\t\t\t\t\tforceHeartbeatTool: true,",
  "\t\t\t\t\tsourceReplyDeliveryMode: \"message_tool_only\"",
  "\t\t\t\t} : {},",
].join("\n");
const optionsAfter = [
  `enableHeartbeatTool: true, ${MARKER}`,
  "\t\t\t\tforceHeartbeatTool: true,",
  "\t\t\t\t...prepared.usesHeartbeatResponseTool ? { sourceReplyDeliveryMode: \"message_tool_only\" } : {},",
].join("\n");
const promptBefore = [
  "const resolveRunPrompt = (useHeartbeatResponseTool) => resolveHeartbeatRunPrompt({",
  "\t\tcfg,",
  "\t\theartbeat,",
  "\t\tpreflight,",
  "\t\tcanRelayToUser,",
  "\t\tscheduledTasks,",
  "\t\tuseHeartbeatResponseTool",
  "\t});",
].join("\n");
const promptAfter = [
  `const resolveRunPrompt = (useHeartbeatResponseTool) => ({ ${MARKER}`,
  "\t\t...resolveHeartbeatRunPrompt({",
  "\t\t\tcfg,",
  "\t\t\theartbeat,",
  "\t\t\tpreflight,",
  "\t\t\tcanRelayToUser,",
  "\t\t\tscheduledTasks,",
  "\t\t\tuseHeartbeatResponseTool: useHeartbeatResponseTool || run.kind === \"isolated\"",
  "\t\t}),",
  "\t\tusesHeartbeatResponseTool: useHeartbeatResponseTool",
  "\t});",
].join("\n");
// `run` must be the prepare stage's own, and the prompt flag must still be what the runner
// reads for the source reply mode.
{
  const between = assertOrder(runnerFile, "async function prepareHeartbeatRunStage(wake) {", "const { entry, sessionKey, run, conversationEntry } = preflight.session;", promptBefore);
  assert(!/\n(?:async )?function /.test(between.slice(1)), "the prompt left the prepare stage");
  const text = fs.readFileSync(runnerFile, "utf8");
  assert.equal(count(text, "usesHeartbeatResponseTool: params.useHeartbeatResponseTool,"), 1, "the prompt builder no longer returns its flag");
  assert.equal(count(text, "prepared.usesHeartbeatResponseTool"), 1, "the runner reads the prompt flag somewhere new");
  assert.equal(count(text, "if (run.kind === \"isolated\") {"), 1, "the prepare stage no longer names an isolated run");
}
const patchedFiles = [edit(runnerFile, [[optionsBefore, optionsAfter], [promptBefore, promptAfter]])];

// The loopback server: an isolated heartbeat run's Claude CLI turn gets the tool.
const scopedAnchor = "async function resolveGatewayScopedTools(params, assertPreparationCurrent) {";
const scopedFile = chunkWith("gateway scoped tools", /^tool-resolution-.*\.mjs$/, scopedAnchor);
const alsoAllowBefore = "const runtimeAlsoAllow = sourceReplyDeliveryMode === \"message_tool_only\" ? [\"message\"] : [];";
const alsoAllowAfter = `const runtimeAlsoAllow = [...sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [], ...openclawNixHeartbeatLoopbackRun(params) ? ["heartbeat_respond"] : []]; ${MARKER}`;
const toolOptionsBefore = "const openClawToolOptions = {\n\t\t...commonToolOptions(),";
const toolOptionsAfter = `const openClawToolOptions = {\n\t\t...commonToolOptions(),\n\t\t...openclawNixHeartbeatLoopbackRun(params) ? { enableHeartbeatTool: true, offerHeartbeatTool: true } : {}, ${MARKER}`;
const loopbackHelper = [
  `function openclawNixHeartbeatLoopbackRun(params) { ${MARKER}`,
  "\treturn params.surface === \"loopback\" && params.trigger === \"heartbeat\" && typeof params.sessionKey === \"string\" && params.sessionKey.endsWith(\":heartbeat\");",
  "}",
].join("\n");
{
  // The run's trigger and session key reach this scope through the grant's context.
  chunkWith("CLI MCP grant context", /^mcp-grant-context-.*\.mjs$/, "...params.run.trigger ? { trigger: params.run.trigger } : {},");
  const loopbackScope = "const scopeOptions = {\n\t\t...context,";
  const loopbackFile = chunkWith("loopback scope", /^mcp-http\.runtime-.*\.mjs$/, loopbackScope);
  assertOrder(loopbackFile, loopbackScope, "surface: \"loopback\",", "await resolveGatewayScopedTools(scopeOptions,");
  assertOrder(scopedFile, scopedAnchor, alsoAllowBefore, toolOptionsBefore, "await createOpenClawToolsAsync(openClawToolOptions,");
}
patchedFiles.push(edit(scopedFile, [
  [scopedAnchor, `${loopbackHelper}\n${scopedAnchor}`],
  [alsoAllowBefore, alsoAllowAfter],
  [toolOptionsBefore, toolOptionsAfter],
]));

// The CLI runner: record the accepted response, return it as the heartbeat payload.
const responseChunk = chunkWith("heartbeat tool response", /^heartbeat-tool-response-.*\.mjs$/, "function normalizeHeartbeatToolResponse(value) {");
const alias = /\bnormalizeHeartbeatToolResponse as (\w+)\b/.exec(fs.readFileSync(responseChunk, "utf8"))?.[1];
assert(alias, "the heartbeat tool response chunk no longer exports normalizeHeartbeatToolResponse");
const trackingFile = chunkWith("CLI tool tracking", /^execute\.runtime-.*\.mjs$/, "function createCliToolTracking(context) {");
const spawnsBefore = "const acceptedSessionSpawns = [];";
const recordBefore = "if (acceptedSessionSpawn && acceptedSessionSpawns.length < CLI_LOOPBACK_CORRELATION_MAX_CALLS) acceptedSessionSpawns.push(acceptedSessionSpawn);";
const evidenceBefore = "...current.acceptedSessionSpawns.length > 0 ? { acceptedSessionSpawns: current.acceptedSessionSpawns.slice() } : {}";
const trackingHelper = [
  `function openclawNixHeartbeatResponseOf(toolName, call) { ${MARKER}`,
  "\treturn toolName === \"heartbeat_respond\" && call.outcome === \"completed\" ? openclawNixNormalizeHeartbeatResponse(readToolResultDetails(call.result)) : void 0;",
  "}",
].join("\n");
{
  const text = fs.readFileSync(trackingFile, "utf8");
  assert.equal(count(text, "readToolResultDetails } from "), 1, "the tracking chunk no longer imports readToolResultDetails");
  assert.equal(count(text, "normalizeHeartbeatToolResponse"), 0, "upstream's CLI tracking now knows the heartbeat response (fixed upstream? drop this patch)");
  const region = assertOrder(trackingFile, "function createCliToolTracking(context) {", spawnsBefore, "onToolCallResult: (call) => {", "const toolName = stripOpenClawMcpToolPrefix(call.toolName);", recordBefore, "withExecutionEvidence(output) {", evidenceBefore);
  assert(!/\n(?:async )?function /.test(region.slice(1)), "the CLI tool tracking was split");
}
patchedFiles.push(edit(trackingFile, [
  [spawnsBefore, `${spawnsBefore}\n\tlet openclawNixHeartbeatResponse;`],
  [recordBefore, `${recordBefore}\n\t\t\t\topenclawNixHeartbeatResponse = openclawNixHeartbeatResponseOf(toolName, call) ?? openclawNixHeartbeatResponse;`],
  [evidenceBefore, `${evidenceBefore},\n\t\t\t\t...openclawNixHeartbeatResponse ? { heartbeatToolResponse: openclawNixHeartbeatResponse } : {}`],
  ["function createCliToolTracking(context) {", `${trackingHelper}\nfunction createCliToolTracking(context) {`],
], `import { ${alias} as openclawNixNormalizeHeartbeatResponse } from "./${path.basename(responseChunk)}";`));

const cliRunnerFile = chunkWith("CLI runner", /^cli-runner-.*\.mjs$/, "function resolveCliSourceReplyMirror(params) {");
const mirrorBefore = "messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,\n\t\tsourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,";
const mirrorAfter = `messagingToolSourceReplyPayloads: evidence.messagingToolSourceReplyPayloads,\n\t\theartbeatToolResponse: evidence.heartbeatToolResponse, ${MARKER}\n\t\tsourceReplyDeliveryMode: runParams.sourceReplyDeliveryMode,`;
{
  const text = fs.readFileSync(cliRunnerFile, "utf8");
  // The run's payloads are the mirror's when it has any, and its evidence is the output.
  for (const needed of ["const payloads = sourceReplyMirror.payloads.length > 0 ? sourceReplyMirror.payloads :", "delivered: payloads.length > 0 ||"]) {
    assert.equal(count(text, needed), 1, `CLI result assembly changed: ${needed}`);
  }
  assert.equal(count(text, "function resolveCliSourceReplyMirror(params) {\n\tconst { evidence, modelId, runParams } = params;\n\tconst payloads = buildEmbeddedRunPayloads({"), 1, "the source reply mirror no longer starts by building the run's payloads");
}
patchedFiles.push(edit(cliRunnerFile, [[mirrorBefore, mirrorAfter]]));

fs.writeFileSync(path.join(root, ".heartbeat-respond-run-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-heartbeat-respond-run-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`heartbeat_respond accepted on heartbeat runs: ${patchedFiles.join(", ")}`);
