// Behavioural check for patch-spawn-target-owned-mcp.mjs: the helper releases only
// servers scoped to the target and not the requester, only for an owner's cross-agent
// spawn, and never one a subagent profile denies. Both spawn paths call it: the hidden
// path keeps the parent's execution identity on a rewritten context, and the visible
// path sends the rewritten lists. The patched chunks must still load.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const dist = path.join(root, "dist");
const MARKER = "/* openclaw-nix-spawn-target-owned-mcp-v1 */";
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".spawn-target-owned-mcp-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-spawn-target-owned-mcp-v1");

// One chunk holds both paths up to 2026.11.5; from 2026.11.6 the hidden and visible
// paths are separate chunks, each with its own copy of the helper.
const chunks = receipt.patchedFiles;
assert(chunks.length === 1 || chunks.length === 2, `patched chunks: ${chunks.join(", ")}`);
const texts = new Map(chunks.map((chunk) => [chunk, fs.readFileSync(path.join(dist, chunk), "utf8")]));
const occurrences = (needle) => [...texts.values()].reduce((sum, text) => sum + text.split(needle).length - 1, 0);
assert.equal(occurrences(MARKER), chunks.length + 2, "helper per chunk and both call sites");
assert.equal(occurrences("openclawNixTargetOwnedMcpToolPolicy("), chunks.length + 2, "helper defined once per chunk, called twice");
const helpers = [...texts.values()].map((text) => {
  const start = text.indexOf("function openclawNixTargetOwnedMcpToolPolicy(");
  const end = text.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, "helper missing");
  return text.slice(start, end + 2);
});
assert(helpers.every((helper) => helper === helpers[0]), "helper copies differ");
const policy = vm.runInNewContext(`(${helpers[0]})`);
const siteChunk = (needle, what) => {
  const found = chunks.filter((chunk) => texts.get(chunk).includes(needle));
  assert.equal(found.length, 1, `${what} chunk`);
  return found[0];
};

const cfg = { mcp: { servers: {
  rea: { codex: { agents: ["reverser"] } },
  robinhood: { codex: { agents: ["finance"] } },
  stitch: { codex: { agents: ["coder", "creative"] } },
  shared: { codex: { agents: ["main", "reverser"] } },
  linear: {},
} } };
const deny = ["robinhood__*", "rea__*", "stitch__*", "shared__*", "browser"];
const owner = { senderIsOwner: true, inheritedToolAllowlist: ["read", "exec"], inheritedToolDenylist: deny, keep: 1 };
const plain = (value) => JSON.parse(JSON.stringify(value));

// main -> reverser: rea released and allowed; every other deny stays.
const child = plain(policy(owner, cfg, "main", "reverser"));
assert.deepEqual(child.inheritedToolDenylist, ["robinhood__*", "stitch__*", "shared__*", "browser"]);
assert.deepEqual(child.inheritedToolAllowlist, ["read", "exec", "rea__*"]);
assert.equal(child.keep, 1);
assert.deepEqual(owner.inheritedToolDenylist, deny, "source is not mutated");
// A server shared with the requester is the requester's to pass on: unchanged.
assert.deepEqual(plain(policy(owner, cfg, "main", "creative")).inheritedToolDenylist, ["robinhood__*", "rea__*", "shared__*", "browser"]);
// An unrestricted requester (no inherited allowlist) gains no allowlist.
assert.deepEqual(plain(policy({ ...owner, inheritedToolAllowlist: [] }, cfg, "main", "finance")).inheritedToolAllowlist, []);
// Unchanged: same agent, non-owner, sender-restricted, no scoped servers, no source.
for (const [source, requester, target] of [
  [owner, "main", "main"],
  [{ ...owner, senderIsOwner: false }, "main", "reverser"],
  [{ ...owner, inheritedToolPolicySource: "sender" }, "main", "reverser"],
  [owner, "main", "ops"],
]) assert.equal(policy(source, cfg, requester, target), source);
assert.equal(policy(undefined, cfg, "main", "reverser"), undefined);
assert.equal(policy(owner, {}, "main", "reverser"), owner);
// A subagent profile's deny stays: a server it denies is not released.
assert.equal(policy(owner, cfg, "main", "reverser", { deny: ["REA__*"] }), owner);
assert.deepEqual(plain(policy(owner, cfg, "main", "reverser", { deny: ["browser"] })).inheritedToolDenylist, ["robinhood__*", "stitch__*", "shared__*", "browser"]);

