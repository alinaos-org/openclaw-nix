// sessions_spawn copies the requester's tool policy onto the child: its explicit deny
// list, and (under a restrictive profile such as "coding") the concrete names of the
// requester's own tools. On a host that keeps an MCP server to one agent (codex.agents
// plus a `<server>__*` deny on every other agent), a child that agent's requester
// spawns therefore never gets that server: on 2026-10-30 a DISSECT that main spawned
// had none of its 88 REA tools, while sessions_send to DISSECT's own session had all of
// them. For a cross-agent spawn by the owner, servers the config scopes to the target
// and not to the requester follow the target's policy: their `<server>__*` deny is not
// inherited, and they join an inherited allowlist. Everything else is still inherited,
// and sender-restricted requesters are unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.8"), "spawn target-owned MCP hotfix is qualified from 2026.10.8");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-spawn-target-owned-mcp-v1 */";
const headerBefore = "async function spawnSubagentDirect(params, ctx) {";
const helper = [
  `function openclawNixTargetOwnedMcpToolPolicy(source, cfg, requesterAgentId, targetAgentId) { ${MARKER}`,
  "\tif (!source || source.senderIsOwner !== true || source.inheritedToolPolicySource === \"sender\") return source;",
  "\tconst norm = (id) => String(id ?? \"\").trim().toLowerCase();",
  "\tconst target = norm(targetAgentId), requester = norm(requesterAgentId);",
  "\tif (!target || target === requester) return source;",
  "\tconst servers = cfg?.mcp?.servers;",
  "\tif (!servers || typeof servers !== \"object\") return source;",
  "\tconst owned = Object.entries(servers).filter(([, server]) => {",
  "\t\tconst agents = Array.isArray(server?.codex?.agents) ? server.codex.agents.map(norm) : [];",
  "\t\treturn agents.includes(target) && !agents.includes(requester);",
  "\t}).map(([name]) => `${norm(name)}__*`);",
  "\tif (owned.length === 0) return source;",
  "\tconst deny = Array.isArray(source.inheritedToolDenylist) ? source.inheritedToolDenylist : [];",
  "\tconst allow = Array.isArray(source.inheritedToolAllowlist) ? source.inheritedToolAllowlist : [];",
  "\treturn {",
  "\t\t...source,",
  "\t\tinheritedToolDenylist: deny.filter((entry) => !owned.includes(norm(entry))),",
  "\t\tinheritedToolAllowlist: allow.length > 0 ? [...new Set([...allow, ...owned])] : allow",
  "\t};",
  "}",
].join("\n");

// Hidden children: rewrite the spawn context once the target agent is resolved.
const hiddenBefore = "childDepth, maxSpawnDepth, childIdem } = requestResolution.resolved;\n";
const hiddenAfter = `${hiddenBefore}\tctx = openclawNixTargetOwnedMcpToolPolicy(ctx, cfg, requesterAgentId, targetAgentId); ${MARKER}\n`;
// Visible sessions: the same rule for the policy sent with the session create.
const visibleBefore = [
  "\t\t\tinheritedToolPolicy: {",
  "\t\t\t\tversion: 1,",
  "\t\t\t\tallow: [...params.options?.inheritedToolAllowlist ?? []],",
  "\t\t\t\tdeny: [...params.options?.inheritedToolDenylist ?? []]",
  "\t\t\t},",
].join("\n");
const visibleAfter = [
  `\t\t\tinheritedToolPolicy: ((policy) => ({ ${MARKER}`,
  "\t\t\t\tversion: 1,",
  "\t\t\t\tallow: [...policy?.inheritedToolAllowlist ?? []],",
  "\t\t\t\tdeny: [...policy?.inheritedToolDenylist ?? []]",
  "\t\t\t}))(openclawNixTargetOwnedMcpToolPolicy(params.options, cfg, requesterAgentId, targetAgentId)),",
].join("\n");
const count = (text, needle) => text.split(needle).length - 1;

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  const text = fs.readFileSync(file, "utf8");
  if (count(text, headerBefore) === 0) continue;
  assert.equal(count(text, headerBefore), 1, `spawnSubagentDirect repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, hiddenBefore), 1, `hidden spawn anchor changed in ${name}`);
  assert.equal(count(text, visibleBefore), 1, `visible spawn anchor changed in ${name}`);
  // Both call sites read these names from their own scope; re-derive if they move.
  assert.equal(count(text, "async function maybeSpawnVisibleSession(params) {"), 1, `${name}: visible spawn path moved`);
  assert.equal(count(text, "\tconst targetAgentId = params.requestedAgentId ? normalizeAgentId(params.requestedAgentId) : requesterAgentId;\n"), 1, `${name}: visible target resolution moved`);
  fs.writeFileSync(file, text
    .replace(headerBefore, `${helper}\n${headerBefore}`)
    .replace(hiddenBefore, hiddenAfter)
    .replace(visibleBefore, visibleAfter));
  patchedFiles.push(name);
}
assert.equal(patchedFiles.length, 1, `unexpected spawn chunks: ${patchedFiles.join(", ") || "none"}`);
assert(/^sessions-spawn-tool-.*\.mjs$/.test(patchedFiles[0]), `spawn path found in ${patchedFiles[0]}`);

fs.writeFileSync(path.join(root, ".spawn-target-owned-mcp-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-spawn-target-owned-mcp-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Spawn: target-owned MCP servers follow the target agent in ${patchedFiles.join(", ")}`);
