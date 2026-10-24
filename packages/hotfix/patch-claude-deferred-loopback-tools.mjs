// Claude CLI runs get OpenClaw's tools from the gateway's loopback MCP server, and
// upstream marks that server `alwaysLoad: true`, so Claude Code puts every tool's full
// schema into every turn instead of deferring it behind ToolSearch as it does for
// other MCP servers. On nova that is 27-39 tools and 30-55K characters of schema per
// turn; a one-word canary on a Merlin lane wrote 78,534 prompt-cache tokens.
//
// One edit, in the CLI runner's prepare step: for an agent listed in
// OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS (comma-separated agent ids), the loopback
// server entry is built without `alwaysLoad`, so Claude Code's default tool search
// defers its tools (the model loads one with ToolSearch, which OpenClaw's Claude
// prompt already describes: "Deferred: ToolSearch `select:mcp__openclaw__<name>`
// first"). Every other agent, and every other consumer of the server config (attach
// grants, the worker bundle), keeps upstream's entry. It is a per-agent trial switch:
// with the variable unset nothing changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.6"), "claude deferred loopback tools hotfix is qualified from 2026.10.6");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-claude-deferred-loopback-tools-v1 */";
const ENV = "OPENCLAW_CLAUDE_DEFERRED_LOOPBACK_AGENTS";
const helper = [
  `function openclawNixClaudeDeferredLoopback(config, agentId) { ${MARKER}`,
  "\tconst id = typeof agentId === \"string\" ? agentId.trim().toLowerCase() : \"\";",
  "\tconst server = config?.mcpServers?.openclaw;",
  `\tif (!id || !server || !(process.env.${ENV} ?? "").split(",").some((entry) => entry.trim().toLowerCase() === id)) return config;`,
  "\tconst { alwaysLoad: _alwaysLoad, ...deferred } = server;",
  "\treturn { ...config, mcpServers: { ...config.mcpServers, openclaw: deferred } };",
  "}",
].join("\n");

const count = (text, needle) => text.split(needle).length - 1;
const ownFiles = (dir, pattern) => fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name)).filter((file) => !fs.lstatSync(file).isSymbolicLink());

const region = "//#region src/agents/cli-runner/prepare.ts";
const policyAgent = "const policyAgentId = resolveSessionAgentIds({";
const callBefore = "const rawLoopbackServerConfig = mcpLoopbackRuntime ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0;";
const callAfter = "const rawLoopbackServerConfig = openclawNixClaudeDeferredLoopback(mcpLoopbackRuntime ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0, policyAgentId);";

const hits = ownFiles(dist, /^prepare\.runtime-.*\.mjs$/).filter((file) => fs.readFileSync(file, "utf8").includes(callBefore));
assert.equal(hits.length, 1, `expected one prepare.runtime chunk building the loopback server config, got ${hits.map((f) => path.basename(f)).join(", ") || "none"}`);
const [file] = hits;
const text = fs.readFileSync(file, "utf8");
assert.equal(count(text, MARKER), 0, `${path.basename(file)} is already patched`);
for (const anchor of [region, policyAgent, callBefore]) assert.equal(count(text, anchor), 1, `anchor changed in ${path.basename(file)}: ${anchor.slice(0, 70)}`);
// The call must sit after policyAgentId's declaration in the same function.
assert(text.indexOf(policyAgent) < text.indexOf(callBefore), "policyAgentId is no longer declared before the loopback server config");
const patched = text.replace(region, `${region}\n${helper}`).replace(callBefore, callAfter);
assert.notEqual(patched, text, `${path.basename(file)} unchanged`);
fs.writeFileSync(file, patched);

const patchedFile = path.relative(root, file);
fs.writeFileSync(path.join(root, ".claude-deferred-loopback-tools-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-claude-deferred-loopback-tools-v1", upstreamVersion: version, env: ENV, patchedFiles: [patchedFile],
}, null, 2) + "\n");
console.log(`Claude deferred loopback tools: ${patchedFile}`);
