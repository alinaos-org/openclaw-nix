import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
const atLeast = (version, minimum) => {
  const a = String(version).split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i];
  }
  return true;
};
assert(
  root && atLeast(version, "2026.10.5"),
  "plugin-runtime-owner-generation hotfix requires a qualified stable release",
);

const MARKER = "openclaw-nix-plugin-runtime-owner-generation-v1";
const dist = path.join(root, "dist");

function listModules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return listModules(target);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [target] : [];
  });
}

const modules = listModules(dist);
const changes = [];

const compact = atLeast(version, "2026.11.10");
// The compact gateway labels the source modules. Worker-only copies lack these
// labels and have always been outside the run-admission patch.
const owners = {
  "admission-owner": "gateway/agent-turn/agent-run-admission-phase",
  "admission-owner-selection": "gateway/agent-turn/agent-run-admission-phase",
  "workspace-owner-key": "agents/prepared-model-runtime.inbound-registry",
  "owner-only-read-preparation": "agents/prepared-model-runtime.inbound-registry",
  "workspace-owner-load": "agents/prepared-model-runtime.inbound-registry",
  "generation-owner-guard": "agents/prepared-model-runtime.plugin-generation",
  "generation-owner-selection": "agents/prepared-model-runtime.plugin-generation",
  "owner-identity": "agents/prepared-model-runtime.owner",
  "published-owner-match": "agents/prepared-model-runtime.owner",
  "published-owner-fallback": "agents/prepared-model-runtime.owner",
  "projected-owner-fallback": "agents/prepared-model-runtime.published-owner",
  "owner-lifecycle-input": "agents/prepared-model-runtime.owner",
  "catalog-owner-identity": "agents/prepared-model-runtime-lease",
  "catalog-input-identity": "agents/prepared-model-runtime-lease",
};
const labelsOf = (text) => [...text.matchAll(/^\/\/(?:#region |(?:! ?| )(?=\S+\/\S+$))(.+)$/gm)];
const sources = new Map();
const regionFiles = new Map();
if (compact) {
  const wanted = new Set(Object.values(owners).map((name) => `src/${name}.ts`));
  for (const file of modules) {
    const source = fs.readFileSync(file, "utf8");
    const labels = labelsOf(source);
    for (const [, label] of labels) {
      if (!wanted.has(label)) continue;
      assert(!regionFiles.has(label), `duplicate module ${label} in ${file}`);
      regionFiles.set(label, file);
      sources.set(file, source);
    }
  }
}

// The mangled templates below use single-letter identifiers only for locals.
// Capture each one once and require later uses to read the same binding.
function compactEdit(source, before, after) {
  const locals = new Set();
  const tokens = before.trim().match(/\s+|[A-Za-z_$][\w$]*|./g);
  const pattern = tokens.map((token, i) => {
    if (/^\s+$/.test(token)) return /\w$/.test(tokens[i - 1]) && /^\w/.test(tokens[i + 1]) ? "\\s+" : "\\s*";
    if (/^[A-Za-z]$/.test(token)) {
      if (locals.has(token)) return `\\k<${token}>`;
      locals.add(token);
      return `(?<${token}>[A-Za-z_$][\\w$]*)`;
    }
    return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  const re = new RegExp(pattern, "g");
  const matches = [...source.matchAll(re)];
  const replacement = source.replace(re, (...args) => {
    const groups = args.at(-1);
    return after.replace(/\b[A-Za-z]\b/g, (token) => locals.has(token) ? groups[token] : token);
  });
  return { replacement, count: matches.length };
}

function replaceExact({ id, before, after, expectedCount, expectedFiles }) {
  let count = 0;
  const files = [];
  const label = `src/${owners[id]}.ts`;
  if (compact) assert(regionFiles.has(label), `${id}: missing ${label}`);
  for (const file of compact ? [regionFiles.get(label)] : modules) {
    const source = sources.get(file) ?? fs.readFileSync(file, "utf8");
    let replacement, occurrences;
    if (compact) {
      const labels = labelsOf(source);
      const index = labels.findIndex((match) => match[1] === label);
      const start = labels[index].index, end = labels[index + 1]?.index ?? source.length;
      const edit = compactEdit(source.slice(start, end), before, after);
      occurrences = edit.count;
      replacement = source.slice(0, start) + edit.replacement + source.slice(end);
    } else {
      occurrences = source.split(before).length - 1;
      replacement = occurrences ? source.replaceAll(before, after) : source;
    }
    if (occurrences === 0) continue;
    sources.set(file, replacement);
    count += occurrences;
    files.push(path.relative(root, file));
  }
  assert.equal(count, expectedCount, `${id}: expected ${expectedCount} anchors, found ${count}`);
  assert.equal(files.length, expectedFiles, `${id}: expected ${expectedFiles} files, found ${files.length}`);
  changes.push({ id, count, files });
}

// From 2026.11.5 the bundle renames every local binding to a single letter, so the
// anchors name the minified bindings of each function: in prepareAgentRunDispatch
// `e` is params, `t` the published runtime and `O` the reply dispatch runtime; in the
// prepared-runtime modules `e`/`t` are the inputs the readable names below call
// input/rawInput/owner/left/right. Imported names (normalizeOptionalString,
// listRuntimePluginIdsFromRegistry, resolveAgentRuntimePluginSelectionOwners) and the
// new bindings this patch introduces keep their names. Before 2026.11.5 the bundle
// kept readable names.
const minified = atLeast(version, "2026.11.5");
const pick = (readable, mangled) => (minified ? mangled : readable);

replaceExact({
  id: "admission-owner",
  ...pick(
    {
      before: `\ttry {
\t\tconst publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({`,
      after: `\ttry {
\t\tconst runtimePluginOwnerId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId); /* ${MARKER} */
\t\tconst publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({`,
    },
    {
      before: `\ttry {
\t\tconst t = await loadPublishedGatewayReplyDispatchRuntime({
\t\t\tagentId: e.activeSessionAgentId,`,
      after: `\ttry {
\t\tconst runtimePluginOwnerId = normalizeOptionalString(e.client?.internal?.pluginRuntimeOwnerId); /* ${MARKER} */
\t\tconst t = await loadPublishedGatewayReplyDispatchRuntime({
\t\t\tagentId: e.activeSessionAgentId,`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "admission-owner-selection",
  ...pick(
    {
      before: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\tworkspaceDir: workspaceDir ?? replyDispatchRuntime.workspaceDir,`,
      after: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\t...runtimePluginOwnerId ? { runtimePluginOwnerIds: [runtimePluginOwnerId] } : {},
\t\t\tworkspaceDir: workspaceDir ?? replyDispatchRuntime.workspaceDir,`,
    },
    {
      before: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\tworkspaceDir: e ?? O.workspaceDir,`,
      after: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\t...runtimePluginOwnerId ? { runtimePluginOwnerIds: [runtimePluginOwnerId] } : {},
\t\t\tworkspaceDir: e ?? O.workspaceDir,`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "workspace-owner-key",
  ...pick(
    {
      before: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({`,
      after: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: input.runtimePluginOwnerIds,
\t\truntimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({`,
    },
    {
      before: `\t\tallowGatewaySubagentBinding: e.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: e.runtimePluginSelections?.map(({ provider: e, runtime: t }) => ({`,
      after: `\t\tallowGatewaySubagentBinding: e.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: e.runtimePluginOwnerIds,
\t\truntimePluginSelections: e.runtimePluginSelections?.map(({ provider: e, runtime: t }) => ({`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "owner-only-read-preparation",
  ...pick(
    {
      before: `\tif (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) return {};`,
      after: `\tif (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginOwnerIds && !input.runtimePluginSelections) return {};`,
    },
    {
      before: `\tif (e.readOnly && !e.loadRuntimePlugins && !e.runtimePluginSelections) return {};`,
      after: `\tif (e.readOnly && !e.loadRuntimePlugins && !e.runtimePluginOwnerIds && !e.runtimePluginSelections) return {};`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// In prepareWorkspacePluginRegistries the base registry is baseRegistry (`d` from
// 2026.11.5) and the explicit base ids are basePluginIds (`s`).
replaceExact({
  id: "workspace-owner-load",
  ...pick(
    {
      before: `\tconst runtimePluginRegistry = input.runtimePluginSelections || !baseRegistry ? loadRuntimeRegistry({
\t\t...input.loadRuntimePlugins ? { basePluginIds: [] } : baseRegistry ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) } : basePluginIds !== void 0 ? { basePluginIds } : {},`,
      after: `\tconst runtimePluginRegistry = input.runtimePluginOwnerIds || input.runtimePluginSelections || !baseRegistry ? loadRuntimeRegistry({
\t\t...input.loadRuntimePlugins ? { basePluginIds: input.runtimePluginOwnerIds ?? [] } : baseRegistry ? { basePluginIds: [...new Set([...listRuntimePluginIdsFromRegistry(baseRegistry), ...input.runtimePluginOwnerIds ?? []])] } : basePluginIds !== void 0 ? { basePluginIds: [...new Set([...basePluginIds, ...input.runtimePluginOwnerIds ?? []])] } : input.runtimePluginOwnerIds ? { basePluginIds: input.runtimePluginOwnerIds } : {},`,
    },
    {
      before: `\tconst p = e.runtimePluginSelections || !d ? c({
\t\t...e.loadRuntimePlugins ? { basePluginIds: [] } : d ? { basePluginIds: listRuntimePluginIdsFromRegistry(d) } : s !== void 0 ? { basePluginIds: s } : {},`,
      after: `\tconst p = e.runtimePluginOwnerIds || e.runtimePluginSelections || !d ? c({
\t\t...e.loadRuntimePlugins ? { basePluginIds: e.runtimePluginOwnerIds ?? [] } : d ? { basePluginIds: [...new Set([...listRuntimePluginIdsFromRegistry(d), ...e.runtimePluginOwnerIds ?? []])] } : s !== void 0 ? { basePluginIds: [...new Set([...s, ...e.runtimePluginOwnerIds ?? []])] } : e.runtimePluginOwnerIds ? { basePluginIds: e.runtimePluginOwnerIds } : {},`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// preparedPluginGenerationSupportsSelections(generation, input): `e`, `t` from 2026.11.5,
// with the registry in `n` and the selection in `r`.
replaceExact({
  id: "generation-owner-guard",
  ...pick(
    {
      before: `\tif (!input.runtimePluginSelections) return true;`,
      after: `\tif (!input.runtimePluginOwnerIds && !input.runtimePluginSelections) return true;`,
    },
    {
      before: `\tif (!t.runtimePluginSelections) return true;`,
      after: `\tif (!t.runtimePluginOwnerIds && !t.runtimePluginSelections) return true;`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "generation-owner-selection",
  ...pick(
    {
      before: `\tconst selection = resolveAgentRuntimePluginSelectionOwners({
\t\tconfig: input.config,
\t\tworkspaceDir: generation.pluginMetadataSnapshot.workspaceDir ?? input.workspaceDir ?? process.cwd(),
\t\tselections: input.runtimePluginSelections,
\t\tmetadataSnapshot: generation.pluginMetadataSnapshot
\t});
\treturn registry !== void 0 && selection.pluginIds.every(`,
      after: `\tconst selectedPluginIds = input.runtimePluginSelections ? resolveAgentRuntimePluginSelectionOwners({
\t\tconfig: input.config,
\t\tworkspaceDir: generation.pluginMetadataSnapshot.workspaceDir ?? input.workspaceDir ?? process.cwd(),
\t\tselections: input.runtimePluginSelections,
\t\tmetadataSnapshot: generation.pluginMetadataSnapshot
\t}).pluginIds : [];
\tconst requiredPluginIds = [...new Set([...input.runtimePluginOwnerIds ?? [], ...selectedPluginIds])];
\treturn registry !== void 0 && requiredPluginIds.every(`,
    },
    {
      before: `\tconst r = resolveAgentRuntimePluginSelectionOwners({
\t\tconfig: t.config,
\t\tworkspaceDir: e.pluginMetadataSnapshot.workspaceDir ?? t.workspaceDir ?? process.cwd(),
\t\tselections: t.runtimePluginSelections,
\t\tmetadataSnapshot: e.pluginMetadataSnapshot
\t});
\treturn n !== void 0 && r.pluginIds.every(`,
      after: `\tconst selectedPluginIds = t.runtimePluginSelections ? resolveAgentRuntimePluginSelectionOwners({
\t\tconfig: t.config,
\t\tworkspaceDir: e.pluginMetadataSnapshot.workspaceDir ?? t.workspaceDir ?? process.cwd(),
\t\tselections: t.runtimePluginSelections,
\t\tmetadataSnapshot: e.pluginMetadataSnapshot
\t}).pluginIds : [];
\tconst requiredPluginIds = [...new Set([...t.runtimePluginOwnerIds ?? [], ...selectedPluginIds])];
\treturn n !== void 0 && requiredPluginIds.every(`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// ownerKey's config fingerprint is hashRuntimeConfigValue until 2026.10.9 and
// modelRuntimeConfigFingerprint from 2026.10.10; the anchor stops before it.
replaceExact({
  id: "owner-identity",
  ...pick(
    {
      before: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: input.runtimePluginSelections,
\t\tconfig: input.readOnly ? `,
      after: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: input.runtimePluginOwnerIds,
\t\truntimePluginSelections: input.runtimePluginSelections,
\t\tconfig: input.readOnly ? `,
    },
    {
      before: `\t\tallowGatewaySubagentBinding: e.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: e.runtimePluginSelections,
\t\tconfig: e.readOnly ? `,
      after: `\t\tallowGatewaySubagentBinding: e.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: e.runtimePluginOwnerIds,
\t\truntimePluginSelections: e.runtimePluginSelections,
\t\tconfig: e.readOnly ? `,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// resolvePublishedOwner's candidate filter: owner is `e`, input `t` from 2026.11.5.
replaceExact({
  id: "published-owner-match",
  ...pick(
    {
      before: `&& (input.allowGatewaySubagentBinding === void 0 || owner.input.allowGatewaySubagentBinding === input.allowGatewaySubagentBinding) && (input.runtimePluginSelections === void 0 || JSON.stringify(owner.input.runtimePluginSelections) === JSON.stringify(input.runtimePluginSelections))`,
      after: `&& (input.allowGatewaySubagentBinding === void 0 || owner.input.allowGatewaySubagentBinding === input.allowGatewaySubagentBinding) && (input.runtimePluginOwnerIds === void 0 || JSON.stringify(owner.input.runtimePluginOwnerIds) === JSON.stringify(input.runtimePluginOwnerIds)) && (input.runtimePluginSelections === void 0 || JSON.stringify(owner.input.runtimePluginSelections) === JSON.stringify(input.runtimePluginSelections))`,
    },
    {
      before: `&& (t.allowGatewaySubagentBinding === void 0 || e.input.allowGatewaySubagentBinding === t.allowGatewaySubagentBinding) && (t.runtimePluginSelections === void 0 || JSON.stringify(e.input.runtimePluginSelections) === JSON.stringify(t.runtimePluginSelections))`,
      after: `&& (t.allowGatewaySubagentBinding === void 0 || e.input.allowGatewaySubagentBinding === t.allowGatewaySubagentBinding) && (t.runtimePluginOwnerIds === void 0 || JSON.stringify(e.input.runtimePluginOwnerIds) === JSON.stringify(t.runtimePluginOwnerIds)) && (t.runtimePluginSelections === void 0 || JSON.stringify(e.input.runtimePluginSelections) === JSON.stringify(t.runtimePluginSelections))`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// The configured-workspace fallback is decided twice before 2026.11.5 (both on
// rawInput). From 2026.11.5 readPublishedModelRuntimeSnapshot decides it on its raw
// input `t`, and projectPublishedModelRuntimeOwner / projectNormalizedModelRuntimeOwner
// decide it on `e` (the raw input, then the normalized input, which keeps
// runtimePluginOwnerIds through its rest spread).
if (minified) {
  replaceExact({
    id: "published-owner-fallback",
    before: `t.workspaceDir === void 0 || t.agentId === void 0 || t.runtimePluginSelections === void 0`,
    after: `t.workspaceDir === void 0 || t.agentId === void 0 || t.runtimePluginOwnerIds === void 0 && t.runtimePluginSelections === void 0`,
    expectedCount: 1,
    expectedFiles: 1,
  });
  replaceExact({
    id: "projected-owner-fallback",
    before: `e.workspaceDir === void 0 || e.agentId === void 0 || e.runtimePluginSelections === void 0`,
    after: `e.workspaceDir === void 0 || e.agentId === void 0 || e.runtimePluginOwnerIds === void 0 && e.runtimePluginSelections === void 0`,
    expectedCount: 2,
    expectedFiles: 1,
  });
} else {
  replaceExact({
    id: "published-owner-fallback",
    before: `rawInput.workspaceDir === void 0 || rawInput.agentId === void 0 || rawInput.runtimePluginSelections === void 0`,
    after: `rawInput.workspaceDir === void 0 || rawInput.agentId === void 0 || rawInput.runtimePluginOwnerIds === void 0 && rawInput.runtimePluginSelections === void 0`,
    expectedCount: 2,
    expectedFiles: 1,
  });
}

// hasSameLifecycleInput(left, right): `e`, `t` from 2026.11.5.
replaceExact({
  id: "owner-lifecycle-input",
  ...pick(
    {
      before: `left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh && left.allowGatewaySubagentBinding === right.allowGatewaySubagentBinding && JSON.stringify(left.runtimePluginSelections) === JSON.stringify(right.runtimePluginSelections)`,
      after: `left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh && left.allowGatewaySubagentBinding === right.allowGatewaySubagentBinding && JSON.stringify(left.runtimePluginOwnerIds) === JSON.stringify(right.runtimePluginOwnerIds) && JSON.stringify(left.runtimePluginSelections) === JSON.stringify(right.runtimePluginSelections)`,
    },
    {
      before: `e.preserveWorkspaceDirOnRefresh === t.preserveWorkspaceDirOnRefresh && e.allowGatewaySubagentBinding === t.allowGatewaySubagentBinding && JSON.stringify(e.runtimePluginSelections) === JSON.stringify(t.runtimePluginSelections)`,
      after: `e.preserveWorkspaceDirOnRefresh === t.preserveWorkspaceDirOnRefresh && e.allowGatewaySubagentBinding === t.allowGatewaySubagentBinding && JSON.stringify(e.runtimePluginOwnerIds) === JSON.stringify(t.runtimePluginOwnerIds) && JSON.stringify(e.runtimePluginSelections) === JSON.stringify(t.runtimePluginSelections)`,
    },
  ),
  expectedCount: 1,
  expectedFiles: 1,
});

// From 2026.10.10 both catalog identities also clear runtimePluginPurpose and the
// second spreads inventoryInput (`g` from 2026.11.5, with configuredOwner `a` and
// owner `e`). 2026.10.10 also adds a static-catalog fast path for runs that compares
// ownerKey with only runtimePluginSelections cleared; it is left as is, so a
// plugin-owned run never reuses the configured owner's generation there and
// publishes its own run owner, as on 2026.10.9. 2026.11.5 adds a borrowed-generation
// fast path in acquirePreparedModelRuntimeLeaseAttempt; it goes through
// preparedPluginGenerationSupportsSelections, so it borrows only a generation that
// already holds the owner.
const catalogPurpose = atLeast(version, "2026.10.10") ? "\t\t\truntimePluginPurpose: void 0,\n" : "";
const catalogInput = minified ? "g" : atLeast(version, "2026.10.10") ? "inventoryInput" : "input";
const catalogChoice = minified ? "a : e" : "configuredOwner : owner";
replaceExact({
  id: "catalog-owner-identity",
  before: `\t\t\tloadRuntimePlugins: false,
${catalogPurpose}\t\t\truntimePluginSelections: void 0
\t\t}) === ownerKey({`,
  after: `\t\t\tloadRuntimePlugins: false,
${catalogPurpose}\t\t\truntimePluginOwnerIds: void 0,
\t\t\truntimePluginSelections: void 0
\t\t}) === ownerKey({`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "catalog-input-identity",
  before: `\t\t\t...${catalogInput},
\t\t\tloadRuntimePlugins: false,
${catalogPurpose}\t\t\truntimePluginSelections: void 0
\t\t}) ? ${catalogChoice};`,
  after: `\t\t\t...${catalogInput},
\t\t\tloadRuntimePlugins: false,
${catalogPurpose}\t\t\truntimePluginOwnerIds: void 0,
\t\t\truntimePluginSelections: void 0
\t\t}) ? ${catalogChoice};`,
  expectedCount: 1,
  expectedFiles: 1,
});

for (const [file, source] of sources) fs.writeFileSync(file, source);
fs.writeFileSync(
  path.join(root, ".plugin-runtime-owner-generation-hotfix.json"),
  `${JSON.stringify({ id: MARKER, upstreamVersion: version, changes }, null, 2)}\n`,
);
console.log(
  `Carried authenticated plugin owners into prepared generations across ${new Set(changes.flatMap((change) => change.files)).size} modules`,
);
