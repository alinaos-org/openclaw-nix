// Exercise the packaged owner-selection and hook-dispatch contract. A run must
// reject a prepared generation that lacks its authenticated owner, then dispatch
// only through the scoped generation once that owner is present.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const receipt = JSON.parse(
  fs.readFileSync(path.join(root, ".plugin-runtime-owner-generation-hotfix.json"), "utf8"),
);
assert.equal(receipt.id, "openclaw-nix-plugin-runtime-owner-generation-v1");

function fileForChange(id) {
  const files = receipt.changes.find((change) => change.id === id)?.files;
  assert.equal(files?.length, 1, `${id}: expected one file in receipt`);
  return path.join(root, files[0]);
}

const changedFiles = new Set(receipt.changes.flatMap((change) => change.files));
const admissionFiles = receipt.changes.find((change) => change.id === "admission-owner")?.files ?? [];
assert.equal(admissionFiles.length, 1);
for (const file of admissionFiles) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert(source.includes(receipt.id), `${file}: admission marker missing`);
  assert(
    source.includes("runtimePluginOwnerIds: [runtimePluginOwnerId]"),
    `${file}: authenticated owner is not passed to prepared runtime acquisition`,
  );
}

const generationFile = [...changedFiles].find(
  (file) => file.startsWith("dist/prepared-model-runtime.plugin-generation-") && file.endsWith(".mjs"),
);
assert(generationFile, "main prepared plugin-generation module missing from receipt");

// Resolve a bundled export by its source name: the minified alias letters move
// between releases, the names in the bundle's export clause do not.
function exportAlias(source, name, where) {
  const clause = source.match(/\bexport\s*\{([^}]*)\};?\s*$/);
  assert(clause, `${where}: export clause missing`);
  const entry = clause[1]
    .split(",")
    .map((part) => part.trim().split(/\s+as\s+/))
    .find(([local]) => local === name);
  assert(entry, `${where}: ${name} is no longer exported`);
  return entry[1] ?? entry[0];
}
async function importNamed(file, names) {
  const source = fs.readFileSync(file, "utf8");
  const module = await import(pathToFileURL(file));
  return Object.fromEntries(
    names.map((name) => {
      const value = module[exportAlias(source, name, path.basename(file))];
      assert.equal(typeof value, "function", `${path.basename(file)}: ${name} is not a function`);
      return [name, value];
    }),
  );
}

const { preparedPluginGenerationSupportsSelections: supportsSelections } = await importNamed(
  path.join(root, generationFile),
  ["preparedPluginGenerationSupportsSelections"],
);

const pluginRecord = (id) => ({
  id,
  name: id,
  status: "loaded",
  source: "hotfix-test",
  hookCount: 1,
});
const supportInput = { config: {}, runtimePluginOwnerIds: ["factory-runtime"] };
const generation = {
  pluginMetadataSnapshot: {},
  pluginRegistry: {
    plugins: [pluginRecord("provider")],
    hooks: [],
    typedHooks: [],
    trustedToolPolicies: [],
  },
};
assert.equal(
  supportsSelections(generation, supportInput),
  false,
  "a prepared generation without the authenticated owner was incorrectly accepted",
);
generation.pluginRegistry.plugins.push(pluginRecord("factory-runtime"));
assert.equal(
  supportsSelections(generation, supportInput),
  true,
  "a prepared generation containing the authenticated owner was rejected",
);

const factsFile = fileForChange("workspace-owner-key");
const { preparedModelRuntimeWorkspaceFactsKey: factsKey } = await importNamed(factsFile, ["preparedModelRuntimeWorkspaceFactsKey"]);
const workspace = { config: {}, env: {} };
assert.notEqual(
  factsKey({ ...workspace, runtimePluginOwnerIds: ["a"] }),
  factsKey({ ...workspace, runtimePluginOwnerIds: ["b"] }),
  "workspace facts key ignores the authenticated owner",
);

const factsSource = fs.readFileSync(factsFile, "utf8");
assert.match(factsSource, /([\w$]+)\.readOnly && !\1\.loadRuntimePlugins && !\1\.runtimePluginOwnerIds && !\1\.runtimePluginSelections/,
  "read-only preparation ignores the owner");
