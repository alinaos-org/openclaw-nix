// The patched Control UI asset reader serves a browser build whose files are hard
// links when the plugin root is in /nix/store (this layer's own output during the
// build), still refuses the same build outside the store, and every bundled native
// UI in the runtime tree reads. Outside the store (scripts/scratch-patch-chain.sh
// runs the layer on a scratch copy, whose files keep their mutual hard links), only
// the refusal can be checked.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".control-ui-store-hardlinks-hotfix.json"), "utf8"));
const chunk = receipt.patchedFiles.find((name) => /^dist\/control-ui-assets-[^/]+\.mjs$/.test(name));
const source = fs.readFileSync(path.join(root, chunk), "utf8");
const alias = source.match(/readPluginControlUiAssets as ([\w$]+)/)?.[1];
assert(alias, "readPluginControlUiAssets is no longer exported from its chunk");
const read = (await import(pathToFileURL(path.join(root, chunk)).href))[alias];
assert.equal(typeof read, "function");

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

const storeRoot = fs.realpathSync(root).startsWith("/nix/store/");
if (storeRoot) {
  const inStore = fs.mkdtempSync(path.join(root, ".control-ui-hardlink-test-"));
  try {
    const {entryName, assets} = await read(fixture(inStore), declaration);
    assert.equal(entryName, "index.js");
    assert(assets.has("index.js") && assets.has("alias.js"));
  } finally {
    fs.rmSync(inStore, {recursive: true, force: true});
  }
} else {
  console.log("Control UI store hardlinks: not in /nix/store, only the refusal is checked");
}

const outside = fs.mkdtempSync(path.join(os.tmpdir(), "control-ui-hardlink-test-"));
try {
  await assert.rejects(read(fixture(outside), declaration), "hard links outside /nix/store must stay refused");
} finally {
  fs.rmSync(outside, {recursive: true, force: true});
}

if (!storeRoot) process.exit(0);

const served = [];
const runtimeExtensions = path.join(root, "dist-runtime", "extensions");
for (const id of fs.readdirSync(runtimeExtensions)) {
  const manifestPath = path.join(runtimeExtensions, id, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) continue;
  const {controlUi} = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!controlUi?.entry) continue;
  await read(path.join(runtimeExtensions, id), controlUi);
  served.push(id);
}
assert(served.includes("workboard"), `bundled native UIs read: ${served.join(", ") || "none"}`);
console.log(`Control UI store hardlinks: store builds read, outside refused; bundled UIs read: ${served.join(", ")}`);
