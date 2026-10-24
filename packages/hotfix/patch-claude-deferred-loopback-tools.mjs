// Claude CLI runs get OpenClaw's tools from the gateway's loopback MCP server, and
// upstream marks that server `alwaysLoad: true`, so Claude Code puts every tool's full
// schema into every turn instead of deferring it behind ToolSearch as it does for
// other MCP servers. On nova that is 27-39 tools and 30-55K characters of schema per
// turn; a one-word canary on a Merlin lane wrote 78,534 prompt-cache tokens. From
// 2026.10.7 every configured MCP server's tools ride on the same server (ordinary
// Claude turns are mediated), so a turn can carry hundreds of tools.
//
// For an agent listed in OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS (comma-separated
// agent ids), two edits in the CLI runner's prepare step:
// - the loopback server entry is built without `alwaysLoad`, so Claude Code's default
//   tool search defers its tools (the model loads one with ToolSearch, which
//   OpenClaw's Claude prompt already describes: "Deferred: ToolSearch
//   `select:mcp__openclaw__<name>` first");
// - from 2026.10.7, a mediated run whose native tool list is empty gets Claude Code's
//   ToolSearch as its one native tool. 10.7 starts Claude with `--tools ""`, which
//   removes ToolSearch, and Claude Code defers nothing without it (it sends every
//   tool inline). The run's own list changes, not only the argv, because OpenClaw's
//   permission hook denies any native tool missing from that list. ToolSearch maps to
//   no OpenClaw capability and only loads tools the run already has. The edit comes
//   after bootstrap routing reads the list for file access and before the MCP grant,
//   the prompt hash and the argv take it;
// - from 2026.10.7, the native tool permission handler allows that ToolSearch without
//   the exec approval plan (after the before_tool_call hook): a read-only, guarded,
//   workspace, allowlist or sandboxed session would otherwise deny it or ask for an
//   approval on every search, and with its tools deferred the agent could load none.
// Neither edit defers anything alone: with `alwaysLoad` kept, Claude Code drops
// ToolSearch again. Every other agent, and every other consumer of the server config
// (attach grants, the worker bundle), keeps upstream's behaviour. It is a per-agent
// trial switch: with the variable unset nothing changes. A resumed Claude session
// defers from its next turn: OpenClaw starts Claude without the native prompt snapshot,
// which is what would keep tool search off in a conversation that ran without it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.6"), "claude deferred loopback tools hotfix is qualified from 2026.10.6");
// 2026.10.6 sends no --tools on ordinary turns, so ToolSearch is already there.
const toolSearch = atLeast(version, "2026.10.7");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-claude-deferred-loopback-tools-v2 */";
const ENV = "OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS";
const helpers = [
  `function openclawNixClaudeDeferredListed(agentId) { ${MARKER}`,
  "\tconst id = typeof agentId === \"string\" ? agentId.trim().toLowerCase() : \"\";",
  `\treturn id !== "" && (process.env.${ENV} ?? "").split(",").some((entry) => entry.trim().toLowerCase() === id);`,
  "}",
  "function openclawNixClaudeDeferredLoopback(config, agentId) {",
  "\tconst server = config?.mcpServers?.openclaw;",
  "\tif (!server || !openclawNixClaudeDeferredListed(agentId)) return config;",
  "\tconst { alwaysLoad: _alwaysLoad, ...deferred } = server;",
  "\treturn { ...config, mcpServers: { ...config.mcpServers, openclaw: deferred } };",
  "}",
  "function openclawNixClaudeDeferredToolSearch(params, agentId, eligible) {",
  "\tconst availability = params.cliToolAvailability;",
  "\tif (!eligible || params.disableTools === true || !availability || availability.native.length !== 0 || availability.openClaw.length === 0) return params;",
  "\tif (!openclawNixClaudeDeferredListed(agentId)) return params;",
  "\treturn { ...params, cliToolAvailability: { native: [\"ToolSearch\"], openClaw: availability.openClaw } };",
  "}",
].join("\n");

const count = (text, needle) => text.split(needle).length - 1;
const ownFiles = (dir, pattern) => fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name)).filter((file) => !fs.lstatSync(file).isSymbolicLink());

const region = "//#region src/agents/cli-runner/prepare.ts";
const policyAgent = "const policyAgentId = resolveSessionAgentIds({";
const callBefore = "const rawLoopbackServerConfig = mcpLoopbackRuntime ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0;";
const callAfter = "const rawLoopbackServerConfig = openclawNixClaudeDeferredLoopback(mcpLoopbackRuntime ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0, policyAgentId);";
// ToolSearch: only agent-mode Claude CLI runs on the gateway's own tools (not on a
// node, not a system-agent run, not a skipped turn preparation).
const executionMode = "const executionMode = params.executionMode ?? \"agent\";";
const backend = "const backendResolved = resolveCliBackendConfig(";
const gatewayTools = "const canUseGatewayTools = !nodeClaudePlacement && !skipsTurnPreparation && !systemAgentMcpConfig;";
const bootstrapAccess = "const hasBootstrapFileAccess =";
const searchBefore = "const sessionEventSourcePolicy = callerToolAuthority.finalizeSessionEventSourcePolicy(params, promptBuildToolsAllow);";
const searchCall = "\n\t\tparams = openclawNixClaudeDeferredToolSearch(params, policyAgentId, canUseGatewayTools && executionMode === \"agent\" && backendResolved.id === \"claude-cli\");";
const grant = "const { mcpGrant, projectNativeToolAuthority, exclusiveTools } = prepareCliMcpGrant(params, {";
// The permission handler: exactly the list the edit above writes, so the exemption
// cannot reach a native tool upstream selected.
const handler = "function createPluginToolPermissionHandler(params) {";
const planBefore = "const plan = resolveCliNativeToolApprovalPlan(permission);";
const planAfter = `const plan = toolName === "ToolSearch" && run.cliToolAvailability?.native.length === 1 && run.cliToolAvailability.native[0] === "ToolSearch" ? "allow" ${MARKER} : resolveCliNativeToolApprovalPlan(permission);`;

