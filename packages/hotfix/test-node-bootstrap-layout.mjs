// Pack the real cloud-worker node bootstrap from this package exactly as
// environments.create does, without state, network, a gateway, or a provider.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = fs.realpathSync(process.argv[2]);
const dist = path.join(root, "dist");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".node-bootstrap-layout-hotfix.json"), "utf8"));
// From 11.5 the build and worker helpers share the node-bootstrap-artifact- prefix;
// the provider is the chunk that exports it.
const providerModules = fs.readdirSync(dist).filter((name) => /^node-bootstrap-artifact-.*\.mjs$/.test(name)
  && /export\s*\{[^}]*\bcreateNodeBootstrapArtifactProvider\b[^}]*\}/.test(fs.readFileSync(path.join(dist, name), "utf8")));
assert.equal(providerModules.length, 1, `expected one node bootstrap provider, found: ${providerModules.join(", ") || "none"}`);
const [artifactModule] = providerModules;
const { createNodeBootstrapArtifactProvider } = await import(pathToFileURL(path.join(dist, artifactModule)).href);
const { buildId } = JSON.parse(fs.readFileSync(path.join(dist, "build-info.json"), "utf8"));
// plugins: [] is what worker-turn profiles pass (resolveNodeBootstrapPlugins).
const provider = createNodeBootstrapArtifactProvider({ packageRoot: root, runningBuildId: buildId, plugins: [] });
try {
  const artifact = await provider.prepare();
  assert.equal(artifact.buildId, buildId);
  const listing = spawnSync("tar", ["-tzf", artifact.tarballPath], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.equal(listing.status, 0, listing.stderr);
  // npm tarball layout: every entry sits under package/.
  const entries = new Set(listing.stdout.split("\n").filter(Boolean).map((entry) => {
    assert(entry.startsWith("package/"), `unexpected tarball entry ${entry}`);
    return entry.slice("package/".length);
  }));
  for (const relative of [...(receipt.runtimeFiles ?? [...receipt.launchers, ...receipt.scripts]), "dist/entry.js", "package.json"]) {
    assert(entries.has(relative), `node bootstrap lacks ${relative}`);
  }
  assert(![...entries].some((entry) => /^dist\/extensions\/[^/]+\/node_modules(\/|$)/.test(entry)), "plugin dependency trees leaked into the node bootstrap");
  console.log(`Node bootstrap packs: ${entries.size} entries, ${artifact.tarballBytes} bytes`);
} finally {
  await provider.close();
}
