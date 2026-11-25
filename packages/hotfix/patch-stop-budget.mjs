import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.9.4"), "stop-budget hotfix requires a qualified stable release");
const dist = path.join(root, "dist");
const candidates = fs.readdirSync(dist).filter((name) => /^run-.*\.mjs$/.test(name)
  && /\bconst runAcceptedRequest\s*=/.test(fs.readFileSync(path.join(dist, name), "utf8")));
assert.equal(candidates.length, 1, "expected exactly one lifecycle entry");
const file = path.join(dist, candidates[0]);
let source = fs.readFileSync(file, "utf8");
// 9.6 consolidated every shutdown budget into resolveGatewayShutdownDrainBudget,
// which returns the stop and restart values from one place. Clamp only the two
// `!isRestart` branches there, so a stop gets a 120s drain / 180s hard exit and
// the restart path stays exactly upstream's. (30s / 90s until 2026.10.4: a stop
// during activation cut a running agent turn, its databases closed with
// "active-leases", and the next start failed inspection. 10.4 no longer hangs a
// stop on a stalled transcript worker, so the longer drain stays bounded.)
// The clamp, in one place: the receipt records it and the test reads it from there.
const STOP_DRAIN_MS = 120e3;
const STOP_HARD_EXIT_MS = 180e3;
const seconds = (ms) => `${ms / 1e3}e3`;
// 2026.11.5 deletes resolveGatewayShutdownDrainBudget and the stop drain with it:
// a committed shutdown records running sessions and aborts them instead of
// waiting. Every stop now arms its hard exit as armForceExitTimer(budget.timeoutMs),
// the whole native budget (325 s under prod's 6 min TimeoutStopSec), and restarts
// use the same timer. Clamp inside that timer, stops only, so every stop arm
// (pre-refresh safety net and the shutdown deadline, which also bounds cleanup)
// gets the 180 s hard exit and every restart keeps upstream's deadline. From
// 11.5 on the run loop ships minified, so the local names are read from the
// source, not hard-coded.
if (atLeast(version, "2026.11.5")) {
  const marker = "openclaw-nix-stop-budget-v1";
  assert(!source.includes(marker), "stop-budget: already applied");
  const esc = (name) => name.replace(/\$/g, "\\$");
  const headers = [...source.matchAll(/const runAcceptedRequest\s*=\s*\(?([\w$]+)\)?\s*=>\s*\{\s*const\s*\{\s*action:\s*([\w$]+),\s*restartIntent:\s*([\w$]+)\s*\}\s*=\s*\1;/g)];
  assert.equal(headers.length, 1, "expected one runAcceptedRequest header");
  const [head] = headers;
  const [, , action, intent] = head;
  const bodyEnd = source.indexOf("const clearForceExitTimer", head.index);
  assert(bodyEnd > head.index, "stop-budget: clearForceExitTimer not found after runAcceptedRequest");
  const body = source.slice(head.index, bodyEnd);
  const restartDecls = [...body.matchAll(new RegExp(`\\bconst ([\\w$]+)\\s*=\\s*${esc(action)}\\s*!==\\s*["\\x60]stop["\\x60];`, "g"))];
  assert.equal(restartDecls.length, 1, "stop-budget: isRestart declaration moved");
  const isRestart = restartDecls[0][1];
  const timers = [...body.matchAll(new RegExp(`const armForceExitTimer\\s*=\\s*\\(?([\\w$]+)\\)?\\s*=>\\s*\\{\\s*(const ([\\w$]+)\\s*=\\s*${esc(intent)}\\?\\.requireFreshProcess\\s*\\?\\s*Math\\.min\\(\\1,\\s*1e4\\)\\s*:\\s*\\1;)`, "g"))];
  assert.equal(timers.length, 1, "stop-budget: armForceExitTimer deadline moved");
  const [, forceExitMs, before, deadlineMs] = timers[0];
  // The stop path must have no hard exit outside this timer.
  assert.equal([...source.matchAll(/["\x60]gateway\.stop_shutdown_timeout["\x60]/g)].length, 1, "stop-budget: a second stop hard exit appeared");
  assert(body.indexOf("gateway.stop_shutdown_timeout") > body.indexOf(before), "stop-budget: the stop hard exit left armForceExitTimer");
  const after = `const ${deadlineMs} = ${intent}?.requireFreshProcess ? Math.min(${forceExitMs}, 1e4) : !${isRestart} ? Math.min(${forceExitMs}, ${seconds(STOP_HARD_EXIT_MS)}) /* ${marker} */ : ${forceExitMs};`;
  assert.equal(source.split(before).length, 2, `stop-budget anchor changed: ${before}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(root, ".stop-budget-hotfix.json"), JSON.stringify({
    id: marker, upstreamVersion: version, patchedFile: candidates[0],
    stopDrainMs: null, stopDrainOwner: "none", stopHardExitMs: STOP_HARD_EXIT_MS,
    restartPolicyUnchanged: true, clampedLine: after,
  }, null, 2) + "\n");
  console.log(`Applied stop-only ${STOP_HARD_EXIT_MS / 1e3}s hard-exit budget (11.5 has no stop drain; active work is aborted); restart policy unchanged`);
  process.exit(0);
}
const drainClamp = ["drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.max(0, budget.timeoutMs - budget.reserveMs),",
  `drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.min(${seconds(STOP_DRAIN_MS)}, Math.max(0, budget.timeoutMs - budget.reserveMs)), /* openclaw-nix-stop-budget-v1 */`];
// 9.7 derives isRestart from params.action and gives native external restarts
// the stop budget too. Split that shared branch so only a true stop is clamped;
// external-restart keeps upstream's full budget, like every other restart.
// 2026.10.10 also gives an external restart that interrupts after its drain
// (interruptAfterDrain) the whole budget; that restart branch stays upstream's.
const externalRestartBudget = atLeast(version, "2026.10.10")
  ? "(budget.nativeStopBudget || params.interruptAfterDrain)"
  : "budget.nativeStopBudget";
const hardExitBefore = `forceExitMs: !isRestart || action === \"external-restart\" && ${externalRestartBudget} ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)`;
const hardExitAfter = `forceExitMs: !isRestart ? Math.min(budget.timeoutMs, ${seconds(STOP_HARD_EXIT_MS)}) : action === \"external-restart\" && ${externalRestartBudget} ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)`;
// 2026.10.6 bounds the stop drain itself: active runs get STOP_DRAIN_TIMEOUT_MS
// (20 s), then are cancelled and cleaned up within the rest of the budget
// (openclaw/openclaw#171308). That is below this clamp, so the drain is
// upstream's and only the hard exit is clamped (upstream's is the whole native
// budget, about 325 s under prod's 6 min TimeoutStopSec).
const v106 = atLeast(version, "2026.10.6");
let upstreamStopDrainMs = null;
if (v106) {
  const upstreamDrain = "drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.min(STOP_DRAIN_TIMEOUT_MS, Math.max(0, budget.timeoutMs - budget.reserveMs)),";
  assert.equal(source.split(upstreamDrain).length, 2, "stop-budget: upstream's bounded stop drain moved");
  const constant = source.match(/\nconst STOP_DRAIN_TIMEOUT_MS = ([0-9.e]+);\n/);
  assert(constant, "stop-budget: STOP_DRAIN_TIMEOUT_MS not found");
  upstreamStopDrainMs = Number(constant[1]);
  assert(upstreamStopDrainMs > 0 && upstreamStopDrainMs <= STOP_DRAIN_MS, `stop-budget: upstream's stop drain ${upstreamStopDrainMs} ms is above the clamp`);
}
const replacements = v106 ? [
  [hardExitBefore, `${hardExitAfter} /* openclaw-nix-stop-budget-v1 */`],
] : atLeast(version, "2026.9.7") ? [
  drainClamp,
  [hardExitBefore, hardExitAfter],
] : version === "2026.9.6" ? [
  ["drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.max(0, budget.timeoutMs - budget.reserveMs),",
    `drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.min(${seconds(STOP_DRAIN_MS)}, Math.max(0, budget.timeoutMs - budget.reserveMs)), /* openclaw-nix-stop-budget-v1 */`],
  ["forceExitMs: !isRestart ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)",
    `forceExitMs: !isRestart ? Math.min(budget.timeoutMs, ${seconds(STOP_HARD_EXIT_MS)}) : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)`],
] : version === "2026.9.5" ? [
  ["if (!isRestart) armForceExitTimer(acceptedShutdownTimeoutMs);",
    `if (!isRestart) armForceExitTimer(Math.min(acceptedShutdownTimeoutMs, ${seconds(STOP_HARD_EXIT_MS)})); /* openclaw-nix-stop-budget-v1 */`],
  ["const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS);",
    `const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.min(${seconds(STOP_DRAIN_MS)}, Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS));`],
] : [
  ["if (!isRestart) armForceExitTimer(SHUTDOWN_TIMEOUT_MS);", `if (!isRestart) armForceExitTimer(${seconds(STOP_HARD_EXIT_MS)}); /* openclaw-nix-stop-budget-v1 */`],
  ["const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, 315e3);",
    `const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, ${seconds(STOP_DRAIN_MS)});`],
];
for (const [before, after] of replacements) {
  assert.equal(source.split(before).length, 2, `stop-budget anchor changed: ${before}`);
  source = source.replace(before, after);
}
fs.writeFileSync(file, source);
fs.writeFileSync(path.join(root, ".stop-budget-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-stop-budget-v1", upstreamVersion: version, patchedFile: candidates[0],
  stopDrainMs: upstreamStopDrainMs ?? STOP_DRAIN_MS, stopDrainOwner: v106 ? "upstream" : "openclaw-nix",
  stopHardExitMs: STOP_HARD_EXIT_MS, restartPolicyUnchanged: true,
}, null, 2) + "\n");
console.log(v106
  ? `Applied stop-only ${STOP_HARD_EXIT_MS / 1e3}s hard-exit budget over upstream's ${upstreamStopDrainMs / 1e3}s stop drain; restart policy unchanged`
  : `Applied stop-only ${STOP_DRAIN_MS / 1e3}s drain / ${STOP_HARD_EXIT_MS / 1e3}s hard-exit budget; restart policy unchanged`);
