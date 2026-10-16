import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.9.4"), "stop-budget hotfix requires a qualified stable release");
const dist = path.join(root, "dist");
const candidates = fs.readdirSync(dist).filter((name) => /^run-.*\.mjs$/.test(name)
  && fs.readFileSync(path.join(dist, name), "utf8").includes("const runAcceptedRequest ="));
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
const drainClamp = ["drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.max(0, budget.timeoutMs - budget.reserveMs),",
  "drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.min(120e3, Math.max(0, budget.timeoutMs - budget.reserveMs)), /* openclaw-nix-stop-budget-v1 */"];
// 9.7 derives isRestart from params.action and gives native external restarts
// the stop budget too. Split that shared branch so only a true stop is clamped;
// external-restart keeps upstream's full budget, like every other restart.
const replacements = atLeast(version, "2026.9.7") ? [
  drainClamp,
  ["forceExitMs: !isRestart || action === \"external-restart\" && budget.nativeStopBudget ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)",
    "forceExitMs: !isRestart ? Math.min(budget.timeoutMs, 180e3) : action === \"external-restart\" && budget.nativeStopBudget ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)"],
] : version === "2026.9.6" ? [
  ["drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.max(0, budget.timeoutMs - budget.reserveMs),",
    "drainTimeoutMs: isRestart ? restartDrainTimeoutMs : Math.min(120e3, Math.max(0, budget.timeoutMs - budget.reserveMs)), /* openclaw-nix-stop-budget-v1 */"],
  ["forceExitMs: !isRestart ? budget.timeoutMs : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)",
    "forceExitMs: !isRestart ? Math.min(budget.timeoutMs, 180e3) : restartDrainTimeoutMs === void 0 ? void 0 : restartTimeoutMs(restartDrainTimeoutMs)"],
] : version === "2026.9.5" ? [
  ["if (!isRestart) armForceExitTimer(acceptedShutdownTimeoutMs);",
    "if (!isRestart) armForceExitTimer(Math.min(acceptedShutdownTimeoutMs, 180e3)); /* openclaw-nix-stop-budget-v1 */"],
  ["const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS);",
    "const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.min(120e3, Math.max(0, acceptedShutdownTimeoutMs - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS));"],
] : [
  ["if (!isRestart) armForceExitTimer(SHUTDOWN_TIMEOUT_MS);", "if (!isRestart) armForceExitTimer(180e3); /* openclaw-nix-stop-budget-v1 */"],
  ["const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, 315e3);",
    "const drainTimeoutMs = isRestart ? restartDrainTimeoutMs : Math.max(0, 120e3);"],
];
for (const [before, after] of replacements) {
  assert.equal(source.split(before).length, 2, `stop-budget anchor changed: ${before}`);
  source = source.replace(before, after);
}
fs.writeFileSync(file, source);
fs.writeFileSync(path.join(root, ".stop-budget-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-stop-budget-v1", upstreamVersion: version, patchedFile: candidates[0],
  stopDrainMs: 120000, stopHardExitMs: 180000, restartPolicyUnchanged: true,
}, null, 2) + "\n");
console.log("Applied stop-only 120s drain / 180s hard-exit budget; restart policy unchanged");