const hits = ownFiles(dist, /^prepare\.runtime-.*\.mjs$/).filter((file) => fs.readFileSync(file, "utf8").includes(callBefore));
assert.equal(hits.length, 1, `expected one prepare.runtime chunk building the loopback server config, got ${hits.map((f) => path.basename(f)).join(", ") || "none"}`);
const [file] = hits;
const text = fs.readFileSync(file, "utf8");
assert.equal(count(text, "openclaw-nix-claude-deferred-loopback-tools-"), 0, `${path.basename(file)} is already patched`);
const anchors = [region, policyAgent, callBefore, ...(toolSearch ? [executionMode, backend, gatewayTools, bootstrapAccess, searchBefore, grant] : [])];
for (const anchor of anchors) assert.equal(count(text, anchor), 1, `anchor changed in ${path.basename(file)}: ${anchor.slice(0, 70)}`);
// Every use must sit after its inputs in the same function: policyAgentId for both
// calls; for ToolSearch, executionMode and canUseGatewayTools, then bootstrap
// routing (it reads the native list as file access), then the edit, then the grant.
const at = (anchor) => text.indexOf(anchor);
assert(at(policyAgent) < at(callBefore), "policyAgentId is no longer declared before the loopback server config");
if (toolSearch) {
  assert(at(region) < at(executionMode) && at(executionMode) < at(policyAgent), "executionMode moved");
  assert(at(executionMode) < at(backend) && at(backend) < at(searchBefore), "backendResolved moved");
  assert(at(policyAgent) < at(gatewayTools) && at(gatewayTools) < at(bootstrapAccess), "canUseGatewayTools moved");
  assert(at(bootstrapAccess) < at(searchBefore), "bootstrap routing no longer precedes the session event policy");
  assert.equal(text.slice(at(searchBefore) + searchBefore.length).trimStart().indexOf(grant), 0, "the MCP grant no longer directly follows the session event policy");
  assert(at(searchBefore) < at(callBefore), "the loopback server config is built before the native tool list is final");
  // No function boundary between the inputs and the edit.
  assert(!/\n(?:async )?function /.test(text.slice(at(executionMode), at(callBefore))), "the prepare step was split into several functions");
}
let patched = text.replace(region, `${region}\n${helpers}`).replace(callBefore, callAfter);
if (toolSearch) patched = patched.replace(searchBefore, `${searchBefore}${searchCall}`);
assert.notEqual(patched, text, `${path.basename(file)} unchanged`);
fs.writeFileSync(file, patched);
const patchedFiles = [path.relative(root, file)];

if (toolSearch) {
  const handlers = ownFiles(dist, /^execute\.runtime-.*\.mjs$/).filter((name) => fs.readFileSync(name, "utf8").includes(handler));
  assert.equal(handlers.length, 1, `expected one execute.runtime chunk with the native tool permission handler, got ${handlers.map((f) => path.basename(f)).join(", ") || "none"}`);
  const [executeFile] = handlers;
  const executeText = fs.readFileSync(executeFile, "utf8");
  for (const anchor of [handler, planBefore]) assert.equal(count(executeText, anchor), 1, `anchor changed in ${path.basename(executeFile)}: ${anchor.slice(0, 70)}`);
  // The plan line must sit in that handler, after its availability check and the
  // before_tool_call hook, and its names must still mean the run and the tool.
  const body = executeText.slice(executeText.indexOf(handler), executeText.indexOf(planBefore));
  assert(!/\n(?:async )?function /.test(body.slice(handler.length)), "the approval plan left the permission handler");
  for (const needed of ["const run = params.context.params;", "const toolName = request.toolName.trim();", "!run.cliToolAvailability.native.includes(toolName)) return denyTool(", "await runBeforeToolCallHook({"]) {
    assert.equal(count(body, needed), 1, `permission handler changed before the approval plan: ${needed}`);
  }
  fs.writeFileSync(executeFile, executeText.replace(planBefore, planAfter));
  patchedFiles.push(path.relative(root, executeFile));
}
const patchedFile = patchedFiles.join(", ");
fs.writeFileSync(path.join(root, ".claude-deferred-loopback-tools-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-claude-deferred-loopback-tools-v2", upstreamVersion: version, env: ENV, toolSearch, patchedFiles,
}, null, 2) + "\n");
console.log(`Claude deferred loopback tools${toolSearch ? " and ToolSearch" : ""}: ${patchedFile}`);
