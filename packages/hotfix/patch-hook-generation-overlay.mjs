import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.5"), "hook-generation-overlay hotfix requires a qualified stable release");

const MARKER = "openclaw-nix-hook-generation-overlay-v1";
const dist = path.join(root, "dist");
const needle = "function resolveHookRegistry(state)";
const files = fs.readdirSync(dist).filter((name) =>
  /^hook-runner-global-.*\.mjs$/.test(name)
  && fs.readFileSync(path.join(dist, name), "utf8").includes(needle));
assert.equal(files.length, 1, `expected exactly one hook-runner-global module containing ${needle}`);
const file = files[0];
const target = path.join(dist, file);
let source = fs.readFileSync(target, "utf8");

const before = `function resolveHookRegistry(state) {
\tconst generationRegistry = getPluginRuntimeGenerationRegistry();
\tif (generationRegistry && !isPluginRegistryRetired(generationRegistry)) return generationRegistry;
\tconst requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? null;
\treturn overlayHookRegistries(resolveRootHookRegistry(state), requestRegistry && !isPluginRegistryRetired(requestRegistry) ? requestRegistry : null);
}`;
const after = `function resolveHookRegistry(state) {
\tconst generationRegistry = getPluginRuntimeGenerationRegistry();
\tconst requestRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry ?? null;
\treturn overlayHookRegistries(overlayHookRegistries(resolveRootHookRegistry(state), requestRegistry && !isPluginRegistryRetired(requestRegistry) ? requestRegistry : null), generationRegistry && !isPluginRegistryRetired(generationRegistry) ? generationRegistry : null); /* ${MARKER} */
}`;
assert.equal(source.split(before).length, 2, `hook-generation-overlay anchor changed in ${file}`);
source = source.replace(before, after);
fs.writeFileSync(target, source);

fs.writeFileSync(path.join(root, ".hook-generation-overlay-hotfix.json"), JSON.stringify({
  id: MARKER,
  upstreamVersion: version,
  patchedFile: file,
}, null, 2) + "\n");
console.log(`Composed process-root, request, and prepared-generation hook registries in ${file}`);
