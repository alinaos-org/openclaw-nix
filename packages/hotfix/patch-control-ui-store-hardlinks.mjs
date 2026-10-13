// 10.2 native Control UI: readPluginControlUiAssets opens a plugin's browser build
// with hardlinks "reject", which keeps a writable plugin folder from smuggling a
// hardlink to a private file into the served assets. Nix store optimisation
// hardlinks every identical store file, so the bundled plugins' builds (workboard,
// slack, discord) all have nlink > 1 and were refused as "declared browser assets
// are missing". Allow hard links only when the plugin root's real path is in
// /nix/store: store files are immutable and world-readable, and their links come
// only from deduplication. Symlinks stay rejected.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.2"), "Control UI store hardlink hotfix is qualified from 2026.10.2");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-control-ui-store-hardlinks-v1 */";
const HELPER = "openclawNixImmutableStoreRoot";
const helper = [
  `function ${HELPER}(rootDir) { ${MARKER}`,
  "\ttry { return process.getBuiltinModule(\"node:fs\").realpathSync(rootDir).startsWith(\"/nix/store/\"); } catch { return false; }",
  "}",
].join("\n");
// The source form and the minified worker copies: the reader opens its first
// parameter as the asset root with hardlinks rejected.
const reader = /async function readPluginControlUiAssets\(([\w$]+),\s*[\w$]+\)\s*\{\s*(?:const|let)\s+[\w$]+\s*=\s*await\s+[\w$]+\(\1,\s*\{\s*hardlinks:\s*(["`])reject\2/g;
const count = (text, needle) => text.split(needle).length - 1;

function* scripts(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "extensions") yield* scripts(file);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) yield file;
  }
}

const patchedFiles = [];
for (const file of scripts(dist)) {
  const text = fs.readFileSync(file, "utf8");
  const definitions = count(text, "async function readPluginControlUiAssets(");
  if (definitions === 0) continue;
  const name = path.relative(root, file);
  assert.equal(definitions, 1, `readPluginControlUiAssets repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  let anchors = 0;
  const patched = text.replace(reader, (match, rootParam, quote) => {
    anchors += 1;
    const head = match.slice(0, match.length - `${quote}reject${quote}`.length);
    return `${head}${HELPER}(${rootParam}) ? "allow" : "reject"`;
  });
  assert.equal(anchors, 1, `Control UI asset reader anchor changed in ${name}`);
  fs.writeFileSync(file, patched.replace("async function readPluginControlUiAssets(", `${helper}\nasync function readPluginControlUiAssets(`));
  patchedFiles.push(name);
}
assert(patchedFiles.some((name) => /^dist\/control-ui-assets-[^/]+\.mjs$/.test(name)), "Control UI asset chunk not patched");

fs.writeFileSync(path.join(root, ".control-ui-store-hardlinks-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-control-ui-store-hardlinks-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Control UI: store hardlinks allowed in ${patchedFiles.join(", ")}`);
