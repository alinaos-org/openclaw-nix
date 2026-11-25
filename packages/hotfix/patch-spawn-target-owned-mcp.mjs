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

// From 2026.11.6 upstream splits the spawn chunk without changing either path: the
// hidden path (spawnSubagentDirect) lives in subagent-spawn-*.mjs, which imports only
// readParentExecutionIdentity, and the visible path (maybeSpawnVisibleSession) in
// sessions-spawn-visible-*.mjs. Each chunk gets its own copy of the helper, and the
// hidden chunk imports the carrier's write half from the module it already reads the
// identity from, so both halves share one WeakMap.
const split = atLeast(version, "2026.11.6");
const visibleHeader = "async function maybeSpawnVisibleSession(";
const imports = (text) => [...text.matchAll(/^import \{([^}\n]*)\} from "([^"\n]+)";$/gm)].flatMap((match) =>
  match[1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [exported, local = exported] = entry.split(/\s+as\s+/);
    return { match, exported, local };
  }));
const exportsOf = (text, where) => {
  const statements = [...text.matchAll(/^export \{([^}\n]*)\};$/gm)];
  assert.equal(statements.length, 1, `${where}: export statement`);
  return new Map(statements[0][1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [local, exported = local] = entry.split(/\s+as\s+/);
    return [local, exported];
  }));
};

const hiddenEdits = (text, name) => {
  const edits = [];
  if (split) {
    const reads = imports(text).filter(({ local }) => local === "readParentExecutionIdentity");
    assert.equal(reads.length, 1, `${name}: readParentExecutionIdentity is not imported`);
    assert.equal(count(text, "withParentExecutionIdentity"), 0, `${name}: withParentExecutionIdentity is already bound`);
    const [{ match, exported: readExport }] = reads;
    const spec = match[2];
    assert(/^\.\/[\w.-]+\.mjs$/.test(spec), `${name}: parent execution identity module ${spec}`);
    const carrierFile = path.join(dist, spec);
    const carrier = fs.readFileSync(carrierFile, "utf8");
    assert.equal(count(carrier, "{ carry: withParentExecutionIdentity, read: readParentExecutionIdentity } = createPrivateContextCarrier();"), 1, `${spec}: parent execution identity carrier moved`);
    const exported = exportsOf(carrier, spec);
    assert.equal(exported.get("readParentExecutionIdentity"), readExport, `${spec}: readParentExecutionIdentity export`);
    const writeExport = exported.get("withParentExecutionIdentity");
    assert(writeExport && /^[A-Za-z_$][\w$]*$/.test(writeExport), `${spec}: withParentExecutionIdentity is not exported`);
    edits.push([match.index + "import {".length, 0, ` ${writeExport === "withParentExecutionIdentity" ? writeExport : `${writeExport} as withParentExecutionIdentity`},`]);
  } else {
    for (const imported of ["readParentExecutionIdentity", "withParentExecutionIdentity"]) {
      assert.equal([...text.matchAll(new RegExp(`^import \\{[^}\\n]*\\bas ${imported}\\b[^}\\n]*\\} from `, "gm"))].length, 1, `${name}: ${imported} is not imported`);
    }
  }
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
  } else {
    assert.equal(count(text, "async function spawnSubagentDirect(params, ctx) {"), 1, `${name}: spawnSubagentDirect signature changed`);
    const hiddenBefore = "childDepth, maxSpawnDepth, childIdem } = requestResolution.resolved;\n";
    assert.equal(count(text, hiddenBefore), 1, `hidden spawn anchor changed in ${name}`);
    assert.equal(count(text, "parentExecutionIdentityToken: readParentExecutionIdentity(ctx)"), 1, `${name}: hidden spawn context name moved`);
    edits.push([text.indexOf(hiddenBefore) + hiddenBefore.length, 0, hiddenLine({ ctx: "ctx", cfg: "cfg", requester: "requesterAgentId", target: "targetAgentId" })]);
  }
  return edits;
};

const visibleEdits = (text, name) => {
  if (!mangled) {
    const names = { params: "params", cfg: "cfg", requester: "requesterAgentId", target: "targetAgentId", delegatedName: "delegatedToolPolicy" };
    const visibleBefore = visiblePolicy(names, false);
    assert.equal(count(text, visibleBefore), 1, `visible spawn anchor changed in ${name}`);
    // The call site reads these names from its own scope; re-derive if they move.
    assert.equal(count(text, "async function maybeSpawnVisibleSession(params) {"), 1, `${name}: visible spawn path moved`);
    assert.equal(count(text, "\tconst targetAgentId = params.requestedAgentId ? normalizeAgentId(params.requestedAgentId) : requesterAgentId;\n"), 1, `${name}: visible target resolution moved`);
    return [[text.indexOf(visibleBefore), visibleBefore.length, visibleAfter(names)]];
  }
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
  return [[policy.index, policy[0].length - 1, visibleAfter(names)]];
};

