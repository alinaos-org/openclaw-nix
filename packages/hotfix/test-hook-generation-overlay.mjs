// Exercise the packaged global hook runner with a real prepared-generation scope.
// Unrelated process-root hooks must remain visible, while a generation's matching
// plugin/hook registration replaces the root registration without double dispatch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".hook-generation-overlay-hotfix.json"), "utf8"));
const hookPath = path.join(root, "dist", receipt.patchedFile);
const source = fs.readFileSync(hookPath, "utf8");
assert(source.includes(receipt.id), "packaged hook resolver is missing the hotfix marker");
const generationImport = source.match(/from "\.\/(generation-state-[^"]+\.mjs)"/);
assert(generationImport, "hook runner generation-state import moved");

const hooks = await import(pathToFileURL(hookPath));
const generation = await import(pathToFileURL(path.join(root, "dist", generationImport[1])));
const calls = [];
const registration = (pluginId, handler) => ({
  pluginId,
  hookName: "llm_output",
  handler,
  priority: 0,
  source: "hotfix-test",
});
const registry = (typedHooks) => ({
  hooks: [],
  typedHooks,
  plugins: [...new Set(typedHooks.map((hook) => hook.pluginId))].map((id) => ({
    id,
    name: id,
    status: "loaded",
    source: "hotfix-test",
    hookCount: typedHooks.filter((hook) => hook.pluginId === id).length,
  })),
  trustedToolPolicies: [],
});
const rootRegistry = registry([
  registration("factory-runtime", () => { calls.push("root-observer"); }),
  registration("provider", () => { calls.push("root-provider"); }),
]);
const generationRegistry = registry([
  registration("provider", () => { calls.push("generation-provider"); }),
]);

hooks.a(rootRegistry);
try {
  await generation.r(generationRegistry, () => hooks.n().runLlmOutput(
    {
      runId: "run-1",
      sessionId: "session-1",
      provider: "test-provider",
      model: "test-model",
      assistantTexts: [],
      usage: { input: 1, output: 1, total: 2 },
    },
    { agentId: "worker", sessionId: "session-1", sessionKey: "agent:worker:test", runId: "run-1" },
  ));
  assert.deepEqual(calls, ["root-observer", "generation-provider"]);

  calls.length = 0;
  await hooks.n().runLlmOutput(
    {
      runId: "run-2",
      sessionId: "session-1",
      provider: "test-provider",
      model: "test-model",
      assistantTexts: [],
      usage: { input: 1, output: 1, total: 2 },
    },
    { agentId: "worker", sessionId: "session-1", sessionKey: "agent:worker:test", runId: "run-2" },
  );
  assert.deepEqual(calls, ["root-observer", "root-provider"]);
} finally {
  hooks.o();
}

console.log("hook-generation-overlay: retained unrelated root hooks and generation replacement precedence");
