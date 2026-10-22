// The patched Control UI asset reader serves a browser build whose files are hard
// links when the plugin root is in /nix/store (this layer's own output during the
// build), still refuses the same build outside the store, and every bundled native
// UI in the runtime tree reads. An explicit Control UI reload, which rereads the
// manifest, accepts a hardlinked manifest under /nix/store, refuses it outside, and
// refuses a symlinked manifest in the store; every bundled native UI reloads. Outside
// the store (scripts/scratch-patch-chain.sh runs the layer on a scratch copy, whose
// files keep their mutual hard links), only the refusals can be checked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".control-ui-store-hardlinks-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-control-ui-store-hardlinks-v2");
const exported = async (file, name) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const alias = source.match(new RegExp(`\\b${name} as ([\\w$]+)`))?.[1];
  assert(alias, `${name} is no longer exported from ${file}`);
  const value = (await import(pathToFileURL(path.join(root, file)).href))[alias];
  assert.equal(typeof value, "function", `${name} in ${file}`);
  return value;
};
const chunkOf = (pattern, needle) => {
  const found = fs.readdirSync(path.join(root, "dist")).filter((name) => pattern.test(name)
    && fs.readFileSync(path.join(root, "dist", name), "utf8").includes(needle));
  assert.equal(found.length, 1, `expected one ${pattern} defining ${needle}`);
  return path.join("dist", found[0]);
};
const read = await exported(receipt.patchedFiles.find((name) => /^dist\/control-ui-assets-[^/]+\.mjs$/.test(name)), "readPluginControlUiAssets");
const reloadChunk = receipt.manifestReloadFiles.find((name) => /^dist\/control-ui-plugin-assets-[^/]+\.mjs$/.test(name));
const reloadCatalog = await exported(reloadChunk, "reloadControlUiPluginCatalog");
const listCatalog = await exported(reloadChunk, "listControlUiPluginCatalog");
const setActivePluginRegistry = await exported(chunkOf(/^runtime-.*\.mjs$/, "function setActivePluginRegistry("), "setActivePluginRegistry");
const createEmptyPluginRegistry = await exported(chunkOf(/^registry-empty-.*\.mjs$/, "function createEmptyPluginRegistry("), "createEmptyPluginRegistry");

function fixture(base) {
  const plugin = path.join(base, "plugin");
  const build = path.join(plugin, "dist", "control-ui");
  fs.mkdirSync(build, {recursive: true});
  fs.writeFileSync(path.join(build, "index.js"), "export default {};\n");
  fs.linkSync(path.join(build, "index.js"), path.join(build, "alias.js"));
  assert.equal(fs.statSync(path.join(build, "index.js")).nlink, 2);
  return plugin;
}
const declaration = {entry: "dist/control-ui/index.js"};

// A bundled plugin with a browser build and its manifest; `manifest` is "plain",
// "hardlink" (a second link beside it) or "symlink" (to a file beside it).
function reloadFixture(base, id, manifest) {
  const plugin = path.join(base, id);
  const build = path.join(plugin, "dist", "control-ui");
  fs.mkdirSync(build, {recursive: true});
  fs.writeFileSync(path.join(build, "index.js"), "export default {};\n");
  const file = path.join(plugin, "openclaw.plugin.json");
  const body = JSON.stringify({id, configSchema: {type: "object"}, controlUi: declaration}) + "\n";
  if (manifest === "symlink") {
    fs.writeFileSync(path.join(plugin, "manifest.json"), body);
    fs.symlinkSync("manifest.json", file);
  } else {
    fs.writeFileSync(file, body);
    if (manifest === "hardlink") fs.linkSync(file, path.join(plugin, "manifest.link"));
  }
  assert.equal(fs.lstatSync(file).nlink, manifest === "hardlink" ? 2 : 1);
  return plugin;
}
// Activate a registry holding these plugins, reload each one's UI, and return the
// ids whose reload left a diagnostic.
async function reloadFailures(plugins) {
  const registry = createEmptyPluginRegistry();
  for (const [id, rootDir, controlUi = declaration] of plugins) {
    registry.plugins.push({id, name: id, origin: "bundled", enabled: true, status: "loaded", rootDir, controlUi});
  }
  setActivePluginRegistry(registry);
  const listed = await listCatalog();
  for (const [id] of plugins) assert(listed.plugins.some((module) => module.pluginId === id), `${id} is not served before the reload`);
  const failed = [];
  for (const [id] of plugins) {
    const catalog = await reloadCatalog(id);
    if (catalog.diagnostics.some((diagnostic) => diagnostic.pluginId === id)) failed.push(id);
  }
  return failed;
}

const storeRoot = fs.realpathSync(root).startsWith("/nix/store/");
if (storeRoot) {
  const inStore = fs.mkdtempSync(path.join(root, ".control-ui-hardlink-test-"));
  try {
    const {entryName, assets} = await read(fixture(inStore), declaration);
    assert.equal(entryName, "index.js");
    assert(assets.has("index.js") && assets.has("alias.js"));
    assert.deepEqual(await reloadFailures([
      ["store-hardlinked-manifest", reloadFixture(inStore, "store-hardlinked-manifest", "hardlink")],
      ["store-symlinked-manifest", reloadFixture(inStore, "store-symlinked-manifest", "symlink")],
    ]), ["store-symlinked-manifest"], "a hardlinked store manifest must reload and a symlinked one must not");
  } finally {
    fs.rmSync(inStore, {recursive: true, force: true});
  }
} else {
  console.log("Control UI store hardlinks: not in /nix/store, only the refusals are checked");
}

const outside = fs.mkdtempSync(path.join(os.tmpdir(), "control-ui-hardlink-test-"));
try {
  await assert.rejects(read(fixture(outside), declaration), "hard links outside /nix/store must stay refused");
  assert.deepEqual(await reloadFailures([
    ["plain-manifest", reloadFixture(outside, "plain-manifest", "plain")],
    ["hardlinked-manifest", reloadFixture(outside, "hardlinked-manifest", "hardlink")],
  ]), ["hardlinked-manifest"], "outside /nix/store a plain manifest reloads and a hardlinked one stays refused");
} finally {
  fs.rmSync(outside, {recursive: true, force: true});
}

if (!storeRoot) process.exit(0);

const served = [];
const runtimeExtensions = path.join(root, "dist-runtime", "extensions");
for (const id of fs.readdirSync(runtimeExtensions)) {
  const manifestPath = path.join(runtimeExtensions, id, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) continue;
  const {id: pluginId, controlUi} = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!controlUi?.entry) continue;
  await read(path.join(runtimeExtensions, id), controlUi);
  served.push([pluginId, path.join(runtimeExtensions, id), controlUi]);
}
const ids = served.map(([id]) => id);
assert(ids.includes("workboard"), `bundled native UIs read: ${ids.join(", ") || "none"}`);
assert.deepEqual(await reloadFailures(served), [], "every bundled native UI must reload");
console.log(`Control UI store hardlinks: store builds and manifests read, outside refused; bundled UIs read and reloaded: ${ids.join(", ")}`);
