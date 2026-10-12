// Exercise the actual packaged orchestration without importing/booting OpenClaw,
// accessing state, sending signals, or using the network.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const root = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(root + "/.stop-budget-hotfix.json", "utf8"));
const source = fs.readFileSync(root + "/dist/" + receipt.patchedFile, "utf8");
// 9.6 moved every shutdown budget into the pure resolveGatewayShutdownDrainBudget,
// so exercise that function directly instead of driving the whole orchestration:
// evaluate the packaged patched copy beside a baseline with the patch reverted,
// and prove the clamp binds the stop path, never raises a budget, and leaves
// every restart value byte-identical to upstream.
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
if (atLeast(receipt.upstreamVersion, "2026.9.6")) {
  const head = source.indexOf("function resolveGatewayShutdownDrainBudget(params) {");
  assert(head >= 0, "9.6 drain-budget resolver not found");
  const tail = source.indexOf("\nfunction ", head + 10);
  assert(tail > head, "9.6 drain-budget resolver end not found");
  const patchedSrc = source.slice(head, tail);
  assert(patchedSrc.includes("openclaw-nix-stop-budget-v1"), "patch receipt present but resolver is unpatched");
  const v97 = atLeast(receipt.upstreamVersion, "2026.9.7");
  const baselineSrc = patchedSrc
    .replace("Math.min(30e3, Math.max(0, budget.timeoutMs - budget.reserveMs)), /* openclaw-nix-stop-budget-v1 */",
             "Math.max(0, budget.timeoutMs - budget.reserveMs),")
    .replace(v97 ? "forceExitMs: !isRestart ? Math.min(budget.timeoutMs, 90e3) : action === \"external-restart\" && budget.nativeStopBudget ?"
                 : "forceExitMs: !isRestart ? Math.min(budget.timeoutMs, 90e3) :",
             v97 ? "forceExitMs: !isRestart || action === \"external-restart\" && budget.nativeStopBudget ?"
                 : "forceExitMs: !isRestart ? budget.timeoutMs :");
  assert(!baselineSrc.includes("openclaw-nix-stop-budget-v1"), "baseline reversal failed");

  // The slice can end on a `//#region` line comment, so start the trailing
  // expression on its own line or it is swallowed by that comment.
  // Freeze Date.now as well: restartTimeoutMs() is deadline - Date.now(), so
  // a real clock let the patched and baseline calls straddle a millisecond
  // (189999 !== 190000, 2026-10-04).
  const load = (src) => vm.runInNewContext(`${src}\n;resolveGatewayShutdownDrainBudget`,
    { GATEWAY_SHUTDOWN_TIMEOUT_MS: 325000, performance$1: { now: () => 1000 }, Date: { now: () => 5e6 }, Math, Infinity });
  const patchedFn = load(patchedSrc);
  const baseFn = load(baselineSrc);
  // 9.7 reads params.action ("stop" | "restart" | "external-restart") and
  // ignores isRestart; pass both so each release sees the path under test.
  const call = (fn, budget, isRestart, action = isRestart ? "restart" : "stop") => fn({
    budget, isRestart, action, forceRestart: false, restartWithoutSupervisor: false,
    acceptedAtMs: 1000, requestedRestartDrainTimeoutMs: isRestart ? 180000 : 0,
  });

  // A long native stop budget: both stop values must be clamped.
  const long = { timeoutMs: 325000, reserveMs: 10000, nativeStopBudget: true };
  const longStop = call(patchedFn, long, false);
  assert.equal(longStop.drainTimeoutMs, 30000);
  assert.equal(longStop.forceExitMs, 90000);
  assert.equal(call(baseFn, long, false).drainTimeoutMs, 315000);
  assert.equal(call(baseFn, long, false).forceExitMs, 325000);
  console.log("PASS 9.6 resolver: stop drain 30s / hard exit 90s");

  // Across budgets the clamp may only ever lower a stop value, never raise one,
  // and must land exactly on min(clamp, upstream).
  for (const budget of [{ timeoutMs: 20000, reserveMs: 10000, nativeStopBudget: true },
                        { timeoutMs: 85000, reserveMs: 10000, nativeStopBudget: true },
                        { timeoutMs: 325000, reserveMs: 10000, nativeStopBudget: false }]) {
    const p = call(patchedFn, budget, false);
    const b = call(baseFn, budget, false);
    assert.equal(p.drainTimeoutMs, Math.min(30000, b.drainTimeoutMs));
    assert.equal(p.forceExitMs, Math.min(90000, b.forceExitMs));
    assert(p.drainTimeoutMs <= b.drainTimeoutMs && p.forceExitMs <= b.forceExitMs);
  }
  // A budget already inside the clamp is left exactly alone.
  const tiny = { timeoutMs: 20000, reserveMs: 10000, nativeStopBudget: true };
  assert.equal(call(patchedFn, tiny, false).drainTimeoutMs, call(baseFn, tiny, false).drainTimeoutMs);
  assert.equal(call(patchedFn, tiny, false).forceExitMs, call(baseFn, tiny, false).forceExitMs);
  console.log("PASS 9.6 resolver: clamp only ever lowers a stop budget");

  // Restart must be indistinguishable from upstream, including the lazily
  // computed timeouts.
  for (const budget of [long, { timeoutMs: 325000, reserveMs: 10000, nativeStopBudget: false }]) {
    const p = call(patchedFn, budget, true);
    const b = call(baseFn, budget, true);
    assert.equal(p.drainTimeoutMs, b.drainTimeoutMs);
    assert.equal(p.forceExitMs, b.forceExitMs);
    assert.equal(p.restartDrainDeadlineAt === void 0, b.restartDrainDeadlineAt === void 0);
    assert.equal(p.restartTimeoutMs(), b.restartTimeoutMs());
    assert.equal(p.closeDrainTimeoutMs(), b.closeDrainTimeoutMs());
  }
  if (v97) {
    // The upstream baseline must reproduce the exact 9.7 source, or every
    // comparison above is against a fabricated function.
    assert(baselineSrc.includes("forceExitMs: !isRestart || action === \"external-restart\" && budget.nativeStopBudget ? budget.timeoutMs :"), "9.7 baseline reversal mismatch");
    for (const budget of [long, { timeoutMs: 325000, reserveMs: 10000, nativeStopBudget: false }]) {
      const p = call(patchedFn, budget, true, "external-restart");
      const b = call(baseFn, budget, true, "external-restart");
      assert.equal(p.drainTimeoutMs, b.drainTimeoutMs);
      assert.equal(p.forceExitMs, b.forceExitMs);
      assert.equal(p.restartTimeoutMs(), b.restartTimeoutMs());
      assert.equal(p.closeDrainTimeoutMs(), b.closeDrainTimeoutMs());
    }
    assert.equal(call(patchedFn, long, true, "external-restart").forceExitMs, 325000, "external restart must keep the full native budget");
  }
  console.log("PASS 9.6 resolver: restart policy unchanged");
  process.exit(0);
}

