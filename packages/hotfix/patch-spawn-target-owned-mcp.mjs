// sessions_spawn copies the requester's tool policy onto the child: its explicit deny
// list, and (under a restrictive profile such as "coding") the concrete names of the
// requester's own tools. On a host that keeps an MCP server to one agent (codex.agents
// plus a `<server>__*` deny on every other agent), a child that agent's requester
// spawns therefore never gets that server: on 2026-10-30 a DISSECT that main spawned
// had none of its 88 REA tools, while sessions_send to DISSECT's own session had all of
// them. For a cross-agent spawn by the owner, servers the config scopes to the target
// and not to the requester follow the target's policy: their `<server>__*` deny is not
// inherited, and they join an inherited allowlist. Everything else is still inherited,
// and sender-restricted requesters are unchanged. From 2026.11.5 a plugin subagent
// profile may add denies before the spawn; a server the profile denies stays denied.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.8"), "spawn target-owned MCP hotfix is qualified from 2026.10.8");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-spawn-target-owned-mcp-v1 */";
const headerBefore = "async function spawnSubagentDirect(";
const helper = [
  `function openclawNixTargetOwnedMcpToolPolicy(source, cfg, requesterAgentId, targetAgentId, profile) { ${MARKER}`,
  "\tif (!source || source.senderIsOwner !== true || source.inheritedToolPolicySource === \"sender\") return source;",
  "\tconst norm = (id) => String(id ?? \"\").trim().toLowerCase();",
  "\tconst target = norm(targetAgentId), requester = norm(requesterAgentId);",
  "\tif (!target || target === requester) return source;",
  "\tconst servers = cfg?.mcp?.servers;",
  "\tif (!servers || typeof servers !== \"object\") return source;",
  "\tconst kept = Array.isArray(profile?.deny) ? profile.deny.map(norm) : [];",
  "\tconst owned = Object.entries(servers).filter(([, server]) => {",
  "\t\tconst agents = Array.isArray(server?.codex?.agents) ? server.codex.agents.map(norm) : [];",
  "\t\treturn agents.includes(target) && !agents.includes(requester);",
  "\t}).map(([name]) => `${norm(name)}__*`).filter((entry) => !kept.includes(entry));",
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

// Hidden children: rewrite the spawn context once the target agent is resolved. The
// context also carries the parent's execution identity in a WeakMap keyed by the
// context object, so a rewritten context carries it over.
const hiddenLine = ({ ctx, cfg, requester, target, profile }) =>
  `\t{ const openclawNixNext = openclawNixTargetOwnedMcpToolPolicy(${ctx}, ${cfg}, ${requester}, ${target}${profile ? `, ${profile}` : ""}); ` +
  `if (openclawNixNext !== ${ctx}) ${ctx} = withParentExecutionIdentity(openclawNixNext, readParentExecutionIdentity(${ctx})); } ${MARKER}\n`;
// Visible sessions: the same rule for the policy sent with the session create.
// From 2026.10.10 the policy also carries upstream's delegated tool policy (the
// operator's subagents.delegateToolsTo grant), which is kept as it is.
const delegated = atLeast(version, "2026.10.10");
const visiblePolicy = ({ params, delegatedName }, rewritten) => [
  rewritten ? `\t\t\tinheritedToolPolicy: ((openclawNixPolicy) => ({ ${MARKER}` : "\t\t\tinheritedToolPolicy: {",
  "\t\t\t\tversion: 1,",
  `\t\t\t\tallow: [...${rewritten ? "openclawNixPolicy" : `${params}.options`}?.inheritedToolAllowlist ?? []],`,
  ...delegated ? [
    `\t\t\t\tdeny: [...${rewritten ? "openclawNixPolicy" : `${params}.options`}?.inheritedToolDenylist ?? []],`,
    delegatedName === "delegatedToolPolicy" ? "\t\t\t\t...delegatedToolPolicy ? { delegatedToolPolicy } : {}" : `\t\t\t\t...${delegatedName} ? { delegatedToolPolicy: ${delegatedName} } : {}`,
  ] : [`\t\t\t\tdeny: [...${rewritten ? "openclawNixPolicy" : `${params}.options`}?.inheritedToolDenylist ?? []]`],
  rewritten ? "\t\t\t}))(" : "\t\t\t},",
].join("\n");
const visibleAfter = (names) => `${visiblePolicy(names, true)}openclawNixTargetOwnedMcpToolPolicy(${names.params}.options, ${names.cfg}, ${names.requester}, ${names.target})),`;
const count = (text, needle) => text.split(needle).length - 1;

// From 2026.11.5 upstream's build mangles local names (tsdown `mangle`, keepNames), and
// spawnSubagentDirect(input, context) first applies a plugin subagent profile into a
// const ctx. The anchors below then capture the mangled names: `@name@` is one
// identifier, the same name wherever it repeats, and `@@` is any text on that line.
// The profile line's const becomes a let so the hidden path can rewrite the context.
const mangled = atLeast(version, "2026.11.5");
const ident = "[A-Za-z_$][\\w$]*";
const pattern = (literal) => {
  const seen = new Set();
  return new RegExp(literal.split(/(@\w*@)/).map((part) => {
    const name = /^@(\w*)@$/.exec(part)?.[1];
    if (name === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name === "") return "[^\\n]*?";
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>${ident})`;
  }).join(""), "g");
};
const once = (text, literal, what) => {
  const hits = [...text.matchAll(pattern(literal))];
  assert.equal(hits.length, 1, `${what}: ${hits.length} matches`);
  return hits[0];
};
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A name the visible call site reads must not be redeclared between its declaration
// and the call site (conservative: a closed inner scope also refuses).
const assertNotRedeclared = (slice, names, where) => {
  for (const name of names) {
    const n = escapeRe(name);
    const bound = [
      new RegExp(`\\b(?:const|let|var)\\s+${n}(?![\\w$])`),
      new RegExp(`\\b(?:const|let|var)\\s*[{[][^\\n=]*?[\\s:{,[]${n}\\s*[,}\\]]`),
      new RegExp(`(?:^|[^\\w$.])${n}\\s*=>`),
      new RegExp(`\\(([^()\\n]*[\\s,(])?${n}(\\s*[,=][^()\\n]*)?\\)\\s*=>`),
      new RegExp(`\\bfunction\\b[^(\\n]*\\(([^)\\n]*[\\s,(])?${n}(?![\\w$])[^)\\n]*\\)`),
      new RegExp(`\\bcatch\\s*\\(\\s*${n}\\s*\\)`),
    ].find((re) => re.test(slice));
    assert(!bound, `${where}: ${name} is rebound before the call site (${bound})`);
  }
};

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  let text = fs.readFileSync(file, "utf8");
  if (count(text, headerBefore) === 0) continue;
  assert.equal(count(text, headerBefore), 1, `spawnSubagentDirect repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, "openclawNix"), 0, `${name} already carries an openclaw-nix name`);
  for (const imported of ["readParentExecutionIdentity", "withParentExecutionIdentity"]) {
    assert.equal([...text.matchAll(new RegExp(`^import \\{[^}\\n]*\\bas ${imported}\\b[^}\\n]*\\} from `, "gm"))].length, 1, `${name}: ${imported} is not imported`);
  }
  const edits = [];
  if (mangled) {
    const header = once(text, "async function spawnSubagentDirect(@input@, @context@) {\n\tconst { params: @params@, ctx: @ctx@, profileReceipt: @@, systemPrompt: @@ } = applySubagentProfile(@input@, @context@);\n", `${name}: spawnSubagentDirect profile anchor`);
    const { params, ctx } = header.groups;
    const resolve = once(text, `\tconst @resolution@ = await resolveSubagentSpawnRequest(${params}, ${ctx});\n`, `${name}: hidden spawn request anchor`);
    const destructure = once(text, `\tconst { taskName: @@ cfg: @cfg@, @@ requesterAgentId: @requester@, targetAgentId: @target@, @@ childIdem: @@, blind: @@ } = ${resolve.groups.resolution}.resolved;\n`, `${name}: hidden spawn anchor`);
    assert(header.index < resolve.index && resolve.index < destructure.index, `${name}: hidden spawn anchors out of order`);
    assert(!/\n(?:async )?function /.test(text.slice(header.index + header[0].length, destructure.index)), `${name}: hidden spawn anchors span functions`);
    assert.equal(count(text, `parentExecutionIdentityToken: readParentExecutionIdentity(${ctx})`), 1, `${name}: hidden spawn context name moved`);
    const at = header.index + "async function spawnSubagentDirect(".length + header.groups.input.length + header.groups.context.length + ", ) {\n".length;
    assert.equal(text.slice(at, at + "\tconst {".length), "\tconst {", `${name}: profile destructure moved`);
    edits.push([at, "\tconst {".length, "\tlet {"]);
    const { cfg, requester, target } = destructure.groups;
    edits.push([destructure.index + destructure[0].length, 0, hiddenLine({ ctx, cfg, requester, target, profile: `${ctx}.subagentProfile` })]);

    const visible = once(text, "async function maybeSpawnVisibleSession(@params@) {\n", `${name}: visible spawn path`);
    const vp = visible.groups.params;
    const vcfg = once(text, `\tconst @cfg@ = ${vp}.options?.config ?? readRuntimeConfig();\n`, `${name}: visible config`);
    const vtarget = once(text, `\tconst @target@ = ${vp}.requestedAgentId ? normalizeAgentId(${vp}.requestedAgentId) : @requester@;\n`, `${name}: visible target resolution`);
    const policy = once(text, `${visiblePolicy({ params: vp, delegatedName: "@delegated@" }, false)}\n`, `${name}: visible spawn anchor`);
    assert(visible.index < vcfg.index && vcfg.index < vtarget.index && vtarget.index < policy.index, `${name}: visible spawn anchors out of order`);
    const nextFunction = text.slice(visible.index + visible[0].length).search(/\n(?:async )?function /);
    assert(nextFunction < 0 || policy.index < visible.index + visible[0].length + nextFunction, `${name}: visible spawn anchors span functions`);
    const names = { params: vp, cfg: vcfg.groups.cfg, requester: vtarget.groups.requester, target: vtarget.groups.target, delegatedName: policy.groups.delegated };
    assertNotRedeclared(text.slice(vcfg.index + vcfg[0].length, policy.index), [names.cfg], `${name}: visible config`);
    assertNotRedeclared(text.slice(vtarget.index + vtarget[0].length, policy.index), [names.requester, names.target], `${name}: visible agents`);
    edits.push([policy.index, policy[0].length - 1, visibleAfter(names)]);
  } else {
    assert.equal(count(text, "async function spawnSubagentDirect(params, ctx) {"), 1, `${name}: spawnSubagentDirect signature changed`);
    const hiddenBefore = "childDepth, maxSpawnDepth, childIdem } = requestResolution.resolved;\n";
    assert.equal(count(text, hiddenBefore), 1, `hidden spawn anchor changed in ${name}`);
    assert.equal(count(text, "parentExecutionIdentityToken: readParentExecutionIdentity(ctx)"), 1, `${name}: hidden spawn context name moved`);
    const names = { params: "params", cfg: "cfg", requester: "requesterAgentId", target: "targetAgentId", delegatedName: "delegatedToolPolicy" };
    const visibleBefore = visiblePolicy(names, false);
    assert.equal(count(text, visibleBefore), 1, `visible spawn anchor changed in ${name}`);
    // Both call sites read these names from their own scope; re-derive if they move.
    assert.equal(count(text, "async function maybeSpawnVisibleSession(params) {"), 1, `${name}: visible spawn path moved`);
    assert.equal(count(text, "\tconst targetAgentId = params.requestedAgentId ? normalizeAgentId(params.requestedAgentId) : requesterAgentId;\n"), 1, `${name}: visible target resolution moved`);
    edits.push([text.indexOf(hiddenBefore) + hiddenBefore.length, 0, hiddenLine({ ctx: "ctx", ...names })]);
    edits.push([text.indexOf(visibleBefore), visibleBefore.length, visibleAfter(names)]);
  }
  edits.push([text.indexOf(headerBefore), 0, `${helper}\n`]);
  for (const [at, length, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, at) + replacement + text.slice(at + length);
  fs.writeFileSync(file, text);
  patchedFiles.push(name);
}
assert.equal(patchedFiles.length, 1, `unexpected spawn chunks: ${patchedFiles.join(", ") || "none"}`);
assert(/^sessions-spawn-tool-.*\.mjs$/.test(patchedFiles[0]), `spawn path found in ${patchedFiles[0]}`);

fs.writeFileSync(path.join(root, ".spawn-target-owned-mcp-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-spawn-target-owned-mcp-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Spawn: target-owned MCP servers follow the target agent in ${patchedFiles.join(", ")}`);
