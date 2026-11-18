// Every copy of an MCP client package in the final tree is at least the line whose
// auth() binds saved OAuth client information and tokens to their authorization
// server (CVE-2026-104850, GHSA-6qxp-vccf-f47h); the MCP OAuth issuer hotfix relies on
// that binding. The packages: @modelcontextprotocol/sdk from 1.31.0, and from
// 2026.11.5, whose provider calls it, @modelcontextprotocol/client (SEP-2352) from
// 2.3.1, the release the hotfix was qualified against; lower that floor only after
// checking an older 2.x has the stamp check. A copy is a package directory reached as
// node_modules/@modelcontextprotocol/<package> anywhere in the tree: the pnpm store
// (node_modules/.pnpm), plugin trees under dist/extensions and
// dist-runtime/extensions, and plugins grafted in later. Module links are followed
// as node resolves them, out of the tree too, since a plugin's node_modules can link
// another store path. Bundled copies carry no version; the ones OpenClaw's MCP OAuth
// provider calls are checked by test-mcp-oauth-issuer-binding.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FLOORS = {sdk: "1.31.0", client: "2.3.1"};
const [root] = process.argv.slice(2);
assert(root && fs.statSync(root).isDirectory(), "usage: test-mcp-sdk-floor.mjs <lib/openclaw>");

// Semver order; a pre-release of the floor is older than the floor.
const semver = (version) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
function meetsFloor(version, minimum) {
  const v = semver(version), floor = semver(minimum);
  if (!v) return false;
  for (let i = 1; i <= 3; i++) if (Number(v[i]) !== Number(floor[i])) return Number(v[i]) > Number(floor[i]);
  return v[4] === undefined;
}
assert(meetsFloor("1.31.0", FLOORS.sdk) && meetsFloor("1.32.0", FLOORS.sdk) && meetsFloor("2.0.0", FLOORS.sdk) && !meetsFloor("1.30.9", FLOORS.sdk) && !meetsFloor("1.31.0-beta.1", FLOORS.sdk) && !meetsFloor("x", FLOORS.sdk));
assert(meetsFloor("2.3.1", FLOORS.client) && meetsFloor("2.10.0", FLOORS.client) && !meetsFloor("2.3.0", FLOORS.client) && !meetsFloor("1.32.1", FLOORS.client));

const copies = new Map(); // real package directory -> {pkg, version}
// The tree itself counts as visited: plugins link it back as their `openclaw` package.
const visited = new Set([fs.realpathSync(root)]);
const mcpPackage = (dir, name) => (Object.hasOwn(FLOORS, name) && path.basename(dir) === "@modelcontextprotocol" && path.basename(path.dirname(dir)) === "node_modules" ? name : undefined);
function walk(dir, inModules) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const link = entry.isSymbolicLink();
    if (!entry.isDirectory() && !link) continue;
    // Links are followed where module resolution follows them: into and inside node_modules.
    const modules = inModules || entry.name === "node_modules";
    if (link && !modules) continue;
    const at = path.join(dir, entry.name);
    let real;
    try { real = fs.realpathSync(at); } catch { continue; } // a dangling link resolves nothing
    if (!fs.statSync(real).isDirectory()) continue;
    const pkg = mcpPackage(dir, entry.name) ?? mcpPackage(path.dirname(real), path.basename(real));
    if (!copies.has(real) && pkg) {
      const manifest = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
      assert.equal(manifest.name, `@modelcontextprotocol/${pkg}`, `${at}: not the ${pkg} package`);
      copies.set(real, {pkg, version: String(manifest.version)});
    }
    if (visited.has(real)) continue;
    visited.add(real);
    walk(at, modules);
  }
}
walk(root, false);

// Each package the tree's own package.json depends on must have a copy: one that is
// missing means the tree layout changed, not that the floor holds.
const dependencies = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {};
assert(Object.hasOwn(dependencies, "@modelcontextprotocol/sdk") || Object.hasOwn(dependencies, "@modelcontextprotocol/client"), "the tree depends on no MCP client package: its layout changed");
for (const pkg of Object.keys(FLOORS)) {
  if (Object.hasOwn(dependencies, `@modelcontextprotocol/${pkg}`)) {
    assert([...copies.values()].some((copy) => copy.pkg === pkg), `no @modelcontextprotocol/${pkg} copy found: the tree layout changed`);
  }
}
const shown = (real) => (real.startsWith(fs.realpathSync(root) + path.sep) ? path.relative(fs.realpathSync(root), real) : real);
const old = [...copies].filter(([, {pkg, version}]) => !meetsFloor(version, FLOORS[pkg]));
assert.equal(old.length, 0, `MCP client packages older than their floor (${Object.entries(FLOORS).map(([pkg, floor]) => `${pkg} ${floor}`).join(", ")}):\n${old.map(([real, {pkg, version}]) => `  @modelcontextprotocol/${pkg} ${version} at ${shown(real)}`).join("\n")}`);
console.log(`MCP SDK floor ${Object.entries(FLOORS).map(([pkg, floor]) => `${pkg} ${floor}`).join(", ")}: ${[...copies].map(([real, {pkg, version}]) => `${pkg} ${version} at ${shown(real)}`).join("; ")}`);
