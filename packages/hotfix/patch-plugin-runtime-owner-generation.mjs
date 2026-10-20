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

function replaceExact({ id, before, after, expectedCount, expectedFiles }) {
  let count = 0;
  const files = [];
  for (const file of modules) {
    let source = fs.readFileSync(file, "utf8");
    const occurrences = source.split(before).length - 1;
    if (occurrences === 0) continue;
    source = source.replaceAll(before, after);
    fs.writeFileSync(file, source);
    count += occurrences;
    files.push(path.relative(root, file));
  }
  assert.equal(count, expectedCount, `${id}: expected ${expectedCount} anchors, found ${count}`);
  assert.equal(
    files.length,
    expectedFiles,
    `${id}: expected ${expectedFiles} files, found ${files.length}`,
  );
  changes.push({ id, count, files });
}

replaceExact({
  id: "admission-owner",
  before: `\ttry {
\t\tconst publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({`,
  after: `\ttry {
\t\tconst runtimePluginOwnerId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId); /* ${MARKER} */
\t\tconst publishedRuntime = await loadPublishedGatewayReplyDispatchRuntime({`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "admission-owner-selection",
  before: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\tworkspaceDir: workspaceDir ?? replyDispatchRuntime.workspaceDir,`,
  after: `\t\t\tallowGatewaySubagentBinding: true,
\t\t\t...runtimePluginOwnerId ? { runtimePluginOwnerIds: [runtimePluginOwnerId] } : {},
\t\t\tworkspaceDir: workspaceDir ?? replyDispatchRuntime.workspaceDir,`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "workspace-owner-key",
  before: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({`,
  after: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: input.runtimePluginOwnerIds,
\t\truntimePluginSelections: input.runtimePluginSelections?.map(({ provider, runtime }) => ({`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "owner-only-read-preparation",
  before:
    `\tif (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginSelections) return {};`,
  after:
    `\tif (input.readOnly && !input.loadRuntimePlugins && !input.runtimePluginOwnerIds && !input.runtimePluginSelections) return {};`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "workspace-owner-load",
  before: `\tconst runtimePluginRegistry = input.runtimePluginSelections || !baseRegistry ? loadRuntimeRegistry({
\t\t...input.loadRuntimePlugins ? { basePluginIds: [] } : baseRegistry ? { basePluginIds: listRuntimePluginIdsFromRegistry(baseRegistry) } : basePluginIds !== void 0 ? { basePluginIds } : {},`,
  after: `\tconst runtimePluginRegistry = input.runtimePluginOwnerIds || input.runtimePluginSelections || !baseRegistry ? loadRuntimeRegistry({
\t\t...input.loadRuntimePlugins ? { basePluginIds: input.runtimePluginOwnerIds ?? [] } : baseRegistry ? { basePluginIds: [...new Set([...listRuntimePluginIdsFromRegistry(baseRegistry), ...input.runtimePluginOwnerIds ?? []])] } : basePluginIds !== void 0 ? { basePluginIds: [...new Set([...basePluginIds, ...input.runtimePluginOwnerIds ?? []])] } : input.runtimePluginOwnerIds ? { basePluginIds: input.runtimePluginOwnerIds } : {},`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "generation-owner-guard",
  before: `\tif (!input.runtimePluginSelections) return true;`,
  after: `\tif (!input.runtimePluginOwnerIds && !input.runtimePluginSelections) return true;`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "generation-owner-selection",
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
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "owner-identity",
  before: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginSelections: input.runtimePluginSelections,
\t\tconfig: input.readOnly ? hashRuntimeConfigValue(input.config) : void 0`,
  after: `\t\tallowGatewaySubagentBinding: input.allowGatewaySubagentBinding === true,
\t\truntimePluginOwnerIds: input.runtimePluginOwnerIds,
\t\truntimePluginSelections: input.runtimePluginSelections,
\t\tconfig: input.readOnly ? hashRuntimeConfigValue(input.config) : void 0`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "published-owner-match",
  before:
    `&& (input.allowGatewaySubagentBinding === void 0 || owner.input.allowGatewaySubagentBinding === input.allowGatewaySubagentBinding) && (input.runtimePluginSelections === void 0 || JSON.stringify(owner.input.runtimePluginSelections) === JSON.stringify(input.runtimePluginSelections))`,
  after:
    `&& (input.allowGatewaySubagentBinding === void 0 || owner.input.allowGatewaySubagentBinding === input.allowGatewaySubagentBinding) && (input.runtimePluginOwnerIds === void 0 || JSON.stringify(owner.input.runtimePluginOwnerIds) === JSON.stringify(input.runtimePluginOwnerIds)) && (input.runtimePluginSelections === void 0 || JSON.stringify(owner.input.runtimePluginSelections) === JSON.stringify(input.runtimePluginSelections))`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "published-owner-fallback",
  before:
    `rawInput.workspaceDir === void 0 || rawInput.agentId === void 0 || rawInput.runtimePluginSelections === void 0`,
  after:
    `rawInput.workspaceDir === void 0 || rawInput.agentId === void 0 || rawInput.runtimePluginOwnerIds === void 0 && rawInput.runtimePluginSelections === void 0`,
  expectedCount: 2,
  expectedFiles: 1,
});

replaceExact({
  id: "owner-lifecycle-input",
  before:
    `left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh && left.allowGatewaySubagentBinding === right.allowGatewaySubagentBinding && JSON.stringify(left.runtimePluginSelections) === JSON.stringify(right.runtimePluginSelections)`,
  after:
    `left.preserveWorkspaceDirOnRefresh === right.preserveWorkspaceDirOnRefresh && left.allowGatewaySubagentBinding === right.allowGatewaySubagentBinding && JSON.stringify(left.runtimePluginOwnerIds) === JSON.stringify(right.runtimePluginOwnerIds) && JSON.stringify(left.runtimePluginSelections) === JSON.stringify(right.runtimePluginSelections)`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "catalog-owner-identity",
  before: `\t\t\tloadRuntimePlugins: false,
\t\t\truntimePluginSelections: void 0
\t\t}) === ownerKey({`,
  after: `\t\t\tloadRuntimePlugins: false,
\t\t\truntimePluginOwnerIds: void 0,
\t\t\truntimePluginSelections: void 0
\t\t}) === ownerKey({`,
  expectedCount: 1,
  expectedFiles: 1,
});

replaceExact({
  id: "catalog-input-identity",
  before: `\t\t\t...input,
\t\t\tloadRuntimePlugins: false,
\t\t\truntimePluginSelections: void 0
\t\t}) ? configuredOwner : owner;`,
  after: `\t\t\t...input,
\t\t\tloadRuntimePlugins: false,
\t\t\truntimePluginOwnerIds: void 0,
\t\t\truntimePluginSelections: void 0
\t\t}) ? configuredOwner : owner;`,
  expectedCount: 1,
  expectedFiles: 1,
});

fs.writeFileSync(
  path.join(root, ".plugin-runtime-owner-generation-hotfix.json"),
  `${JSON.stringify({ id: MARKER, upstreamVersion: version, changes }, null, 2)}\n`,
);
console.log(
  `Carried authenticated plugin owners into prepared generations across ${new Set(changes.flatMap((change) => change.files)).size} modules`,
);
