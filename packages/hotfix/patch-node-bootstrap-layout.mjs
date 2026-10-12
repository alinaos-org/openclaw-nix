// 9.8 cloud workers enroll an OpenClaw node from a bootstrap tarball that the
// gateway packs from its own install (dist/node-bootstrap-artifact-*.mjs). That
// packer assumes the npm layout. The Nix gateway differs in two ways, so every
// environments.create failed before any provider call with
// "Unsafe package dist path: dist/extensions/<id>/node_modules":
//  1. default.nix exposes each bundled plugin's dependency tree as a
//     dist/extensions/<id>/node_modules symlink. Upstream already leaves that
//     subtree out of the package (isOmittedDistSubtree) but rejects a symlink
//     before it checks the omission. Skip such a symlink without following it;
//     a symlink anywhere else in dist still throws.
//  2. The npm package's root launchers and packaged scripts/ are never
//     installed. Copy exactly the files the packer selects from the pinned
//     upstream source.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, source, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && source && atLeast(version, "2026.9.8"), "node-bootstrap layout hotfix is qualified from 2026.9.8");
const dist = path.join(root, "dist");

// The packer is the module that defines BOOTSTRAP_LAUNCHER_FILES: the top-level
// node-bootstrap-artifact chunk through 9.9, a worker thread from 10.1
// (gateway/worker-environments/node-bootstrap-artifact.worker.js, which imports the
// inventory from ../../ instead of ./).
const workerPacker = "gateway/worker-environments/node-bootstrap-artifact.worker.js";
const packerCandidates = [
  ...fs.readdirSync(dist).filter((name) => /^node-bootstrap-artifact-.*\.mjs$/.test(name)),
  ...(fs.existsSync(path.join(dist, workerPacker)) ? [workerPacker] : []),
].filter((name) => fs.readFileSync(path.join(dist, name), "utf8").includes("const BOOTSTRAP_LAUNCHER_FILES = ["));
assert.equal(packerCandidates.length, 1, `expected exactly one node bootstrap packer, found: ${packerCandidates.join(", ")}`);
const [artifactModule] = packerCandidates;
const artifactSource = fs.readFileSync(path.join(dist, artifactModule), "utf8");
const inventoryModule = /from "(?:\.\/|(?:\.\.\/)+)(package-dist-inventory-[^"\/]+\.mjs)"/.exec(artifactSource)?.[1];
assert(inventoryModule, "node bootstrap no longer imports the package dist inventory");

const before = "if (entry.isSymbolicLink()) throw new Error(`Unsafe package dist path: ${relativePath}`);";
const after = "if (entry.isSymbolicLink()) { if (isOmittedDistSubtree(relativePath, rules)) return []; /* openclaw-nix-node-bootstrap-layout-v1 */ throw new Error(`Unsafe package dist path: ${relativePath}`); }";
const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  const text = fs.readFileSync(file, "utf8");
  const count = text.split(before).length - 1;
  if (count === 0) continue;
  assert.equal(count, 1, `symlink anchor repeated in ${name}`);
  assert(text.includes("function isOmittedDistSubtree(relativePath, rules) {"), `${name} lacks isOmittedDistSubtree`);
  fs.writeFileSync(file, text.replace(before, after));
  patchedFiles.push(name);
}
assert(patchedFiles.includes(inventoryModule), `symlink anchor changed in ${inventoryModule}`);

const launcherList = /const BOOTSTRAP_LAUNCHER_FILES = \[([^\]]*)\];/.exec(artifactSource)?.[1];
assert(launcherList, "BOOTSTRAP_LAUNCHER_FILES anchor changed");
const launchers = [...launcherList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert(launchers.includes("openclaw.mjs"), "bootstrap launchers no longer include openclaw.mjs");
// Same selection as the packer: literal scripts/ entries of package.json files.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const scripts = (manifest.files ?? []).filter((entry) => entry.startsWith("scripts/") && !entry.includes("*") && !entry.endsWith("/"));
for (const relative of [...launchers, ...scripts]) {
  assert(!path.isAbsolute(relative) && !relative.split("/").includes(".."), `unsafe packaged path ${relative}`);
  const from = path.join(source, relative);
  const to = path.join(root, relative);
  assert(fs.lstatSync(from).isFile(), `upstream source lacks ${relative}`);
  assert(!fs.existsSync(to), `refusing to overwrite installed ${relative}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, fs.statSync(from).mode & 0o555);
}

fs.writeFileSync(path.join(root, ".node-bootstrap-layout-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-node-bootstrap-layout-v1", upstreamVersion: version, patchedFiles, launchers, scripts,
}, null, 2) + "\n");
console.log(`Node bootstrap layout: skipped omitted-subtree symlinks in ${patchedFiles.join(", ")}; installed ${launchers.length} launchers and ${scripts.length} scripts`);
