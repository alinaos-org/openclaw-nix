// Behavioural check for patch-claude-deferred-loopback-tools.mjs on the installed tree:
// on upstream's own loopback server config, a listed agent's entry loses only
// `alwaysLoad` (type, url and headers unchanged, the input untouched), and an unlisted
// agent, a missing agent id or an unset variable keeps upstream's entry; the prepare
// step passes the run's policy agent through the helper exactly once. From 2026.10.7,
// a listed agent's mediated run with no native tools gets ToolSearch as its one native
// tool (the OpenClaw list and the input untouched), every other run keeps its list,
// and the edit sits between bootstrap routing and the MCP grant; the native tool
// permission handler allows exactly that ToolSearch without the exec approval plan.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".claude-deferred-loopback-tools-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-claude-deferred-loopback-tools-v2");
const ENV = receipt.env;
assert.equal(receipt.patchedFiles.length, receipt.toolSearch ? 2 : 1);
const prepareFile = path.join(root, receipt.patchedFiles[0]);
assert.match(path.basename(prepareFile), /^prepare\.runtime-/);
execFileSync(process.execPath, ["--check", prepareFile]);
const prepareText = fs.readFileSync(prepareFile, "utf8");

const start = prepareText.indexOf("function openclawNixClaudeDeferredListed(agentId) {");
const last = prepareText.indexOf("function openclawNixClaudeDeferredToolSearch(params, agentId, eligible) {");
const end = prepareText.indexOf("\n}\n", last);
assert(start >= 0 && last > start && end > last, "helpers missing");
const helpers = prepareText.slice(start, end + 2);
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

const call = (env, expression, scope) => vm.runInNewContext(`${helpers}\n${expression}`, {
  process: { env: env === undefined ? {} : { [ENV]: env } }, ...scope,
});
const loopback = (env, config, agentId) => call(env, "openclawNixClaudeDeferredLoopback(config, agentId)", { config, agentId });
const before = JSON.stringify(upstream);
const deferred = loopback("main-work", upstream, "main-work");
assert(!("alwaysLoad" in deferred.mcpServers.openclaw), "listed agent still always-loads");
const { alwaysLoad: _alwaysLoad, ...rest } = upstream.mcpServers.openclaw;
assert.deepEqual(JSON.parse(JSON.stringify(deferred.mcpServers.openclaw)), JSON.parse(JSON.stringify(rest)), "listed agent's entry changed beyond alwaysLoad");
assert.equal(JSON.stringify(upstream), before, "input config mutated");
assert(!("alwaysLoad" in loopback(" ops , Main-Work ", upstream, "main-work").mcpServers.openclaw), "list not trimmed / case-folded");
const unlisted = [[undefined, "main-work"], ["", "main-work"], ["ops", "main-work"], ["main", "main-work"], [",", "main-work"], ["main-work", undefined], ["main-work", ""]];
for (const [env, agentId] of unlisted) {
  assert.equal(loopback(env, upstream, agentId), upstream, `entry changed with ${ENV}=${JSON.stringify(env)} for agent ${JSON.stringify(agentId)}`);
}
assert.equal(loopback("main-work", undefined, "main-work"), undefined, "no loopback runtime must stay undefined");

