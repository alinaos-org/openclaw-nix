import fs from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";

const root = process.argv[2];
const upstreamVersion = process.argv[3];
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
if (!root || !atLeast(upstreamVersion, "2026.9.3")) {
  throw new Error("usage: patch-mcp-close-rejection.mjs OPENCLAW_ROOT UPSTREAM_VERSION");
}
const dist = path.join(root, "dist");
const files = fs.readdirSync(dist).filter((name) => /^mcp-client-lifecycle-.*\.mjs$/.test(name));
if (files.length !== 1) throw new Error(`expected one MCP lifecycle chunk, found ${files.length}`);
if (atLeast(upstreamVersion, "2026.10.1")) {
  // 10.1 splits the worker bundle into chunks: connectMcpClient now has two worker
  // copies (worker/sqlite-store.worker.mjs and a worker-chunk-*.mjs). Verify each.
  const workerDir = path.join(dist, "worker");
  const workerCopies = fs.readdirSync(workerDir).filter((name) => /\.m?js$/.test(name)).sort()
    .filter((name) => fs.readFileSync(path.join(workerDir, name), "utf8").includes("async function connectMcpClient("))
    .map((name) => `worker/${name}`);
  if (workerCopies.length === 0) throw new Error("no worker copy of connectMcpClient found");
  files.push(...workerCopies);
} else {
  files.push("worker/worker.mjs");
}
const marker = "openclaw-mcp-observe-close-rejection-v1";
for (const name of files) {
  const file = path.join(dist, name);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(marker)) throw new Error(`MCP close hotfix already applied: ${name}`);
  if (atLeast(upstreamVersion, "2026.9.5")) {
    // 9.5 observes SDK-discarded close rejections upstream and still returns
    // the original promise, so explicit cleanup callers retain the failure.
    // The worker minifies identifiers and comma-returns the observed promise.
    // Exercise both actual packaged implementations without importing the
    // Gateway, touching state, starting a transport, or guessing local names.
    const start = source.indexOf("async function connectMcpClient(");
    const end = source.indexOf("async function disposeMcpClient(", start);
    assert(start >= 0 && end > start, `MCP lifecycle extraction failed: ${name}`);
    let failures = 0;
    const slice = source.slice(start, end);
    // 10.1's worker chunks minify these imported helpers too (`.catch(() => l())`,
    // `t.aborted || de(n)`), so take their local names from the call shape.
    const cleanupName = /\.catch\(\(\)\s*=>\s*([A-Za-z_$][\w$]*)\(\)\)/.exec(slice)?.[1] ?? "recordAgentCleanupFailure";
    const timeoutName = /\.aborted\s*\|\|\s*([A-Za-z_$][\w$]*)\(/.exec(slice)?.[1] ?? "isMcpRequestTimeoutError";
    const connect = vm.runInNewContext(
      slice + ";connectMcpClient",
      { AbortSignal, Error, Promise, [cleanupName]: () => failures++, [timeoutName]: () => false },
    );
    const initializationError = new Error("fixture initialization failure");
    const closeError = new Error("fixture unconfirmed descendant cleanup");
    let closing;
    const close = () => (closing = Promise.reject(closeError));
    const client = {
      close,
      async connect() {
        assert.equal(this.close(), closing, "awaited cleanup must retain its original rejecting promise");
        throw initializationError;
      },
    };
    await assert.rejects(connect({ client, transport: {}, timeoutMs: 1000 }),
      (error) => error === initializationError);
    assert.equal(failures, 1, `SDK-discarded cleanup failure must be observed: ${name}`);
    assert.equal(client.close, close, `original close method must be restored: ${name}`);
    continue;
  }
  const anchor = /async function connectMcpClient\(([A-Za-z_$][\w$]*)\)\s*\{/g;
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) throw new Error(`expected one connectMcpClient in ${name}, found ${matches.length}`);
  const param = matches[0][1];
  // SDK 1.30.0 calls `void this.close()` when initialize fails. An owned
  // process can reject close when descendant extinction is unconfirmed.
  // Observe that rejection without replacing the returned promise: explicit
  // cleanup callers must still receive the failure and report "uncertain".
  const insertion = `
    /* ${marker} */
    const closeWithOriginalReceiver = ${param}.client.close.bind(${param}.client);
    ${param}.client.close = () => {
      const pendingClose = closeWithOriginalReceiver();
      pendingClose.catch(() => {});
      return pendingClose;
    };
  `;
  fs.writeFileSync(file, source.replace(anchor, (match) => match + insertion));
}
// A crashed gateway leaves registrations for children systemd has killed.
// The reaper already takes a targeted, identity-checked snapshot. Do not run
// two whole-host process scans (with a shared two-second deadline) merely
// to rediscover that a registered child is absent or its PID was reused.
const codexRelativeDir = atLeast(upstreamVersion, "2026.9.5") ? "extensions/codex/.setup" : "extensions/codex";
const codexDir = path.join(dist, codexRelativeDir);
const codexFiles = fs.readdirSync(codexDir).filter((name) => /^transport-stdio-.*\.(?:mjs|js)$/.test(name));
if (codexFiles.length !== 1) throw new Error(`expected one Codex transport chunk, found ${codexFiles.length}`);
const codexFile = path.join(codexDir, codexFiles[0]);
const codexSource = fs.readFileSync(codexFile, "utf8");
const codexAnchor = "\t\tconst child = snapshot.find((row) => row.pid === registration.child.pid);";
if (codexSource.split(codexAnchor).length !== 2) throw new Error("Codex orphan snapshot anchor changed");
fs.writeFileSync(codexFile, codexSource.replace(codexAnchor, codexAnchor + `
    /* openclaw-codex-stale-registration-v1 */
    if (!child || child.startedAt !== registration.child.startedAt || isDeadProcessState(child.state)) {
      store.delete(entry.key);
      continue;
    }
`));
files.push(codexRelativeDir + "/" + codexFiles[0]);
fs.writeFileSync(path.join(root, ".mcp-close-hotfix.json"), JSON.stringify({
  id: marker,
  upstreamVersion,
  patchedFiles: atLeast(upstreamVersion, "2026.9.5") ? files.slice(-1) : files,
  verifiedUpstreamFiles: atLeast(upstreamVersion, "2026.9.5") ? files.slice(0, -1) : [],
  cleanupFailuresRemainObservable: true,
  closeRejectionImplementation: atLeast(upstreamVersion, "2026.9.5") ? "upstream" : "downstream",
  orphanRegistrationHotfix: "openclaw-codex-stale-registration-v1",
}, null, 2) + "\n");
console.log(atLeast(upstreamVersion, "2026.9.5")
  ? `Verified upstream MCP rejection handling in ${files.length - 1} entries; patched Codex stale-registration cleanup`
  : `MCP close rejection hotfix applied to ${files.length} runtime entries`);