// From 2026.11.10 upstream's build compacts the dist (minify codegen): no indentation
// or newlines inside code and no spaces around punctuation, so the spaced anchors above
// cannot match. The same anchors in compact form, with every name captured.
const compact = atLeast(version, "2026.11.10");
const ID = "[A-Za-z_$][\\w$]*";
const re = (source, flags = "dg") => new RegExp(source, flags);
const onceRe = (text, regex, what) => {
  const hits = [...text.matchAll(regex)];
  assert.equal(hits.length, 1, `${what}: ${hits.length} matches`);
  return hits[0];
};
const noFunctionBetween = (text, from, to, what) =>
  assert(!/\bfunction\b/.test(text.slice(from, to)), `${what}: anchors span functions`);

const hiddenEditsCompact = (text, name) => {
  const edits = [];
  const reads = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)";?/g)].flatMap((match) =>
    match[1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [exported, local = exported] = entry.split(/\s+as\s+/);
      return { match, exported, local };
    })).filter(({ local }) => local === "readParentExecutionIdentity");
  assert.equal(reads.length, 1, `${name}: readParentExecutionIdentity is not imported`);
  assert.equal(count(text, "withParentExecutionIdentity"), 0, `${name}: withParentExecutionIdentity is already bound`);
  const [{ match, exported: readExport }] = reads;
  const spec = match[2];
  assert(/^\.\/[\w.-]+\.mjs$/.test(spec), `${name}: parent execution identity module ${spec}`);
  const carrier = fs.readFileSync(path.join(dist, spec), "utf8");
  assert.equal([...carrier.matchAll(/\{\s*carry:\s*withParentExecutionIdentity,\s*read:\s*readParentExecutionIdentity\s*\}\s*=\s*createPrivateContextCarrier\(\);/g)].length, 1, `${spec}: parent execution identity carrier moved`);
  const exportStatements = [...carrier.matchAll(/export\s*\{([^}]*)\};?/g)];
  assert.equal(exportStatements.length, 1, `${spec}: export statement`);
  const exported = new Map(exportStatements[0][1].split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [local, as = local] = entry.split(/\s+as\s+/);
    return [local, as];
  }));
  assert.equal(exported.get("readParentExecutionIdentity"), readExport, `${spec}: readParentExecutionIdentity export`);
  const writeExport = exported.get("withParentExecutionIdentity");
  assert(writeExport && /^[A-Za-z_$][\w$]*$/.test(writeExport), `${spec}: withParentExecutionIdentity is not exported`);
  const importOpen = match[0].indexOf("{") + 1;
  edits.push([match.index + importOpen, 0, `${writeExport === "withParentExecutionIdentity" ? writeExport : `${writeExport} as withParentExecutionIdentity`},`]);

  const header = onceRe(text, re(`async function spawnSubagentDirect\\((?<input>${ID}),\\s*(?<context>${ID})\\)\\s*\\{\\s*(?<decl>const)\\s*\\{\\s*params:\\s*(?<params>${ID}),\\s*ctx:\\s*(?<ctx>${ID}),\\s*profileReceipt:\\s*${ID},\\s*systemPrompt:\\s*${ID}\\s*\\}\\s*=\\s*applySubagentProfile\\(\\k<input>,\\s*\\k<context>\\);`), `${name}: spawnSubagentDirect profile anchor`);
  const { params, ctx } = header.groups;
  const resolve = onceRe(text, re(`const\\s+(?<resolution>${ID})\\s*=\\s*await resolveSubagentSpawnRequest\\(${params},\\s*${ctx}\\);`), `${name}: hidden spawn request anchor`);
  const destructure = onceRe(text, re(`const\\s*\\{\\s*taskName:[^{}]*?\\bcfg:\\s*(?<cfg>${ID}),[^{}]*?\\brequesterAgentId:\\s*(?<requester>${ID}),\\s*targetAgentId:\\s*(?<target>${ID}),[^{}]*?\\bchildIdem:\\s*${ID},\\s*blind:\\s*${ID}\\s*\\}\\s*=\\s*${resolve.groups.resolution}\\.resolved;`), `${name}: hidden spawn anchor`);
  assert(header.index < resolve.index && resolve.index < destructure.index, `${name}: hidden spawn anchors out of order`);
  noFunctionBetween(text, header.index + header[0].length, destructure.index, `${name}: hidden spawn`);
  assert.equal([...text.matchAll(re(`parentExecutionIdentityToken:\\s*readParentExecutionIdentity\\(${ctx}\\)`))].length, 1, `${name}: hidden spawn context name moved`);
  // The profile destructure's const becomes a let so the hidden path can rewrite the context.
  const declAt = header.indices.groups.decl[0];
  assert.equal(text.slice(declAt, declAt + 5), "const", `${name}: profile destructure moved`);
  edits.push([declAt, "const".length, "let"]);
  const { cfg, requester, target } = destructure.groups;
  // On its own line, as in the spaced build, so the injected statement reads (and tests) alone.
  edits.push([destructure.index + destructure[0].length, 0, `\n${hiddenLine({ ctx, cfg, requester, target, profile: `${ctx}.subagentProfile` })}`]);
  return edits;
};