const searchCall = "params = openclawNixClaudeDeferredToolSearch(params, policyAgentId, canUseGatewayTools && executionMode === \"agent\" && backendResolved.id === \"claude-cli\");";
if (receipt.toolSearch) {
  const search = (env, params, agentId, eligible = true) => call(env, "openclawNixClaudeDeferredToolSearch(params, agentId, eligible)", { params, agentId, eligible });
  const mediated = () => ({ prompt: "x", cliToolAvailability: { native: [], openClaw: ["read", "exec", "higgsfield__generate_image"] } });
  const run = mediated();
  const runBefore = JSON.stringify(run);
  // The helpers run in another realm: compare plain copies.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const searched = search("creative,main-work", run, "creative");
  assert.deepEqual(plain(searched.cliToolAvailability.native), ["ToolSearch"], "listed agent did not get ToolSearch");
  assert.deepEqual(plain(searched.cliToolAvailability.openClaw), run.cliToolAvailability.openClaw, "OpenClaw tool list changed");
  assert.equal(searched.prompt, "x", "other run parameters lost");
  assert.equal(JSON.stringify(run), runBefore, "input run mutated");
  assert.deepEqual(plain(search(" Ops , CREATIVE ", mediated(), "creative").cliToolAvailability.native), ["ToolSearch"], "list not trimmed / case-folded");
  for (const [env, agentId] of unlisted) {
    const same = mediated();
    assert.equal(search(env, same, agentId), same, `run changed with ${ENV}=${JSON.stringify(env)} for agent ${JSON.stringify(agentId)}`);
  }
  const unchanged = {
    "not eligible (node, system agent, side question or another backend)": [mediated(), false],
    "tools disabled": [{ ...mediated(), disableTools: true }, true],
    "no exact tool list": [{ prompt: "x" }, true],
    "native tools already selected": [{ cliToolAvailability: { native: ["Read"], openClaw: ["exec"] } }, true],
    "no OpenClaw tools": [{ cliToolAvailability: { native: [], openClaw: [] } }, true],
  };
  for (const [label, [params, eligible]] of Object.entries(unchanged)) {
    assert.equal(search("creative", params, "creative", eligible), params, `run changed: ${label}`);
  }
  // Placement: once, directly after the session event policy and before the grant,
  // after bootstrap routing has read the native list.
  assert.equal(prepareText.split(searchCall).length - 1, 1, "ToolSearch call site missing or duplicated");
  const callAt = prepareText.indexOf(searchCall);
  const policyAt = prepareText.indexOf("const sessionEventSourcePolicy = callerToolAuthority.finalizeSessionEventSourcePolicy(params, promptBuildToolsAllow);");
  assert(policyAt >= 0 && prepareText.slice(policyAt, callAt).split("\n").length === 2, "ToolSearch call does not directly follow the session event policy");
  assert(prepareText.indexOf("const hasBootstrapFileAccess =") < callAt, "bootstrap routing would see ToolSearch as file access");
  assert(callAt < prepareText.indexOf("prepareCliMcpGrant(params, {"), "the MCP grant would miss ToolSearch");
  assert(callAt < prepareText.indexOf("baseHash: params.cliToolAvailability ?"), "the prompt hash would miss ToolSearch");

  // The permission handler's approval plan, on the patched line itself.
  const executeFile = path.join(root, receipt.patchedFiles[1]);
  assert.match(path.basename(executeFile), /^execute\.runtime-/);
  execFileSync(process.execPath, ["--check", executeFile]);
  const executeText = fs.readFileSync(executeFile, "utf8");
  assert(!executeText.includes("const plan = resolveCliNativeToolApprovalPlan(permission);"), "upstream approval plan line still present");
  const planLines = executeText.split("\n").filter((line) => line.includes("openclaw-nix-claude-deferred-loopback-tools-v2"));
  assert.equal(planLines.length, 1, "approval plan line missing or duplicated");
  const plan = (toolName, native) => vm.runInNewContext(`${planLines[0].trim()}\nplan`, {
    toolName, run: native === undefined ? {} : { cliToolAvailability: { native, openClaw: ["read"] } },
    permission: {}, resolveCliNativeToolApprovalPlan: () => "deny",
  });
  assert.equal(plan("ToolSearch", ["ToolSearch"]), "allow", "the injected ToolSearch still goes through the exec approval plan");
  for (const [toolName, native] of [["ToolSearch", undefined], ["ToolSearch", []], ["ToolSearch", ["ToolSearch", "Read"]], ["Read", ["ToolSearch"]], ["Bash", ["Bash"]], ["toolsearch", ["toolsearch"]]]) {
    assert.equal(plan(toolName, native), "deny", `exempted ${toolName} with native ${JSON.stringify(native)}`);
  }
} else {
  assert(!prepareText.includes("openclawNixClaudeDeferredToolSearch(params, policyAgentId"), "ToolSearch edit applied before 2026.10.7");
}

console.log(`Claude deferred loopback tools${receipt.toolSearch ? " and ToolSearch" : ""}: helper and call site checks passed for ${receipt.patchedFiles[0]}`);
