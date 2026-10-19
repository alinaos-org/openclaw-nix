// Behavioural check for patch-cloud-worker-gateway-url.mjs on the installed tree:
// the injected helper prefers OPENCLAW_CLOUD_WORKER_GATEWAY_URL and falls back to the
// device-pair publicUrl, and upstream's resolver keeps a Funnel URL (with its port) on
// the publicUrl branch, which pins no TLS fingerprint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root, sampleUrl = "wss://gateway.example.ts.net:10000"] = process.argv.slice(2);
const dist = path.join(root, "dist");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".cloud-worker-gateway-url-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-cloud-worker-gateway-url-v1");

for (const name of receipt.patchedFiles) {
  const file = path.join(dist, name);
  execFileSync(process.execPath, ["--check", file]);
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf("function resolveCloudWorkerGatewayPublicUrl(config) {");
  const end = text.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `${name}: helper missing`);
  const helper = text.slice(start, end + 2);
  const run = (env) => vm.runInNewContext(`${helper}\nresolveCloudWorkerGatewayPublicUrl({ pairing: "tailnet" })`, {
    process: { env },
    resolveConfiguredPairingPublicUrl: (config) => `device-pair:${config.pairing}`,
  });
  assert.equal(run({ OPENCLAW_CLOUD_WORKER_GATEWAY_URL: sampleUrl }), sampleUrl, `${name}: override ignored`);
  assert.equal(run({ OPENCLAW_CLOUD_WORKER_GATEWAY_URL: ` ${sampleUrl}\n` }), sampleUrl, `${name}: override not trimmed`);
  assert.equal(run({ OPENCLAW_CLOUD_WORKER_GATEWAY_URL: " \t" }), "device-pair:tailnet", `${name}: blank override not ignored`);
  assert.equal(run({ OPENCLAW_CLOUD_WORKER_GATEWAY_URL: "" }), "device-pair:tailnet", `${name}: empty override not ignored`);
  assert.equal(run({}), "device-pair:tailnet", `${name}: fallback changed`);
  for (const bad of ["ws://gateway.example.ts.net:10000", "https://gateway.example.ts.net:10000", `${sampleUrl}/`, `${sampleUrl}/x`, `${sampleUrl}?a=1`,
    "wss://u@gateway.example.ts.net:10000", "wss://127.0.0.1:10000", "wss://localhost:10000", "wss://gateway.example.ts.net:0"]) {
    assert.throws(() => run({ OPENCLAW_CLOUD_WORKER_GATEWAY_URL: bad }), /must be wss:/, `${name}: accepted ${bad}`);
  }
}

const chunk = receipt.patchedFiles.find((name) => name.startsWith("server-worker-environment-startup-"));
const setupCode = /from "\.\/(setup-code-[^"]+\.mjs)"/.exec(fs.readFileSync(path.join(dist, chunk), "utf8"))?.[1];
assert(setupCode, "enrollment chunk no longer imports setup-code");
const exports = /export \{([^}]*)\}/.exec(fs.readFileSync(path.join(dist, setupCode), "utf8"))?.[1] ?? "";
const alias = /\bresolvePairingGatewayUrl as (\w+)/.exec(exports)?.[1];
assert(alias, "setup-code no longer exports resolvePairingGatewayUrl");
const resolvePairingGatewayUrl = (await import(pathToFileURL(path.join(dist, setupCode)).href))[alias];
const resolved = await resolvePairingGatewayUrl({ gateway: { mode: "local", bind: "loopback", tailscale: { mode: "off" } } }, {
  env: {},
  useLocalGateway: false,
  publicUrl: sampleUrl,
  publicOriginPreference: "prefer",
  networkInterfaces: () => ({}),
  runCommandWithTimeout: async () => ({ code: 1, stdout: "", stderr: "" }),
});
assert.equal(resolved.url, sampleUrl, `resolver rewrote the worker URL: ${JSON.stringify(resolved)}`);
assert.equal(resolved.source, "plugins.entries.device-pair.config.publicUrl", "worker URL left the publicUrl branch (TLS pinning rules differ)");
const invalid = await resolvePairingGatewayUrl({ gateway: { mode: "local", bind: "loopback" } }, { env: {}, publicUrl: "wss://user:pw@example.com", networkInterfaces: () => ({}) });
assert(!invalid.url && invalid.error, "an invalid override must fail closed, not fall back");
// The worker ingress proxy (packages/openclaw-worker-ingress/worker-ingress.mjs) allows
// exactly these routes and token shapes. If an upgrade moves any of them, fail here so
// the allowlist is re-derived instead of silently refusing (or admitting) other paths.
const distText = (pattern) => fs.readdirSync(dist).filter((file) => pattern.test(file)).map((file) => fs.readFileSync(path.join(dist, file), "utf8")).join("\n");
const routeContracts = [
  [/^gateway-http-route-contracts-.*\.mjs$/, 'WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH = "/__openclaw__/worker-bootstrap"'],
  [/^node-bundle-install-protocol-.*\.mjs$/, 'NODE_WORKER_BUNDLE_TRANSFER_PATH = "/__openclaw__/worker-bundle/v1"'],
  [/^node-bundle-install-protocol-.*\.mjs$/, "TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u"],
  [/^node-workspace-transfer-protocol-.*\.mjs$/, 'NODE_WORKSPACE_TRANSFER_PATH = "/__openclaw__/worker-transfer/v1"'],
  [/^node-workspace-transfer-protocol-.*\.mjs$/, "encodeURIComponent(environmentId)"],
  [/^worker-protocol-primitives-.*\.mjs$/, 'WORKER_PUBLIC_INGRESS_PATH = "/__openclaw__/worker"'],
  [/^node-desktop-stream-.*\.mjs$/, 'NODE_DESKTOP_ATTACH_PATH = "/node-desktop/attach"'],
  [/^node-desktop-stream-.*\.mjs$/, 'NODE_PORTAL_ATTACH_PATH = "/node-portal/attach"'],
  [/^startup-state-readiness-.*\.mjs$/, "TICKET_PATTERN$1 = /^[a-f0-9]{48}$/u"],
  [/^artifact-transfer-http-.*\.mjs$/, "SHA256_PATTERN = /^[a-f0-9]{64}$/u"],
  // deriveEnvironmentIntent (worker-environments/service-contract.ts): bundled into
  // project-preparation through 10.4, its own service-contract chunk from 10.5.
  [/^(project-preparation|service-contract)-.*\.mjs$/, "`worker:${digest.slice(0, 32)}`"],
];
for (const [file, needle] of routeContracts) assert(distText(file).includes(needle), `worker route contract changed: ${needle} (re-derive the ingress allowlist)`);

console.log(`Cloud-worker gateway URL: helper and resolver checks passed for ${receipt.patchedFiles.join(", ")}`);
