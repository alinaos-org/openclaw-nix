// 9.8 cloud workers learn the Gateway URL from node enrollment, which reuses the phone
// pairing URL (plugins.entries.device-pair.config.publicUrl). A gateway that pins that
// to a private network (a tailnet) leaves cloud workers unable to reach it, while the
// phone flows must stay on that network.
// Give enrollment, and only enrollment, its own URL: OPENCLAW_CLOUD_WORKER_GATEWAY_URL
// when set, else the device-pair publicUrl as upstream does. Both enrollment call sites
// (prepare(), and the setup code begin() issues) take it, so the bootstrap download, the
// node's WebSocket and every follow-up transfer agree on one origin.
//
// The value still enters resolvePairingGatewayUrl as `publicUrl`, so it keeps that
// branch's validation (an invalid value fails closed, never falls back) and its source
// label, which pins no TLS fingerprint: use a publicly trusted certificate (for example a
// Tailscale Funnel URL).
// device.pair.setupCode, the device-pair plugin, `openclaw qr` and doctor all read the
// shared resolver directly and are untouched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.9.8"), "cloud-worker gateway URL hotfix is qualified from 2026.9.8");
const dist = path.join(root, "dist");

const REGION = "src/gateway/worker-environments/node-enrollment.ts";
const MARKER = "/* openclaw-nix-cloud-worker-gateway-url-v1 */";
// From 2026.11.5 on the bundler mangles this chunk's local names (`options` becomes `e`,
// `config` becomes `a` and `t`), so the anchors capture identifiers rather than spell
// them; the call sites must still pass the config they resolve against. Each anchor is
// still required exactly once, and 11.4's readable names match the same patterns.
const header = /function createWorkerNodeEnrollmentManager\([\w$]+\)\s*\{/g;
// Origin-only wss://<dns name>[:port]: grantArtifact replaces the URL path while the node
// prefixes it, so a path would split the two. An invalid value throws (the environment
// fails) rather than falling back to the tailnet URL. The regex is inline: the recovery
// helper is one scope, where a top-level const could hit its temporal dead zone.
const helper = [
  `function resolveCloudWorkerGatewayPublicUrl(config) { ${MARKER}`,
  "\tconst raw = process.env.OPENCLAW_CLOUD_WORKER_GATEWAY_URL;",
  "\tif (raw === void 0 || raw.trim() === \"\") return resolveConfiguredPairingPublicUrl(config);",
  "\tconst value = raw.trim();",
  "\tif (!/^wss:\\/\\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}(?::[1-9][0-9]{0,4})?$/u.test(value)) throw new Error(\"OPENCLAW_CLOUD_WORKER_GATEWAY_URL must be wss://<dns-name>[:<port>] with no path, query, fragment or credentials\");",
  "\treturn value;",
  "}",
].join("\n");
const readCall = /publicUrl:\s*resolveConfiguredPairingPublicUrl\(/g;
const callFor = (config) => `publicUrl: resolveCloudWorkerGatewayPublicUrl(${config}),`;
// prepare(): the bootstrap download and the node's WebSocket URL.
const pairingContext = (resolver, following) => new RegExp(
  `(${resolver}\\(([\\w$]+),\\s*\\{\\s*env:\\s*process\\.env,\\s*useLocalGateway:\\s*\\2\\.gateway\\?\\.mode\\s*===\\s*["\\x60]remote["\\x60],\\s*)` +
  `publicUrl:\\s*resolveConfiguredPairingPublicUrl\\(\\2\\),(\\s*publicOriginPreference:\\s*["\\x60]prefer["\\x60],\\s*${following},)`, "g");
const prepareContext = pairingContext("resolvePairingGatewayUrl", "networkInterfaces:\\s*os\\.networkInterfaces");
const beginContext = pairingContext("resolvePairingSetupFromConfig", "bootstrapProfile:\\s*CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE");
const resolverReads = "resolveConfiguredPairingPublicUrl(";

const count = (text, needle) => text.split(needle).length - 1;
const matches = (text, pattern) => [...text.matchAll(pattern)].length;
const regionOf = (text) => {
  const labels = [...text.matchAll(/^\/\/(?:#region |! ?(?=\S+\/\S+$))(.+)$/gm)];
  const targets = labels.filter((label) => label[1] === REGION);
  if (!targets.length) return;
  assert.equal(targets.length, 1, "node-enrollment label repeated");
  const [label] = targets;
  const next = labels[labels.indexOf(label) + 1]?.index ?? text.length;
  const closing = text.indexOf("\n//#endregion", label.index + label[0].length);
  return [label.index, closing >= 0 && closing < next ? closing + 1 : next];
};

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  const text = fs.readFileSync(file, "utf8");
  const bounds = regionOf(text);
  if (!bounds) continue;
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, "OPENCLAW_CLOUD_WORKER_GATEWAY_URL"), 0, `${name} already reads OPENCLAW_CLOUD_WORKER_GATEWAY_URL`);
  assert.equal(count(text, "resolveCloudWorkerGatewayPublicUrl"), 0, `${name} already defines resolveCloudWorkerGatewayPublicUrl`);
  for (const [label, anchor] of [["createWorkerNodeEnrollmentManager header", header], ["prepare() publicUrl", prepareContext], ["begin() publicUrl", beginContext]]) {
    assert.equal(matches(text, anchor), 1, `anchor changed in ${name}: ${label}`);
  }
  // The helper calls the resolver by its source name, so the chunk must bind that name
  // at top level (an import alias, or the bundled function itself).
  assert(/\bimport\s*\{[^}\n]*\bresolveConfiguredPairingPublicUrl\s*(?:,[^}\n]*)?\}\s*from\s*"/mu.test(text) || /\bfunction resolveConfiguredPairingPublicUrl\(/mu.test(text), `${name}: resolveConfiguredPairingPublicUrl is not bound at top level`);
  const [start, end] = bounds;
  const region = text.slice(start, end);
  assert.equal(matches(region, readCall), 2, `${name}: expected exactly the prepare and begin call sites in the enrollment region`);
  assert.equal(matches(text, readCall), 2, `${name}: device-pair publicUrl is read by enrollment code outside the region`);
  for (const anchor of [header, prepareContext, beginContext]) assert.equal(matches(region, anchor), 1, `${name}: an enrollment anchor sits outside the region`);

  // Function replacements: the helper's regex carries `$`, which a string replacement
  // would read as a substitution pattern.
  const patchedRegion = region
    .replace(header, (found) => `${helper}\n${found}`)
    .replace(prepareContext, (_, before, config, after) => `${before}${callFor(config)}${after}`)
    .replace(beginContext, (_, before, config, after) => `${before}${callFor(config)}${after}`);
  const patched = text.slice(0, start) + patchedRegion + text.slice(end);

  const [newStart, newEnd] = regionOf(patched);
  const newRegion = patched.slice(newStart, newEnd);
  assert.equal(count(newRegion, "publicUrl: resolveCloudWorkerGatewayPublicUrl("), 2, `${name}: enrollment call sites not rewritten`);
  assert.equal(matches(newRegion, readCall), 0, `${name}: an enrollment call site still reads device-pair publicUrl`);
  assert.equal(count(newRegion, "return resolveConfiguredPairingPublicUrl(config);"), 1, `${name}: fallback missing from the helper`);
  assert.equal(count(newRegion, resolverReads), 1, `${name}: the helper is not the region's only device-pair publicUrl reader`);
  // Phone pairing (device.pair.setupCode, the device-pair plugin, `openclaw qr`, doctor)
  // reads the shared resolver outside this region, which is written back unchanged.
  fs.writeFileSync(file, patched);
  patchedFiles.push(name);
}

// The gateway imports the chunk; the sealed update-recovery helper carries its own copy.
assert(patchedFiles.some((name) => /^server-worker-environment-startup-.*\.mjs$/.test(name)), "live enrollment chunk not patched");
// 9.8-9.9 bundle a second copy into package-update-activation-recovery.mjs; 10.1's
// recovery runtime no longer carries one, so only the live chunk is patched.
const recoveryCopy = !atLeast(version, "2026.10.1");
if (recoveryCopy) assert(patchedFiles.includes("package-update-activation-recovery.mjs"), "update-recovery copy not patched");
assert.equal(patchedFiles.length, recoveryCopy ? 2 : 1, `unexpected enrollment copies: ${patchedFiles.join(", ")}`);

fs.writeFileSync(path.join(root, ".cloud-worker-gateway-url-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-cloud-worker-gateway-url-v1", upstreamVersion: version, env: "OPENCLAW_CLOUD_WORKER_GATEWAY_URL", patchedFiles,
}, null, 2) + "\n");
console.log(`Cloud-worker gateway URL: enrollment reads OPENCLAW_CLOUD_WORKER_GATEWAY_URL in ${patchedFiles.join(", ")}`);
