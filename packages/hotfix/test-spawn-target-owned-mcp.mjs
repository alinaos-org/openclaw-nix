// Behavioural check for patch-spawn-target-owned-mcp.mjs: the helper releases only
// servers scoped to the target and not the requester, only for an owner's cross-agent
// spawn, and never one a subagent profile denies. Both spawn paths call it: the hidden
// path keeps the parent's execution identity on a rewritten context, and the visible
// path sends the rewritten lists. The patched chunk must still load.
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

const chunk = receipt.patchedFiles[0];
const text = fs.readFileSync(path.join(dist, chunk), "utf8");
assert.equal(text.split(MARKER).length - 1, 3, "helper and both call sites");
assert.equal(text.split("openclawNixTargetOwnedMcpToolPolicy(").length - 1, 3, "helper defined once, called twice");
const start = text.indexOf("function openclawNixTargetOwnedMcpToolPolicy(");
const end = text.indexOf("\n}\n", start);
assert(start >= 0 && end > start, "helper missing");
const policy = vm.runInNewContext(`(${text.slice(start, end + 2)})`);

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
const hiddenLine = text.split("\n").filter((line) => line.includes("const openclawNixNext = openclawNixTargetOwnedMcpToolPolicy("));
assert.equal(hiddenLine.length, 1, "hidden call site");
const hiddenArgs = /openclawNixTargetOwnedMcpToolPolicy\(([\w$]+), ([\w$]+), ([\w$]+), ([\w$]+)(?:, ([\w$]+)\.subagentProfile)?\)/.exec(hiddenLine[0]);
assert(hiddenArgs, "hidden call arguments");
const [, hctx, hcfg, hreq, htarget, hprofileCtx] = hiddenArgs;
if (hprofileCtx !== undefined) assert.equal(hprofileCtx, hctx, "profile read from the spawn context");
const runHidden = (source, requester, target) => {
  const identities = new WeakMap();
  const token = { token: 1 };
  const carried = { ...source };
  identities.set(carried, token);
  const sandbox = {
    openclawNixTargetOwnedMcpToolPolicy: policy, input: carried, cfgIn: cfg, requesterIn: requester, targetIn: target,
    withParentExecutionIdentity: (context, identity) => { if (!identity) return context; const next = { ...context }; identities.set(next, identity); return next; },
    readParentExecutionIdentity: (context) => identities.get(context),
  };
  const result = vm.runInNewContext(`(() => { let ${hctx} = input; const ${hcfg} = cfgIn, ${hreq} = requesterIn, ${htarget} = targetIn;\n${hiddenLine[0]}\nreturn ${hctx}; })()`, sandbox);
  return { carried, result, identity: identities.get(result), token };
};
const rewritten = runHidden(owner, "main", "reverser");
assert.notEqual(rewritten.result, rewritten.carried, "hidden context rewritten");
assert.equal(rewritten.identity, rewritten.token, "hidden context keeps the parent execution identity");
assert.deepEqual(plain(rewritten.result).inheritedToolAllowlist, ["read", "exec", "rea__*"]);
const unchanged = runHidden(owner, "main", "main");
assert.equal(unchanged.result, unchanged.carried, "unchanged hidden context keeps its identity");

// Visible path: evaluate the rewritten inheritedToolPolicy expression with its own names.
const visibleStart = text.indexOf("inheritedToolPolicy: ((openclawNixPolicy) => ({");
assert(visibleStart >= 0, "visible call site");
const visibleEnd = text.indexOf(")),\n", visibleStart);
const visibleExpr = text.slice(visibleStart + "inheritedToolPolicy: ".length, visibleEnd + 2);
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

await import(pathToFileURL(path.join(dist, chunk)).href);
console.log(`Spawn: target-owned MCP servers follow the target agent (${chunk})`);