const visibleEditsCompact = (text, name) => {
  const visible = onceRe(text, re(`async function maybeSpawnVisibleSession\\((?<params>${ID})\\)\\s*\\{`), `${name}: visible spawn path`);
  const vp = visible.groups.params;
  const vcfg = onceRe(text, re(`const\\s+(?<cfg>${ID})\\s*=\\s*${vp}\\.options\\?\\.config\\s*\\?\\?\\s*readRuntimeConfig\\(\\);`), `${name}: visible config`);
  const vtarget = onceRe(text, re(`const\\s+(?<target>${ID})\\s*=\\s*${vp}\\.requestedAgentId\\s*\\?\\s*normalizeAgentId\\(${vp}\\.requestedAgentId\\)\\s*:\\s*(?<requester>${ID});`), `${name}: visible target resolution`);
  const policy = onceRe(text, re(`inheritedToolPolicy:\\s*\\{\\s*version:\\s*1,\\s*allow:\\s*\\[\\.\\.\\.${vp}\\.options\\?\\.inheritedToolAllowlist\\s*\\?\\?\\s*\\[\\]\\],\\s*deny:\\s*\\[\\.\\.\\.${vp}\\.options\\?\\.inheritedToolDenylist\\s*\\?\\?\\s*\\[\\]\\],\\s*\\.\\.\\.(?<delegated>${ID})\\s*\\?\\s*\\{\\s*delegatedToolPolicy(?::\\s*\\k<delegated>)?\\s*\\}\\s*:\\s*\\{\\}\\s*\\},`), `${name}: visible spawn anchor`);
  assert(visible.index < vcfg.index && vcfg.index < vtarget.index && vtarget.index < policy.index, `${name}: visible spawn anchors out of order`);
  noFunctionBetween(text, visible.index + visible[0].length, policy.index, `${name}: visible spawn`);
  // Compacted code reuses short names in inner scopes, so the spaced rebinding check
  // would refuse valid output; instead each of the three names must be declared exactly
  // once in this function up to the call site (its own declaration).
  const body = text.slice(visible.index, policy.index);
  for (const bound of [vcfg.groups.cfg, vtarget.groups.target, vtarget.groups.requester]) {
    const n = bound.replace(/[$]/g, "\\$");
    assert.equal([...body.matchAll(re(`(?:\\bconst|\\blet|\\bvar)\\s+${n}\\s*=`))].length, 1, `${name}: ${bound} is rebound before the call site`);
  }
  const names = { params: vp, cfg: vcfg.groups.cfg, requester: vtarget.groups.requester, target: vtarget.groups.target, delegatedName: policy.groups.delegated };
  return [[policy.index, policy[0].length, `${visibleAfter(names)}\n`]];
};

const patchedFiles = [];
const sites = { hidden: [], visible: [] };
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  let text = fs.readFileSync(file, "utf8");
  const hidden = count(text, headerBefore), visible = count(text, visibleHeader);
  if (hidden === 0 && visible === 0) continue;
  assert(hidden <= 1, `spawnSubagentDirect repeated in ${name}`);
  assert(visible <= 1, `maybeSpawnVisibleSession repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, "openclawNix"), 0, `${name} already carries an openclaw-nix name`);
  const edits = [];
  if (hidden) { edits.push(...(compact ? hiddenEditsCompact : hiddenEdits)(text, name)); sites.hidden.push(name); }
  if (visible) { edits.push(...(compact ? visibleEditsCompact : visibleEdits)(text, name)); sites.visible.push(name); }
  edits.push([text.indexOf(hidden ? headerBefore : visibleHeader), 0, `${helper}\n`]);
  for (const [at, length, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, at) + replacement + text.slice(at + length);
  fs.writeFileSync(file, text);
  patchedFiles.push(name);
}
assert.equal(sites.hidden.length, 1, `hidden spawn chunks: ${sites.hidden.join(", ") || "none"}`);
assert.equal(sites.visible.length, 1, `visible spawn chunks: ${sites.visible.join(", ") || "none"}`);
if (split) {
  assert(/^subagent-spawn-[\w-]{8}\.mjs$/.test(sites.hidden[0]), `hidden spawn path found in ${sites.hidden[0]}`);
  assert(/^sessions-spawn-visible-[\w-]{8}\.mjs$/.test(sites.visible[0]), `visible spawn path found in ${sites.visible[0]}`);
} else {
  assert.equal(patchedFiles.length, 1, `unexpected spawn chunks: ${patchedFiles.join(", ")}`);
  assert(/^sessions-spawn-tool-.*\.mjs$/.test(patchedFiles[0]), `spawn path found in ${patchedFiles[0]}`);
}

fs.writeFileSync(path.join(root, ".spawn-target-owned-mcp-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-spawn-target-owned-mcp-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Spawn: target-owned MCP servers follow the target agent in ${patchedFiles.join(", ")}`);