const start = source.indexOf("const runAcceptedRequest =");
const end = source.indexOf("const flushPendingStartupRequest =", start);
assert(start >= 0 && end > start);
// 9.5 imports the shared policy; fixture its default while executing the
// packaged orchestration, just like the accepted native budget below.
const constant = receipt.upstreamVersion === "2026.9.5"
  ? ["const GATEWAY_SHUTDOWN_TIMEOUT_MS = 325000;"]
  : source.match(/const SHUTDOWN_TIMEOUT_MS = ([^;]+);/);
assert(constant);
const body = `${constant[0]}\n${source.slice(start, end)}\nglobalThis.invoke = runAcceptedRequest;`;

const scenarios = ["idle", "busy", "drain-error", "close-error", "hung-close", "sigint", "restart", "forced-restart"];
if (receipt.upstreamVersion === "2026.9.5") scenarios.push("native-stop", "short-native-stop");
for (const scenario of scenarios) {
  const acceptedStopBudget = scenario === "native-stop" ? 85000 : scenario === "short-native-stop" ? 20000 : 325000;
  const events = [];
  const timers = [];
  const errors = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const snapshot = { idle: scenario === "idle", counts: { totalActive: 2, embeddedRuns: 1, activeTasks: 1 } };
  const wait = async (ms) => {
    events.push(["drain", ms]);
    if (scenario === "drain-error") throw Error("fixture drain failure");
    return { drained: scenario === "idle", snapshot };
  };
  const lifecycle = { abortActiveCronTaskRuns() {}, listActiveEmbeddedRunSessionIds: () => [], waitForGatewayActiveWork: wait, createGatewayActiveWorkSnapshot: () => snapshot,
    abortEmbeddedAgentRun: () => events.push(["restart-abort"]) };
  const startupOperations = { close: () => events.push(["admission-close"]), drain: async () => events.push(["startup-drain"]) };
  const context = {
    startupOperations, failureWork: null, activeRestartRequest: null,
    nativeStopBudget: scenario.includes("native-stop"), acceptedShutdownTimeoutMs: acceptedStopBudget,
    RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS: 10000,
    logShutdownBudget() {}, formatShutdownReason: () => "test stop",
    formatDrainCounts: () => "2 active", writeStabilityBundle() {},
    forceActiveRestartExit: null, RESTART_DRAIN_STILL_PENDING_WARN_MS: 30000,
    HARD_EXIT_WATCHDOG_GRACE_MS: 2000,
    gatewayLog: { info() {}, warn() {}, error: (s) => errors.push(s) },
    gatewayLog$1: { info() {}, warn() {}, error: (s) => errors.push(s) },
    params: { ownsProcessLifecycle: true, completeBoot: (r) => events.push(["complete", r.outcome]) },
    startGatewayRestartTrace() {}, markGatewayRestartTrace() {}, markRestartDraining() {},
    measureGatewayRestartTrace: async (_name, f) => f(),
    formatErrorMessage: String, eagerLifecycleRuntime: lifecycle,
    loadGatewayLifecycleRuntimeModule: async () => lifecycle,
    resolveRestartDrainTimeoutMs: () => 180000, getManagedUpdateOwner: () => null,
    setTimeout: (f, ms) => { const timer = { f, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; },
    armShutdownHardExitWatchdog: ({ delayMs }) => {
      events.push(["watchdog", delayMs]);
      return { cancel: () => events.push(["watchdog-cancel"]) };
    },
    forceExitAfterStabilityBundle: (why) => events.push(["forced-exit", why]),
    server: { close: async (options) => {
      events.push(["server-close", options.reason]);
      if (scenario === "close-error") throw Error("fixture cleanup failure");
      if (scenario === "hung-close") return new Promise(() => {});
    } },
    hostLifecycle: { retire: async () => events.push(["retire"]) },
    releaseLockIfHeld: async () => events.push(["unlock"]),
    exitProcessAfterLogFlush: async (code) => { events.push(["exit", code]); finish(); },
    handleRestartAfterServerClose: async () => { events.push(["restart-handoff"]); finish(); },
  };
  vm.runInNewContext(body, context);
  const restarting = scenario.includes("restart");
  context.invoke({ action: restarting ? "restart" : "stop", signal: scenario === "sigint" ? "SIGINT" : "SIGTERM",
    restartIntent: { force: scenario === "forced-restart" } });
  // Flush deterministic promise jobs, not wall-clock timers.
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const expectedExitBudget = restarting ? 505000 : Math.min(90000, acceptedStopBudget);
  assert.equal(timers[0].ms, expectedExitBudget);
  assert(events.some((e) => e[0] === "watchdog" && e[1] === expectedExitBudget + 2000));
  if (scenario === "hung-close") {
    assert.equal(timers[0].cleared, false);
    timers[0].f();
    assert(events.some((e) => e[0] === "forced-exit" && e[1] === "gateway.stop_shutdown_timeout"));
    assert.equal(events.some((e) => e[0] === "complete"), false);
    assert.equal(errors.length, receipt.upstreamVersion === "2026.9.5" ? 0 : 1);
  } else {
    await finished;
    assert.equal(timers[0].cleared, true);
    assert(events.some((e) => e[0] === "watchdog-cancel"));
    assert.equal(events.some((e) => e[0] === "forced-exit"), false);
    if (!restarting) {
      assert.deepEqual(events.filter((e) => e[0] === "drain"), [["drain", Math.min(30000, acceptedStopBudget - 10000)]]);
      assert(events.findIndex((e) => e[0] === "startup-drain") < events.findIndex((e) => e[0] === "server-close"));
      assert(events.some((e) => e[0] === "complete" && e[1] === (scenario === "close-error" ? "forced_stop" : "clean_stop")));
      assert(events.some((e) => e[0] === "exit" && e[1] === (scenario === "close-error" ? 1 : 0)));
    } else {
      assert(events.some((e) => e[0] === "restart-handoff"));
      const drains = events.filter((e) => e[0] === "drain");
      if (scenario === "forced-restart") assert.equal(drains.length, 0);
      else assert(drains.length === 1 && drains[0][1] > 179000 && drains[0][1] <= 180000);
    }
  }
  console.log(`PASS packaged lifecycle: ${scenario}`);
}
