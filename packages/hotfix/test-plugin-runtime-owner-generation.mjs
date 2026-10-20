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
const generationModule = await import(pathToFileURL(path.join(root, generationFile)));
const supportsSelections = generationModule.i;
assert.equal(typeof supportsSelections, "function", "prepared owner guard export moved");

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

const hookFile = fs
  .readdirSync(path.join(root, "dist"))
  .find(
    (name) =>
      /^hook-runner-global-.*\.mjs$/.test(name) &&
      fs
        .readFileSync(path.join(root, "dist", name), "utf8")
        .includes("function resolveHookRegistry(state)"),
  );
assert(hookFile, "global hook runner module missing");
const hookPath = path.join(root, "dist", hookFile);
const hookSource = fs.readFileSync(hookPath, "utf8");
const generationImport = hookSource.match(/from "\.\/(generation-state-[^"]+\.mjs)"/);
assert(generationImport, "hook runner generation-state import moved");

const hooks = await import(pathToFileURL(hookPath));
const generationScope = await import(
  pathToFileURL(path.join(root, "dist", generationImport[1]))
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

hooks.a(rootRegistry);
try {
  await generationScope.r(runRegistry, () =>
    hooks.n().runLlmOutput(
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
  hooks.o();
}

console.log(
  "plugin-runtime-owner-generation: authenticated owner required and generation isolation retained",
);
