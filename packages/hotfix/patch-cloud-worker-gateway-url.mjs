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

const REGION = "//#region src/gateway/worker-environments/node-enrollment.ts";
const MARKER = "/* openclaw-nix-cloud-worker-gateway-url-v1 */";
const headerBefore = "function createWorkerNodeEnrollmentManager(options) {";
// Origin-only wss://<dns name>[:port]: grantArtifact replaces the URL path while the node
// prefixes it, so a path would split the two. An invalid value throws (the environment
// fails) rather than falling back to the tailnet URL. The regex is inline: the recovery
// helper is one scope, where a top-level const could hit its temporal dead zone.
const headerAfter = [
  `function resolveCloudWorkerGatewayPublicUrl(config) { ${MARKER}`,
  "\tconst raw = process.env.OPENCLAW_CLOUD_WORKER_GATEWAY_URL;",
  "\tif (raw === void 0 || raw.trim() === \"\") return resolveConfiguredPairingPublicUrl(config);",
  "\tconst value = raw.trim();",
  "\tif (!/^wss:\\/\\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}(?::[1-9][0-9]{0,4})?$/u.test(value)) throw new Error(\"OPENCLAW_CLOUD_WORKER_GATEWAY_URL must be wss://<dns-name>[:<port>] with no path, query, fragment or credentials\");",
  "\treturn value;",
  "}",
  headerBefore,
].join("\n");
const callBefore = "publicUrl: resolveConfiguredPairingPublicUrl(config),";
const callAfter = "publicUrl: resolveCloudWorkerGatewayPublicUrl(config),";
const prepareContext = `\n\t\t\t${callBefore}\n\t\t\tpublicOriginPreference: "prefer",\n\t\t\tnetworkInterfaces: os.networkInterfaces,`;
const beginContext = `\n\t\t\t\t\t\t${callBefore}\n\t\t\t\t\t\tpublicOriginPreference: "prefer",\n\t\t\t\t\t\tbootstrapProfile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,`;
const phoneSetupCode = "const configuredPublicUrl = params.preferRemoteUrl === true ? void 0 : resolveConfiguredPairingPublicUrl(config);";

const count = (text, needle) => text.split(needle).length - 1;
const regionOf = (text) => {
  const start = text.indexOf(REGION);
  const end = text.indexOf("//#endregion", start);
  assert(start >= 0 && end > start, "node-enrollment region not found");
  return [start, end];
};

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  const text = fs.readFileSync(file, "utf8");
  const regions = count(text, REGION);
  if (regions === 0) continue;
  assert.equal(regions, 1, `node-enrollment region repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, "OPENCLAW_CLOUD_WORKER_GATEWAY_URL"), 0, `${name} already reads OPENCLAW_CLOUD_WORKER_GATEWAY_URL`);
  for (const anchor of [headerBefore, prepareContext, beginContext]) assert.equal(count(text, anchor), 1, `anchor changed in ${name}: ${anchor.trim().slice(0, 60)}`);
  const [start, end] = regionOf(text);
  const region = text.slice(start, end);
  assert.equal(count(region, callBefore), 2, `${name}: expected exactly the prepare and begin call sites in the enrollment region`);
  assert.equal(count(text, callBefore), 2, `${name}: device-pair publicUrl is read by enrollment code outside the region`);

  const patchedRegion = region
    .replace(headerBefore, headerAfter)
    .replace(prepareContext, prepareContext.replace(callBefore, callAfter))
    .replace(beginContext, beginContext.replace(callBefore, callAfter));
  const patched = text.slice(0, start) + patchedRegion + text.slice(end);

  const [newStart, newEnd] = regionOf(patched);
  const newRegion = patched.slice(newStart, newEnd);
  assert.equal(count(newRegion, callAfter), 2, `${name}: enrollment call sites not rewritten`);
  assert.equal(count(newRegion, callBefore), 0, `${name}: an enrollment call site still reads device-pair publicUrl`);
  assert.equal(count(newRegion, "resolveConfiguredPairingPublicUrl(config)"), 1, `${name}: fallback missing from the helper`);
  assert.equal(count(patched, phoneSetupCode), count(text, phoneSetupCode), `${name}: phone setup-code path changed`);
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
