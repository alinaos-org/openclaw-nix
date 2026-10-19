import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.4"), "agent-db-preparation-retry hotfix requires a qualified stable release");
const MARKER = "openclaw-nix-agent-db-preparation-retry-v1";
const dist = path.join(root, "dist");
const only = (pattern, needle) => {
  const found = fs.readdirSync(dist).filter((name) => pattern.test(name)
    && fs.readFileSync(path.join(dist, name), "utf8").includes(needle));
  assert.equal(found.length, 1, `expected exactly one ${pattern} containing ${needle}`);
  return found[0];
};
const edit = (file, replacements) => {
  let source = fs.readFileSync(path.join(dist, file), "utf8");
  for (const [before, after] of replacements) {
    assert.equal(source.split(before).length, 2, `agent-db-preparation-retry anchor changed in ${file}: ${before}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path.join(dist, file), source);
};

// A Gateway start whose agent database needs background inspection (main's 1.28 GB
// database after a stop that left worker leases behind) prepares it after startup.
// The preparation refuses to publish if the runtime config object or the secrets
// revision changes while it runs, which startup itself can do. Upstream then leaves
// the agent degraded until a restart ("Agent main startup preparation was
// superseded"; nova prod, 2026-10-18). Retry it with the current configuration
// while the Gateway still owns it, for up to RETRY_WINDOW_MS.
const RETRY_WINDOW_MS = 600e3;

// 1. Say which check superseded the preparation, so the log names the cause.
const serverStart = only(/^server-start-.*\.mjs$/, "startup preparation was superseded");
edit(serverStart, [
  ["if (!params.isCurrent() || params.getConfig() !== beforeConfig || getActiveSecretsRuntimeSnapshotRevision() !== previousSecretsRevision) throw new Error(`Agent ${agentId} secrets preparation was superseded`);",
    "if (!params.isCurrent()) throw new Error(`Agent ${agentId} secrets preparation was superseded (the Gateway is closing)`); "
    + "if (params.getConfig() !== beforeConfig) throw new Error(`Agent ${agentId} secrets preparation was superseded (runtime config changed)`); "
    + `if (getActiveSecretsRuntimeSnapshotRevision() !== previousSecretsRevision) throw new Error(\`Agent \${agentId} secrets preparation was superseded (secrets revision \${previousSecretsRevision} -> \${getActiveSecretsRuntimeSnapshotRevision()})\`); /* ${MARKER} */`],
  ["if (!params.isCurrent() || params.getConfig() !== cfg || getActiveSecretsRuntimeSnapshotRevision() !== secretsRevision) throw new Error(`Agent ${agentId} startup preparation was superseded`);",
    "if (!params.isCurrent()) throw new Error(`Agent ${agentId} startup preparation was superseded (the Gateway is closing)`); "
    + "if (params.getConfig() !== cfg) throw new Error(`Agent ${agentId} startup preparation was superseded (runtime config changed)`); "
    + `if (getActiveSecretsRuntimeSnapshotRevision() !== secretsRevision) throw new Error(\`Agent \${agentId} startup preparation was superseded (secrets revision \${secretsRevision} -> \${getActiveSecretsRuntimeSnapshotRevision()})\`); /* ${MARKER} */`],
  // 10.5 splits the preparation into open, migration and publication phases. The open
  // and migration guard tolerates a new config object and supersedes only for a
  // closing Gateway; publication keeps the strict check above.
  ...(atLeast(version, "2026.10.5") ? [[
    "\t\t\tif (!params.isCurrent()) throw new Error(`Agent ${agentId} startup preparation was superseded`);",
    `\t\t\tif (!params.isCurrent()) throw new Error(\`Agent \${agentId} startup preparation was superseded (the Gateway is closing)\`); /* ${MARKER} */`,
  ]] : []),
]);

// 2. Retry a superseded preparation in the admission owner, which otherwise marks
// the agent failed after one attempt. A closing Gateway, a stop, any other error and
// the end of the window still fail as upstream does.
const admission = only(/^agent-database-startup-.*\.mjs$/, "agent database remains degraded");
edit(admission, [
  ["const log = createSubsystemLogger(\"state/agent-admission\");",
    `const log = createSubsystemLogger("state/agent-admission");
/* ${MARKER}: retry a deferred agent preparation that a config or secrets
republish superseded, with the current configuration, while the Gateway owns it. */
const OPENCLAW_NIX_PREPARATION_RETRY_WINDOW_MS = ${RETRY_WINDOW_MS / 1e3}e3;
async function openclawNixRetrySupersededPreparation(run, params) {
	const started = Date.now();
	for (let attempt = 1;; attempt++) try {
		return await run();
	} catch (error) {
		const reason = formatErrorMessage(error);
		if (params.isStopped() || !/ preparation was superseded \\((runtime config changed|secrets revision)/.test(reason) || Date.now() - started >= OPENCLAW_NIX_PREPARATION_RETRY_WINDOW_MS) throw error;
		params.log.warn("agent database preparation superseded; retrying with the current configuration", {
			agentId: params.agentId,
			attempt,
			reason
		});
		await new Promise((resolve) => setTimeout(resolve, Math.min(attempt, 5) * 1e3));
		params.assertCurrent();
	}
}`],
  atLeast(version, "2026.10.5") ? [`							await activation.publishAgent(input);`,
    `							await openclawNixRetrySupersededPreparation(() => activation.publishAgent(input), {
								agentId,
								assertCurrent,
								isStopped: () => this.stopped,
								log
							}); /* ${MARKER} */`]
  : [`								await activation.prepareAgent({
									agentId,
									paths,
									env,
									signal: this.signal,
									assertCurrent
								});`,
    `								await openclawNixRetrySupersededPreparation(() => activation.prepareAgent({
									agentId,
									paths,
									env,
									signal: this.signal,
									assertCurrent
								}), {
									agentId,
									assertCurrent,
									isStopped: () => this.stopped,
									log
								}); /* ${MARKER} */`],
]);

fs.writeFileSync(path.join(root, ".agent-db-preparation-retry-hotfix.json"), JSON.stringify({
  id: MARKER, upstreamVersion: version, patchedFiles: { serverStart, admission }, retryWindowMs: RETRY_WINDOW_MS,
  retriedCall: atLeast(version, "2026.10.5") ? "publishAgent" : "prepareAgent",
  serverStartEdits: atLeast(version, "2026.10.5") ? 3 : 2,
}, null, 2) + "\n");
console.log(`Applied superseded agent-preparation retry (${RETRY_WINDOW_MS / 1e3}s window) and named supersession causes`);
