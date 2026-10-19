// Behavioural check for patch-codex-cyber-access-program.mjs on the installed tree:
// upstream's own buildTurnStartParams sends cyberAccessProgram only for a listed agent or
// the failover retry, never on a native-settings turn; the failover default is gpt-6-sol
// and escalates a plain refusal on that same model; the harness helper and its two call
// sites agree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".codex-cyber-access-program-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-codex-cyber-access-program-v1");
const ENV = receipt.env;
const file = (pattern) => {
  const hits = receipt.patchedFiles.filter((name) => pattern.test(path.basename(name)));
  assert.equal(hits.length, 1, `receipt lists ${hits.length} files matching ${pattern}`);
  return path.join(root, hits[0]);
};
// The turn/start chunk's name follows the bundler (thread-lifecycle until 10.4,
// dynamic-tools in 10.5): it is the patched file that defines the builder.
const turnStartHits = receipt.patchedFiles.filter((name) => fs.readFileSync(path.join(root, name), "utf8").includes("function buildTurnStartParams(params, options) {"));
assert.equal(turnStartHits.length, 1, `receipt lists ${turnStartHits.length} files defining buildTurnStartParams`);
const turnStartFile = path.join(root, turnStartHits[0]);
const harnessFile = file(/^harness\.js$/);
const failoverFile = file(/^cyber-failover-.*\.mjs$/);
for (const name of [turnStartFile, harnessFile, failoverFile]) execFileSync(process.execPath, ["--check", name]);
const exportAlias = (text, name) => new RegExp(`\\b${name} as (\\w+)`).exec(/export \{([^}]*)\}/.exec(text)?.[1] ?? "")?.[1];
const withEnv = (value, run) => {
  const saved = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  try { return run(); } finally { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; }
};

// 1. turn/start, through upstream's packaged builder.
const turnStartText = fs.readFileSync(turnStartFile, "utf8");
const buildAlias = exportAlias(turnStartText, "buildTurnStartParams");
assert(buildAlias, "the turn/start chunk no longer exports buildTurnStartParams");
const buildTurnStartParams = (await import(pathToFileURL(turnStartFile).href))[buildAlias];
const turn = (env, extraParams = {}, extraOptions = {}) => withEnv(env, () => buildTurnStartParams(
  { agentId: "reverser", prompt: "hi", images: [], config: {}, hostCapabilities: { activeComputerContext: () => "test" }, ...extraParams },
  { threadId: "t1", cwd: "/tmp", model: "gpt-6-sol", modelProvider: "openai", appServer: { start: { homeScope: "agent" }, approvalPolicy: "never", sandbox: "read-only" }, ...extraOptions },
));
assert.equal(turn("reverser").model, "gpt-6-sol", "model selection changed");
assert.equal(turn("reverser").cyberAccessProgram, "daybreakBlue", "listed agent not sent Daybreak");
assert.equal(turn(" coder , Reverser ").cyberAccessProgram, "daybreakBlue", "list not trimmed / case-folded");
for (const env of [undefined, "", "coder", "reverser-2", ","]) {
  assert(!("cyberAccessProgram" in turn(env)), `cyberAccessProgram sent with ${ENV}=${JSON.stringify(env)}`);
}
assert(!("cyberAccessProgram" in turn("reverser", { agentId: undefined })), "sent without an agent id");
assert.equal(turn(undefined, { openclawNixCodexCyberAccessProgram: "daybreakBlue" }).cyberAccessProgram, "daybreakBlue", "failover retry not sent Daybreak");
assert(!("cyberAccessProgram" in turn(undefined, { openclawNixCodexCyberAccessProgram: "daybreakRed" })), "retry accepted a program other than daybreakBlue");
const native = turn("reverser", {}, { preserveNativeTurnSettings: true });
assert(!("model" in native) && !("cyberAccessProgram" in native), "native-settings turn changed");

// 2. Failover default and the "already Daybreak" decision, through upstream's chunk.
const failover = await import(pathToFileURL(failoverFile).href);
const config = failover.resolveCodexCyberFailoverConfig(undefined);
assert.equal(config.model, "gpt-6-sol", "failover default not moved");
assert.equal(failover.resolveCodexCyberFailoverConfig({ appServer: { cyberFailover: { model: "gpt-5.6-sol" } } }).model, "gpt-5.6-sol", "configured failover model ignored");
const plan = (currentModel) => failover.planCodexCyberEscalation({ config, currentModel, replaySafe: true, workspace: { agentId: "test-agent", authProfileId: "p" } });
assert.deepEqual(plan(undefined), { kind: "escalate", model: "gpt-6-sol" }, "plain refusal not escalated");
assert.equal(plan("gpt-6-sol").reason, "already_daybreak", "a Daybreak turn on the target would be retried");

// 3. Harness: the same helper, the retry asks for Daybreak, and only a Daybreak turn
// counts as already on it.
const harnessText = fs.readFileSync(harnessFile, "utf8");
const helperOf = (text, name) => {
  const start = text.indexOf("function openclawNixCodexCyberAccessProgram(params) {");
  const end = text.indexOf("\n}\n", start);
  assert(start >= 0 && end > start, `${name}: helper missing`);
  return text.slice(start, end + 2);
};
const helper = helperOf(harnessText, "harness.js");
assert.equal(helper, helperOf(turnStartText, "turn/start chunk"), "harness and turn/start helpers differ");
const run = (env, params) => vm.runInNewContext(`${helper}\nopenclawNixCodexCyberAccessProgram(params)`, { process: { env: env === undefined ? {} : { [ENV]: env } }, params });
assert.equal(run("reverser", { agentId: "reverser" }), "daybreakBlue");
assert.equal(run("reverser", { agentId: "coder" }), undefined);
assert.equal(run(undefined, { agentId: "reverser" }), undefined);
assert.equal(run(undefined, { openclawNixCodexCyberAccessProgram: "daybreakBlue" }), "daybreakBlue");
assert.equal(run(undefined, undefined), undefined);
assert.equal(harnessText.split('openclawNixCodexCyberAccessProgram: "daybreakBlue"').length - 1, 1, "retry does not request Daybreak");
assert.equal(harnessText.split("currentModel: openclawNixCodexCyberAccessProgram(params) ? attemptModel : void 0,").length - 1, 1, "already-Daybreak check not rewritten");
assert(!harnessText.includes("currentModel: attemptModel,"), "upstream already-Daybreak check still present");

console.log(`Codex cyber access program: turn/start, failover and harness checks passed for ${receipt.patchedFiles.join(", ")}`);