// Hidden path: run the injected line with its own names and a WeakMap identity carrier.
const hiddenChunk = siteChunk("const openclawNixNext = openclawNixTargetOwnedMcpToolPolicy(", "hidden call site");
const hiddenText = texts.get(hiddenChunk);
const hiddenLine = hiddenText.split("\n").filter((line) => line.includes("const openclawNixNext = openclawNixTargetOwnedMcpToolPolicy("));
assert.equal(hiddenLine.length, 1, "hidden call site");
const hiddenArgs = /openclawNixTargetOwnedMcpToolPolicy\(([\w$]+), ([\w$]+), ([\w$]+), ([\w$]+)(?:, ([\w$]+)\.subagentProfile)?\)/.exec(hiddenLine[0]);
assert(hiddenArgs, "hidden call arguments");
const [, hctx, hcfg, hreq, htarget, hprofileCtx] = hiddenArgs;
if (hprofileCtx !== undefined) assert.equal(hprofileCtx, hctx, "profile read from the spawn context");
// The line runs with the identity carrier the hidden chunk itself imports: both halves
// must come from one module export pair, or the rewritten context would lose the token.
const importedFrom = (local) => {
  const found = [...hiddenText.matchAll(/^import \{([^}\n]*)\} from "([^"\n]+)";$/gm)].flatMap((match) =>
    match[1].split(",").map((entry) => entry.trim().split(/\s+as\s+/)).filter((parts) => (parts[1] ?? parts[0]) === local).map(([exported]) => ({ exported, spec: match[2] })));
  assert.equal(found.length, 1, `hidden chunk imports ${local}`);
  return found[0];
};
const readImport = importedFrom("readParentExecutionIdentity"), writeImport = importedFrom("withParentExecutionIdentity");
assert.equal(writeImport.spec, readImport.spec, "parent execution identity halves come from one module");
const carrier = await import(pathToFileURL(path.join(dist, readImport.spec)).href);
const withParentExecutionIdentity = carrier[writeImport.exported], readParentExecutionIdentity = carrier[readImport.exported];
assert.equal(typeof withParentExecutionIdentity, "function", "withParentExecutionIdentity export");
assert.equal(typeof readParentExecutionIdentity, "function", "readParentExecutionIdentity export");
const runHidden = (source, requester, target) => {
  const token = { token: 1 };
  const carried = withParentExecutionIdentity({ ...source }, token);
  assert.equal(readParentExecutionIdentity(carried), token, "carrier round trip");
  const sandbox = {
    openclawNixTargetOwnedMcpToolPolicy: policy, input: carried, cfgIn: cfg, requesterIn: requester, targetIn: target,
    withParentExecutionIdentity, readParentExecutionIdentity,
  };
  const result = vm.runInNewContext(`(() => { let ${hctx} = input; const ${hcfg} = cfgIn, ${hreq} = requesterIn, ${htarget} = targetIn;\n${hiddenLine[0]}\nreturn ${hctx}; })()`, sandbox);
  return { carried, result, identity: readParentExecutionIdentity(result), token };
};
const rewritten = runHidden(owner, "main", "reverser");
assert.notEqual(rewritten.result, rewritten.carried, "hidden context rewritten");
assert.equal(rewritten.identity, rewritten.token, "hidden context keeps the parent execution identity");
assert.deepEqual(plain(rewritten.result).inheritedToolAllowlist, ["read", "exec", "rea__*"]);
const unchanged = runHidden(owner, "main", "main");
assert.equal(unchanged.result, unchanged.carried, "unchanged hidden context keeps its identity");

// Visible path: evaluate the rewritten inheritedToolPolicy expression with its own names.
const visibleText = texts.get(siteChunk("inheritedToolPolicy: ((openclawNixPolicy) => ({", "visible call site"));
const visibleStart = visibleText.indexOf("inheritedToolPolicy: ((openclawNixPolicy) => ({");
const visibleEnd = visibleText.indexOf(")),\n", visibleStart);
const visibleExpr = visibleText.slice(visibleStart + "inheritedToolPolicy: ".length, visibleEnd + 2);
const visibleArgs = /openclawNixTargetOwnedMcpToolPolicy\(([\w$]+)\.options, ([\w$]+), ([\w$]+), ([\w$]+)\)\)$/.exec(visibleExpr);
assert(visibleArgs, "visible call arguments");
const delegatedName = /\.\.\.([\w$]+) \? \{ delegatedToolPolicy(?:: \1)? \} : \{\}/.exec(visibleExpr)?.[1];
assert(delegatedName, "visible delegated tool policy kept");
const [, vparams, vcfg, vreq, vtarget] = visibleArgs;
const visible = (delegatedValue) => plain(vm.runInNewContext(`(() => { const ${vparams} = { options: optionsIn }, ${vcfg} = cfgIn, ${vreq} = "main", ${vtarget} = "reverser", ${delegatedName} = delegatedIn; return ${visibleExpr}; })()`, {
  openclawNixTargetOwnedMcpToolPolicy: policy, optionsIn: owner, cfgIn: cfg, delegatedIn: delegatedValue,
}));
assert.deepEqual(visible(undefined), { version: 1, allow: ["read", "exec", "rea__*"], deny: ["robinhood__*", "stitch__*", "shared__*", "browser"] });
assert.deepEqual(visible({ deny: [] }).delegatedToolPolicy, { deny: [] });

for (const chunk of chunks) await import(pathToFileURL(path.join(dist, chunk)).href);
console.log(`Spawn: target-owned MCP servers follow the target agent (${chunks.join(", ")})`);
