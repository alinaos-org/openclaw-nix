// 10.2 native Control UI: readPluginControlUiAssets opens a plugin's browser build
// with hardlinks "reject", which keeps a writable plugin folder from smuggling a
// hardlink to a private file into the served assets. Nix store optimisation
// hardlinks every identical store file, so the bundled plugins' builds (workboard,
// slack, discord) all have nlink > 1 and were refused as "declared browser assets
// are missing". Allow hard links only when the plugin root's real path is in
// /nix/store: store files are immutable and world-readable, and their links come
// only from deduplication. Symlinks stay rejected.
//
// v2: an explicit Control UI reload (reloadControlUiPluginCatalog) rereads the
// plugin's manifest with loadPluginManifest(rootDir, rejectHardlinks = true, ...),
// although discovery reads bundled manifests with hardlinks allowed. Bundled
// workboard's openclaw.plugin.json has 30 store links, so every reload of a bundled
// panel failed ("Control UI assets could not be loaded"). The reload now passes
// rejectHardlinks = false for the same /nix/store roots only; loadPluginManifest
// refuses symlinked manifests either way.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.2"), "Control UI store hardlink hotfix is qualified from 2026.10.2");
const dist = path.join(root, "dist");

const ID = "openclaw-nix-control-ui-store-hardlinks-v2";
const MARKER = `/* ${ID} */`;
const storeRootHelper = (name) => [
  `function ${name}(rootDir) { ${MARKER}`,
  "\ttry { return process.getBuiltinModule(\"node:fs\").realpathSync(rootDir).startsWith(\"/nix/store/\"); } catch { return false; }",
  "}",
].join("\n");
const HELPER = "openclawNixImmutableStoreRoot";
// The reload's own copy: in a bundle that carries both, the reader's helper may live
// in another scope.
const MANIFEST_HELPER = "openclawNixImmutableStoreManifestRoot";
const V = "[\\w$]+";
// The source form and the minified worker copies: the reader opens its first
// parameter as the asset root with hardlinks rejected.
const reader = /async function readPluginControlUiAssets\(([\w$]+),\s*[\w$]+\)\s*\{\s*(?:const|let)\s+[\w$]+\s*=\s*await\s+[\w$]+\(\1,\s*\{\s*hardlinks:\s*(["`])reject\2/g;
// The reload: `const loaded = withPluginCache(createPluginCache(), () =>
// loadPluginManifest(record.rootDir, true, record.rootDir));` followed by the
// declaration check. Group 2 is the record, group 3 the rejectHardlinks argument.
const reload = new RegExp(`(?:const|let)\\s+(${V})\\s*=\\s*${V}\\(\\s*${V}\\(\\s*\\)\\s*,\\s*\\(\\s*\\)\\s*=>\\s*${V}\\(\\s*(${V})\\.rootDir\\s*,\\s*(true|!0)\\s*,\\s*\\2\\.rootDir\\s*\\)\\s*\\)\\s*;?\\s*`
  + `if\\s*\\(\\s*!\\1\\.ok\\s*\\|\\|\\s*\\1\\.manifest\\.id\\s*!==\\s*\\2\\.id\\s*\\|\\|\\s*!\\1\\.manifest\\.controlUi\\s*\\)\\s*throw\\s+(?:new\\s+)?Error\\(\\s*(["'\`])active plugin browser declaration is missing or invalid\\4\\s*\\)`, "gd");
const count = (text, needle) => text.split(needle).length - 1;

// The second argument the reload passes is loadPluginManifest's rejectHardlinks.
const manifestDefinitions = fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))
  .filter((name) => fs.readFileSync(path.join(dist, name), "utf8").includes("function loadPluginManifest(rootDir, rejectHardlinks = true, rootRealPath) {"));
assert.equal(manifestDefinitions.length, 1, `loadPluginManifest(rootDir, rejectHardlinks, rootRealPath) signature changed: ${manifestDefinitions.join(", ")}`);

function* scripts(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "extensions") yield* scripts(file);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) yield file;
  }
}

const patchedFiles = [];
const manifestReloadFiles = [];
for (const file of scripts(dist)) {
  let text = fs.readFileSync(file, "utf8");
  const definitions = count(text, "async function readPluginControlUiAssets(");
  const reloads = count(text, "active plugin browser declaration is missing or invalid");
  if (definitions === 0 && reloads === 0) continue;
  const name = path.relative(root, file);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);

  if (definitions > 0) {
    assert.equal(definitions, 1, `readPluginControlUiAssets repeated in ${name}`);
    let anchors = 0;
    text = text.replace(reader, (match, rootParam, quote) => {
      anchors += 1;
      const head = match.slice(0, match.length - `${quote}reject${quote}`.length);
      return `${head}${HELPER}(${rootParam}) ? "allow" : "reject"`;
    });
    assert.equal(anchors, 1, `Control UI asset reader anchor changed in ${name}`);
    text = text.replace("async function readPluginControlUiAssets(", `${storeRootHelper(HELPER)}\nasync function readPluginControlUiAssets(`);
    patchedFiles.push(name);
  }

  if (reloads > 0) {
    assert.equal(reloads, 1, `Control UI manifest reload repeated in ${name}`);
    const found = [...text.matchAll(reload)];
    assert.equal(found.length, 1, `Control UI manifest reload anchor changed in ${name}`);
    const [m] = found;
    const refresh = "async function refreshBrowserCatalog(";
    assert.equal(count(text, refresh), 1, `${name}: refreshBrowserCatalog moved`);
    assert.equal(text.lastIndexOf("async function ", m.index), text.indexOf(refresh), `${name}: the manifest reload is no longer in refreshBrowserCatalog`);
    const record = m[2];
    const [flagStart, flagEnd] = m.indices[3];
    text = text.slice(0, flagStart) + `!${MANIFEST_HELPER}(${record}.rootDir)` + text.slice(flagEnd);
    text = text.replace(refresh, `${storeRootHelper(MANIFEST_HELPER)}\n${refresh}`);
    manifestReloadFiles.push(name);
  }
  fs.writeFileSync(file, text);
}
assert(patchedFiles.some((name) => /^dist\/control-ui-assets-[^/]+\.mjs$/.test(name)), "Control UI asset chunk not patched");
assert(manifestReloadFiles.some((name) => /^dist\/control-ui-plugin-assets-[^/]+\.mjs$/.test(name)), "Control UI manifest reload chunk not patched");

fs.writeFileSync(path.join(root, ".control-ui-store-hardlinks-hotfix.json"), JSON.stringify({
  id: ID, upstreamVersion: version, patchedFiles, manifestReloadFiles,
}, null, 2) + "\n");
console.log(`Control UI: store hardlinks allowed in ${patchedFiles.join(", ")}; manifest reload in ${manifestReloadFiles.join(", ")}`);