assert.match(factsSource, /([\w$]+)\.runtimePluginOwnerIds \|\| \1\.runtimePluginSelections \|\| ![\w$]+ \? [\w$]+\(\{\s*\.\.\.\1\.loadRuntimePlugins \? \{ basePluginIds: \1\.runtimePluginOwnerIds \?\? \[\]/,
  "workspace registry load ignores the owner");

const ownerSource = fs.readFileSync(fileForChange("owner-identity"), "utf8");
assert.match(ownerSource, /runtimePluginOwnerIds:\s*([\w$]+)\.runtimePluginOwnerIds,\s*runtimePluginSelections:\s*\1\.runtimePluginSelections,\s*config:\s*\1\.readOnly/,
  "owner key ignores the owner");
assert.match(ownerSource, /([\w$]+)\.input\.allowGatewaySubagentBinding === ([\w$]+)\.allowGatewaySubagentBinding\) && \(\2\.runtimePluginOwnerIds === void 0 \|\| JSON\.stringify\(\1\.input\.runtimePluginOwnerIds\) === JSON\.stringify\(\2\.runtimePluginOwnerIds\)\)/,
  "published-owner filter ignores the owner");
const fallbacks = ownerSource.matchAll(/([\w$]+)\.workspaceDir === void 0 \|\| \1\.agentId === void 0 \|\| \1\.runtimePluginOwnerIds === void 0 && \1\.runtimePluginSelections === void 0/g);
const splitProjection = receipt.upstreamVersion.localeCompare("2026.11.5", "en", { numeric: true }) >= 0;
assert.equal([...fallbacks].length, splitProjection ? 3 : 2, "configured-workspace fallback ignores the owner");
assert.match(ownerSource, /([\w$]+)\.allowGatewaySubagentBinding === ([\w$]+)\.allowGatewaySubagentBinding && JSON\.stringify\(\1\.runtimePluginOwnerIds\) === JSON\.stringify\(\2\.runtimePluginOwnerIds\) && JSON\.stringify\(\1\.runtimePluginSelections\) === JSON\.stringify\(\2\.runtimePluginSelections\)/,
  "lifecycle input ignores the owner");
assert.match(ownerSource, /runtimePluginOwnerIds:\s*void 0,\s*runtimePluginSelections:\s*void 0\s*\}\) === ownerKey\(\{/,
  "catalog owner identity keeps the owner");
assert.match(ownerSource, /runtimePluginOwnerIds:\s*void 0,\s*runtimePluginSelections:\s*void 0\s*\}\) \? [\w$]+ : [\w$]+;/,
  "catalog input identity keeps the owner");

// Find a dist module by a name in its export clause, not by its contents: 2026.11.4
// moved resolveHookRegistry into hook-runner-global-state, beside the hook runner.
function moduleExporting(prefix, name) {
  const matches = fs
    .readdirSync(path.join(root, "dist"))
    .filter((file) => file.startsWith(prefix) && file.endsWith(".mjs"))
    .map((file) => path.join(root, "dist", file))
    .filter((file) =>
      new RegExp(`\\bexport\\s*\\{[^}]*\\b${name} as `, "m").test(fs.readFileSync(file, "utf8")),
    );
  assert.equal(matches.length, 1, `${prefix}*.mjs exporting ${name}: found ${matches.length}`);
  return matches[0];
}

const hooks = await importNamed(moduleExporting("hook-runner-global-", "initializeGlobalHookRunner"), [
  "initializeGlobalHookRunner",
  "getGlobalHookRunner",
  "resetGlobalHookRunner",
]);
const generationScope = await importNamed(
  moduleExporting("generation-state-", "withPluginRuntimeGenerationRegistryScope"),
  ["withPluginRuntimeGenerationRegistryScope"],
);
const calls = [];
const registration = (pluginId, label) => ({
  pluginId,
  hookName: "llm_output",
  handler: () => calls.push(label),
  priority: 0,
  source: "hotfix-test",
});
const registry = (typedHooks) => ({
  hooks: [],
  typedHooks,
  plugins: [...new Set(typedHooks.map((hook) => hook.pluginId))].map(pluginRecord),
  trustedToolPolicies: [],
});
const rootRegistry = registry([
  registration("root-only", "root-only"),
  registration("provider", "root-provider"),
]);
const runRegistry = registry([
  registration("factory-runtime", "generation-owner"),
  registration("provider", "generation-provider"),
]);

hooks.initializeGlobalHookRunner(rootRegistry);
try {
  await generationScope.withPluginRuntimeGenerationRegistryScope(runRegistry, () =>
    hooks.getGlobalHookRunner().runLlmOutput(
      {
        runId: "run-1",
        sessionId: "session-1",
        provider: "test-provider",
        model: "test-model",
        assistantTexts: [],
        usage: { input: 1, output: 1, total: 2 },
      },
      {
        agentId: "worker",
        sessionId: "session-1",
        sessionKey: "agent:worker:test",
        runId: "run-1",
      },
    ),
  );
  assert.deepEqual(calls, ["generation-owner", "generation-provider"]);
} finally {
  hooks.resetGlobalHookRunner();
}

console.log(
  "plugin-runtime-owner-generation: authenticated owner required and generation isolation retained",
);
