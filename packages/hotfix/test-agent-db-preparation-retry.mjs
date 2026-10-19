// Exercise the packaged retry helper and check both patched call sites, without
// booting OpenClaw, opening state or touching the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(root + "/.agent-db-preparation-retry-hotfix.json", "utf8"));
const marker = receipt.id;
const read = (name) => fs.readFileSync(root + "/dist/" + name, "utf8");
const admission = read(receipt.patchedFiles.admission);
const serverStart = read(receipt.patchedFiles.serverStart);

// The admission owner makes the retried call (prepareAgent until 10.4, the
// publication phase's publishAgent from 10.5) only through the helper, once.
const call = `activation.${receipt.retriedCall}(`;
assert.equal(admission.split(call).length, 2, `${receipt.retriedCall} call site moved`);
assert(admission.includes(`await openclawNixRetrySupersededPreparation(() => ${call}`), `${receipt.retriedCall} is not wrapped by the retry`);
assert(admission.includes(`isStopped: () => this.stopped`), "retry is not bound to the admission's stop");
// Every supersession names its cause, and none keeps upstream's combined message.
for (const kind of ["secrets", "startup"]) {
  for (const cause of ["(the Gateway is closing)", "(runtime config changed)", "(secrets revision "]) {
    assert(serverStart.includes(`${kind} preparation was superseded ${cause}`), `${kind}: missing cause ${cause}`);
  }
  assert(!serverStart.includes(`${kind} preparation was superseded\`)`), `${kind}: upstream's undifferentiated message remains`);
}
assert.equal(serverStart.split(marker).length, receipt.serverStartEdits + 1, `server-start carries its ${receipt.serverStartEdits} marked edits`);

// Evaluate the packaged helper itself, with a frozen clock and immediate timers.
const head = admission.indexOf("const OPENCLAW_NIX_PREPARATION_RETRY_WINDOW_MS");
const tail = admission.indexOf("\n}\n", admission.indexOf("async function openclawNixRetrySupersededPreparation", head)) + 3;
assert(head >= 0 && tail > head, "retry helper not found");
let now = 0;
const sandbox = {
  Date: { now: () => now },
  setTimeout: (fn, ms) => { now += ms; fn(); },
  Promise, Math, Error,
  formatErrorMessage: (error) => String(error?.message ?? error),
};
const retry = vm.runInNewContext(`${admission.slice(head, tail)}\n;openclawNixRetrySupersededPreparation`, sandbox);
const logs = [];
const params = (overrides = {}) => ({
  agentId: "main",
  assertCurrent: () => {},
  isStopped: () => false,
  log: { warn: (message, meta) => logs.push({ message, meta }) },
  ...overrides,
});
const superseded = (cause) => new Error(`Agent main startup preparation was superseded (${cause})`);

// Superseded twice by a republish, then prepared: the third attempt succeeds.
let calls = 0;
assert.equal(await retry(async () => { if (++calls < 3) throw superseded(calls === 1 ? "runtime config changed" : "secrets revision 4 -> 5"); return "prepared"; }, params()), "prepared");
assert.equal(calls, 3);
assert.equal(logs.length, 2);
assert.deepEqual(logs.map(({ meta }) => meta.attempt), [1, 2]);

// A secrets-preparation supersession retries the same way.
calls = 0;
await retry(async () => { if (++calls < 2) throw new Error("Agent main secrets preparation was superseded (secrets revision 1 -> 2)"); }, params());
assert.equal(calls, 2);

// Anything else fails at once, as upstream does.
for (const [error, overrides] of [
  [new Error("Agent main startup preparation was superseded (the Gateway is closing)"), {}],
  [new Error("Agent main database requires Doctor before preparation"), {}],
  [superseded("runtime config changed"), { isStopped: () => true }],
]) {
  calls = 0;
  await assert.rejects(retry(async () => { calls++; throw error; }, params(overrides)), error);
  assert.equal(calls, 1, `retried: ${error.message}`);
}

// The Gateway losing ownership during the pause ends the retries with its error.
const lost = new Error("Gateway no longer owns preparation for agent main");
calls = 0;
await assert.rejects(retry(async () => { calls++; throw superseded("runtime config changed"); }, params({ assertCurrent: () => { throw lost; } })), lost);
assert.equal(calls, 1);

// The window bounds the retries: the last supersession is the failure.
now = 0;
calls = 0;
await assert.rejects(retry(async () => { calls++; throw superseded("runtime config changed"); }, params()), /superseded/);
assert(now >= receipt.retryWindowMs && calls > 1, `window not enforced (calls=${calls}, elapsed=${now})`);

console.log(`agent-db-preparation-retry: helper retried republish supersessions only, within ${receipt.retryWindowMs / 1e3}s`);
