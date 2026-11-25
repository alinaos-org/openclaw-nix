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
const MARKER = "/* openclaw-nix-node-bootstrap-layout-v1 */";

// Through 11.4 the packer packs a fixed BOOTSTRAP_LAUNCHER_FILES list plus the
// literal scripts/ entries of package.json files. From 11.5 on it drops that list
// and packs every literal package.json files entry under scripts/ or ending in
// .[cm]?[jt]s ("runtimeFiles"), which adds root helpers such as cli-invocation.mjs,
// the .d.mts declarations and src/infra/directory-walk.ts.
const packageFilesSelection = atLeast(version, "2026.11.5");
const launcherAnchor = "const BOOTSTRAP_LAUNCHER_FILES = [";
const runtimeFilesAnchor = /const [\w$]+\s*=\s*\([\w$]+\.files\s*\?\?\s*\[\]\)\.filter\(\(?([\w$]+)\)?\s*=>\s*\(\1\.startsWith\(["\x60]scripts\/["\x60]\)\s*\|\|\s*\/\\\.\[cm\]\?\[jt\]s\$\/u\.test\(\1\)\)\s*&&\s*!\1\.startsWith\(["\x60]!["\x60]\)\s*&&\s*!\1\.includes\(["\x60]\*["\x60]\)\s*&&\s*!\1\.endsWith\(["\x60]\/["\x60]\)\);/g;
const count = (text, anchor) => typeof anchor === "string" ? text.split(anchor).length - 1 : [...text.matchAll(anchor)].length;
const packerAnchor = packageFilesSelection ? runtimeFilesAnchor : launcherAnchor;

// The packer is the top-level node-bootstrap-artifact chunk through 9.9, a worker
// thread from 10.1 (gateway/worker-environments/node-bootstrap-artifact.worker.js,
// which imports the inventory from ../../ instead of ./), and from 11.5 the
// node-bootstrap-artifact-build chunk that worker imports on demand.
const workerPacker = "gateway/worker-environments/node-bootstrap-artifact.worker.js";
const packerCandidates = [
  ...fs.readdirSync(dist).filter((name) => /^node-bootstrap-artifact-.*\.mjs$/.test(name)),
  ...(fs.existsSync(path.join(dist, workerPacker)) ? [workerPacker] : []),
].filter((name) => count(fs.readFileSync(path.join(dist, name), "utf8"), packerAnchor) > 0);
assert.equal(packerCandidates.length, 1, `expected exactly one node bootstrap packer, found: ${packerCandidates.join(", ") || "none"}`);
const [artifactModule] = packerCandidates;
const artifactSource = fs.readFileSync(path.join(dist, artifactModule), "utf8");
assert.equal(count(artifactSource, packerAnchor), 1, `node bootstrap packer selection repeated in ${artifactModule}`);
if (packageFilesSelection) assert(!artifactSource.includes(launcherAnchor), `${artifactModule} still has BOOTSTRAP_LAUNCHER_FILES`);
const inventoryImports = [...artifactSource.matchAll(/from\s*"(?:\.\/|(?:\.\.\/)+)(package-dist-inventory-[^"\/]+\.mjs)"/g)];
assert.equal(inventoryImports.length, 1, "expected one package dist inventory import");
const inventoryModule = inventoryImports[0][1];

// Readable through 11.4 (entry/relativePath/rules); the inventory chunk is minified
// from 11.5 on, so take the names from the code: the rules are collectRelativeFiles'
// third parameter.
const symlinkThrow = /if\s*\(([\w$]+)\.isSymbolicLink\(\)\)\s*throw new Error\(`Unsafe package dist path: \$\{([\w$]+)\}`\);/g;
const walkerHeader = /async function collectRelativeFiles\([\w$]+,\s*[\w$]+,\s*([\w$]+),\s*[\w$]+\)\s*\{/g;
const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  const text = fs.readFileSync(file, "utf8");
  const throws = [...text.matchAll(symlinkThrow)];
  if (throws.length === 0) continue;
  assert.equal(throws.length, 1, `symlink anchor repeated in ${name}`);
  assert.equal(count(text, /function isOmittedDistSubtree\([\w$]+,\s*[\w$]+\)\s*\{/g), 1, `${name} lacks isOmittedDistSubtree`);
  const headers = [...text.matchAll(walkerHeader)];
  assert.equal(headers.length, 1, `${name}: expected one collectRelativeFiles`);
  const [throwMatch] = throws, [header] = headers;
  const between = text.slice(header.index, throwMatch.index);
  assert(throwMatch.index > header.index && !/\b(?:async )?function /.test(between.slice(header[0].length)), `${name}: symlink check is outside collectRelativeFiles`);
  const [anchor, entry, relative] = throwMatch, rules = header[1];
  assert(new RegExp(`isOmittedDistSubtree\\([\\w$]+,\\s*${rules.replace(/\$/g, "\\$")}\\)`).test(between), `${name}: collectRelativeFiles no longer checks omissions with ${rules}`);
  const after = `if (${entry}.isSymbolicLink()) { if (isOmittedDistSubtree(${relative}, ${rules})) return []; ${MARKER} throw new Error(\`Unsafe package dist path: \${${relative}}\`); }`;
  fs.writeFileSync(file, text.replace(anchor, () => after));
  patchedFiles.push(name);
}
assert(patchedFiles.includes(inventoryModule), `symlink anchor changed in ${inventoryModule}`);

if (atLeast(version, "2026.11.10")) {
  assert.deepEqual(patchedFiles, [inventoryModule, "managed-handoff-runtime.mjs", "package-update-activation-recovery.mjs"].sort(),
    "node bootstrap inventory copies changed");
}

// Same selection as the packer.
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const literal = (entry) => !entry.startsWith("!") && !entry.includes("*") && !entry.endsWith("/");
let launchers, scripts, runtimeFiles;
if (packageFilesSelection) {
  runtimeFiles = (manifest.files ?? []).filter((entry) => (entry.startsWith("scripts/") || /\.[cm]?[jt]s$/u.test(entry)) && literal(entry));
  launchers = runtimeFiles.filter((entry) => !entry.includes("/"));
  scripts = runtimeFiles.filter((entry) => entry.startsWith("scripts/"));
} else {
  const launcherList = /const BOOTSTRAP_LAUNCHER_FILES = \[([^\]]*)\];/.exec(artifactSource)?.[1];
  assert(launcherList, "BOOTSTRAP_LAUNCHER_FILES anchor changed");
  launchers = [...launcherList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  scripts = (manifest.files ?? []).filter((entry) => entry.startsWith("scripts/") && !entry.includes("*") && !entry.endsWith("/"));
  runtimeFiles = [...launchers, ...scripts];
}
assert(launchers.includes("openclaw.mjs"), "bootstrap launchers no longer include openclaw.mjs");
for (const relative of runtimeFiles) {
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
  id: "openclaw-nix-node-bootstrap-layout-v1", upstreamVersion: version, patchedFiles,
  selection: packageFilesSelection ? "package-files" : "launcher-list", launchers, scripts, runtimeFiles,
}, null, 2) + "\n");
console.log(`Node bootstrap layout: skipped omitted-subtree symlinks in ${patchedFiles.join(", ")}; installed ${runtimeFiles.length} runtime files (${launchers.length} launchers, ${scripts.length} scripts) for ${artifactModule}`);
