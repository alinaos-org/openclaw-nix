// Every copy of @modelcontextprotocol/sdk in the final tree is at least 1.31.0, the
// line whose auth() binds saved OAuth client information and tokens to their
// authorization server (CVE-2026-104850, GHSA-6qxp-vccf-f47h); the MCP OAuth issuer
// hotfix relies on that binding. A copy is a package directory reached as
// node_modules/@modelcontextprotocol/sdk anywhere in the tree: the pnpm store
// (node_modules/.pnpm), plugin trees under dist/extensions and
// dist-runtime/extensions, and plugins grafted in later. Module links are followed
// as node resolves them, out of the tree too, since a plugin's node_modules can link
// another store path. Bundled copies carry no version; the ones OpenClaw's MCP OAuth
// provider calls are checked by test-mcp-oauth-issuer-binding.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const FLOOR = "1.31.0";
const [root] = process.argv.slice(2);
assert(root && fs.statSync(root).isDirectory(), "usage: test-mcp-sdk-floor.mjs <lib/openclaw>");

// Semver order; a pre-release of the floor is older than the floor.
const semver = (version) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
const floor = semver(FLOOR);
function meetsFloor(version) {
  const v = semver(version);
  if (!v) return false;
  for (let i = 1; i <= 3; i++) if (Number(v[i]) !== Number(floor[i])) return Number(v[i]) > Number(floor[i]);
  return v[4] === undefined;
}
assert(meetsFloor("1.31.0") && meetsFloor("1.32.0") && meetsFloor("2.0.0") && !meetsFloor("1.30.9") && !meetsFloor("1.31.0-beta.1") && !meetsFloor("x"));

const copies = new Map(); // real package directory -> version
// The tree itself counts as visited: plugins link it back as their `openclaw` package.
const visited = new Set([fs.realpathSync(root)]);
const isSdk = (dir, name) => name === "sdk" && path.basename(dir) === "@modelcontextprotocol" && path.basename(path.dirname(dir)) === "node_modules";
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
    if (!copies.has(real) && (isSdk(dir, entry.name) || isSdk(path.dirname(real), path.basename(real)))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(real, "package.json"), "utf8"));
      assert.equal(manifest.name, "@modelcontextprotocol/sdk", `${at}: not the SDK package`);
      copies.set(real, String(manifest.version));
    }
    if (visited.has(real)) continue;
    visited.add(real);
    walk(at, modules);
  }
}
walk(root, false);

assert(copies.size > 0, "no @modelcontextprotocol/sdk copy found: the tree layout changed");
const shown = (real) => (real.startsWith(fs.realpathSync(root) + path.sep) ? path.relative(fs.realpathSync(root), real) : real);
const old = [...copies].filter(([, version]) => !meetsFloor(version));
assert.equal(old.length, 0, `@modelcontextprotocol/sdk older than ${FLOOR}:\n${old.map(([real, version]) => `  ${version} at ${shown(real)}`).join("\n")}`);
console.log(`MCP SDK floor ${FLOOR}: ${[...copies].map(([real, version]) => `${version} at ${shown(real)}`).join("; ")}`);
