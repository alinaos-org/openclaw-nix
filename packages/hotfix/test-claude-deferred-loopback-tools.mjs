// Behavioural check for patch-claude-deferred-loopback-tools.mjs on the installed tree:
// on upstream's own loopback server config, a listed agent's entry loses only
// `alwaysLoad` (type, url and headers unchanged, the input untouched), and an unlisted
// agent, a missing agent id or an unset variable keeps upstream's entry; the prepare
// step passes the run's policy agent through the helper exactly once.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".claude-deferred-loopback-tools-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-claude-deferred-loopback-tools-v1");
const ENV = receipt.env;
assert.equal(receipt.patchedFiles.length, 1);
const prepareFile = path.join(root, receipt.patchedFiles[0]);
execFileSync(process.execPath, ["--check", prepareFile]);
const prepareText = fs.readFileSync(prepareFile, "utf8");

const start = prepareText.indexOf("function openclawNixClaudeDeferredLoopback(config, agentId) {");
const end = prepareText.indexOf("\n}\n", start);
assert(start >= 0 && end > start, "helper missing");
const helper = prepareText.slice(start, end + 2);
assert.equal(prepareText.split("openclawNixClaudeDeferredLoopback(mcpLoopbackRuntime ? createMcpLoopbackServerConfig(mcpLoopbackRuntime.port) : void 0, policyAgentId)").length - 1, 1, "call site not rewritten");
assert(!prepareText.includes("const rawLoopbackServerConfig = mcpLoopbackRuntime ? createMcpLoopbackServerConfig("), "upstream call site still present");

// Upstream's packaged builder, as the prepare step calls it.
const dist = path.join(root, "dist");
const loopbackHits = fs.readdirSync(dist).filter((name) => /^mcp-http\.loopback-runtime-.*\.mjs$/.test(name) && fs.readFileSync(path.join(dist, name), "utf8").includes("function createMcpLoopbackServerConfig(port) {"));
assert.equal(loopbackHits.length, 1, `expected one loopback runtime chunk, got ${loopbackHits.join(", ") || "none"}`);
const loopbackFile = path.join(dist, loopbackHits[0]);
const alias = new RegExp("\\bcreateMcpLoopbackServerConfig as (\\w+)").exec(/export \{([^}]*)\}/.exec(fs.readFileSync(loopbackFile, "utf8"))?.[1] ?? "")?.[1];
assert(alias, "the loopback runtime chunk no longer exports createMcpLoopbackServerConfig");
const createMcpLoopbackServerConfig = (await import(pathToFileURL(loopbackFile).href))[alias];
const upstream = createMcpLoopbackServerConfig(18791);
assert.equal(upstream.mcpServers.openclaw.alwaysLoad, true, "upstream no longer marks the loopback server alwaysLoad (fixed upstream? drop this patch)");

const run = (env, config, agentId) => vm.runInNewContext(`${helper}\nopenclawNixClaudeDeferredLoopback(config, agentId)`, {
  process: { env: env === undefined ? {} : { [ENV]: env } }, config, agentId,
});
const before = JSON.stringify(upstream);
const deferred = run("main-work", upstream, "main-work");
assert(!("alwaysLoad" in deferred.mcpServers.openclaw), "listed agent still always-loads");
const { alwaysLoad: _alwaysLoad, ...rest } = upstream.mcpServers.openclaw;
assert.deepEqual(JSON.parse(JSON.stringify(deferred.mcpServers.openclaw)), JSON.parse(JSON.stringify(rest)), "listed agent's entry changed beyond alwaysLoad");
assert.equal(JSON.stringify(upstream), before, "input config mutated");
assert(!("alwaysLoad" in run(" ops , Main-Work ", upstream, "main-work").mcpServers.openclaw), "list not trimmed / case-folded");
for (const [env, agentId] of [[undefined, "main-work"], ["", "main-work"], ["ops", "main-work"], ["main", "main-work"], [",", "main-work"], ["main-work", undefined], ["main-work", ""]]) {
  assert.equal(run(env, upstream, agentId), upstream, `entry changed with ${ENV}=${JSON.stringify(env)} for agent ${JSON.stringify(agentId)}`);
}
assert.equal(run("main-work", undefined, "main-work"), undefined, "no loopback runtime must stay undefined");

console.log(`Claude deferred loopback tools: helper and call site checks passed for ${receipt.patchedFiles[0]}`);
