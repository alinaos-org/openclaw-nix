// Behavioural check for patch-spawn-target-owned-mcp.mjs: the helper releases only
// servers scoped to the target and not the requester, only for an owner's cross-agent
// spawn, and both spawn paths call it. The patched chunk must still load.
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

await import(pathToFileURL(path.join(dist, chunk)).href);
console.log(`Spawn: target-owned MCP servers follow the target agent (${chunk})`);
