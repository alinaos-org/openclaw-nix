// Behavioural check for patch-codex-cyber-access-program.mjs on the installed tree:
// upstream's own buildTurnStartParams sends cyberAccessProgram only for a listed agent or
// the failover retry, never on a native-settings turn; the failover default is gpt-6-sol
// and escalates a plain refusal on that same model; the harness helper and its two call
// sites agree. From 2026.11.5 (receipt mode "access-default") the patch edits only
// upstream's Access resolver: a listed agent defaults to Daybreak Blue where it would get
// Standard, through upstream's own turn/start builder, and upstream's failover treats
// that turn as already elevated.
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
const exportAliasOf = (text, name) => new RegExp(`\\b${name} as (\\w+)`).exec(/export \{([^}]*)\}/.exec(text)?.[1] ?? "")?.[1];
const setEnv = (value) => { if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value; };

if (receipt.mode === "access-default") {
  assert.equal(receipt.patchedFiles.length, 1, "receipt lists one patched file");
  const accessFile = path.join(root, receipt.patchedFiles[0]);
  execFileSync(process.execPath, ["--check", accessFile], { stdio: ["ignore", "pipe", "pipe"] });
  const accessText = fs.readFileSync(accessFile, "utf8");
  assert.equal(accessText.split("openclaw-nix-codex-cyber-access-program-v1").length - 1, 1, "marker missing or repeated");
  const resolveAlias = exportAliasOf(accessText, "resolveCodexCyberAccessProgram");
  assert(resolveAlias, "the access-program chunk no longer exports resolveCodexCyberAccessProgram");
  const resolve = (await import(pathToFileURL(accessFile).href))[resolveAlias];
  const plan = (cyber) => ({ transport: { resolveExtraParams: () => (cyber === undefined ? {} : { accessPrograms: cyber === null ? {} : { cyber } }) } });
  const saved = process.env[ENV];
  const access = (env, params) => { setEnv(env); try { return resolve(params); } finally { setEnv(saved); } };
  // Upstream's runtime plan defaults supported Codex routes to "standard".
  assert.equal(access("reverser", { agentId: "reverser", runtimePlan: plan("standard") }), "daybreakBlue", "listed agent not defaulted to Daybreak Blue");
  assert.equal(access(" coder , Reverser ", { agentId: "reverser", runtimePlan: plan("standard") }), "daybreakBlue", "list not trimmed / case-folded");
  assert.equal(access("reverser", { agentId: "reverser" }), "daybreakBlue", "listed agent without a runtime plan");
  assert.equal(access("reverser", { agentId: "reverser", runtimePlan: plan(null) }), "daybreakBlue", "listed agent with accessPrograms {}");
  for (const env of [undefined, "", "coder", "reverser-2", ","]) {
    assert.equal(access(env, { agentId: "reverser", runtimePlan: plan("standard") }), "standard", `Daybreak with ${ENV}=${JSON.stringify(env)}`);
    assert.equal(access(env, { agentId: "reverser" }), undefined, `Access invented with ${ENV}=${JSON.stringify(env)}`);
  }
  assert.equal(access("reverser", { agentId: undefined, runtimePlan: plan("standard") }), "standard", "Daybreak without an agent id");
  assert.equal(access("reverser", { agentId: "reverser", runtimePlan: plan("standard"), cyberAccessProgram: "standard" }), "standard", "session choice no longer wins");
  assert.equal(access("reverser", { agentId: "reverser", runtimePlan: plan("standard"), cyberAccessProgram: "daybreak_red" }), "daybreakRed", "session Red overridden");
  assert.equal(access("reverser", { agentId: "reverser", runtimePlan: plan("daybreak_red") }), "daybreakRed", "configured Red overridden");
  assert.equal(access(undefined, { agentId: "coder", runtimePlan: plan("standard"), cyberAccessProgram: "daybreak_blue" }), "daybreakBlue", "failover retry not honoured");
  assert.throws(() => access("reverser", { agentId: "reverser", runtimePlan: { transport: { resolveExtraParams: () => ({ accessPrograms: { cyber: "future" } }) } } }), /accessPrograms must be/, "invalid setting no longer rejected");

  // turn/start through upstream's packaged builder, which imports the patched resolver.
  const setup = path.dirname(accessFile);
  const builders = fs.readdirSync(setup).filter((name) => name.endsWith(".mjs") && fs.readFileSync(path.join(setup, name), "utf8").includes("async function buildTurnStartParams(params, options) {"));
  assert.equal(builders.length, 1, `expected one turn/start chunk, got ${builders.join(", ") || "none"}`);
  const builderText = fs.readFileSync(path.join(setup, builders[0]), "utf8");
  assert(builderText.includes(`from "./${path.basename(accessFile)}"`), "turn/start no longer imports the patched resolver");
  const buildTurnStartParams = (await import(pathToFileURL(path.join(setup, builders[0])).href))[exportAliasOf(builderText, "buildTurnStartParams")];
  assert.equal(typeof buildTurnStartParams, "function", "the turn/start chunk no longer exports buildTurnStartParams");
  const turn = async (env, agentId) => {
    setEnv(env);
    try {
      return await buildTurnStartParams(
        { agentId, prompt: "hi", images: [], config: {}, hostCapabilities: { activeComputerContext: () => "test" }, runtimePlan: plan("standard") },
        { threadId: "t1", cwd: "/tmp", model: "gpt-6-sol", modelProvider: "openai", appServer: { start: { homeScope: "agent" }, approvalPolicy: "never", sandbox: "read-only" } },
      );
    } finally { setEnv(saved); }
  };
  const listed = await turn("reverser", "reverser");
  assert.equal(listed.model, "gpt-6-sol", "model selection changed");
  assert.equal(listed.cyberAccessProgram, "daybreakBlue", "listed agent's turn/start not sent Daybreak Blue");
  assert.equal((await turn("reverser", "coder")).cyberAccessProgram, "standard", "unlisted agent's turn/start changed");

  // Failover: upstream's own; a listed agent's turn counts as already elevated.
  const failoverFiles = fs.readdirSync(setup).filter((name) => /^cyber-failover-.*\.mjs$/.test(name) && [...fs.readFileSync(path.join(setup, name), "utf8").matchAll(/^\/\/(?:#region |! ?| )extensions\/codex\/src\/app-server\/cyber-failover\.ts$/gm)].length === 1);
  assert.equal(failoverFiles.length, 1, "expected one cyber-failover chunk");
  const failover = await import(pathToFileURL(path.join(setup, failoverFiles[0])).href);
  const config = failover.resolveCodexCyberFailoverConfig(undefined);
  assert(!("model" in config), "upstream's failover has a target model again");
  const escalation = (currentAccessProgram) => failover.planCodexCyberEscalation({ config, currentModel: "gpt-6-sol", currentAccessProgram, replaySafe: true, workspace: { agentId: "test-agent", authProfileId: "p" } });
  assert.deepEqual(escalation("standard"), { kind: "escalate", model: "gpt-6-sol", cyberAccessProgram: "daybreak_blue" }, "a Standard refusal no longer escalates on the same model");
  assert.equal(escalation(access("reverser", { agentId: "reverser", runtimePlan: plan("standard") })).reason, "already_elevated", "a listed agent's Daybreak turn would be retried");
  console.log(`Codex cyber access program: Access default, turn/start and failover checks passed for ${receipt.patchedFiles.join(", ")}`);
  process.exit(0);
}

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
// From 2026.10.10 the builder is async (it awaits the model selection before reading the
// variable), so the variable stays set until the build settles.
const withEnv = async (value, run) => {
  const saved = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  try { return await run(); } finally { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; }
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
assert.equal((await turn("reverser")).model, "gpt-6-sol", "model selection changed");
assert.equal((await turn("reverser")).cyberAccessProgram, "daybreakBlue", "listed agent not sent Daybreak");
assert.equal((await turn(" coder , Reverser ")).cyberAccessProgram, "daybreakBlue", "list not trimmed / case-folded");
for (const env of [undefined, "", "coder", "reverser-2", ","]) {
  assert(!("cyberAccessProgram" in await turn(env)), `cyberAccessProgram sent with ${ENV}=${JSON.stringify(env)}`);
}
assert(!("cyberAccessProgram" in await turn("reverser", { agentId: undefined })), "sent without an agent id");
assert.equal((await turn(undefined, { openclawNixCodexCyberAccessProgram: "daybreakBlue" })).cyberAccessProgram, "daybreakBlue", "failover retry not sent Daybreak");
assert(!("cyberAccessProgram" in await turn(undefined, { openclawNixCodexCyberAccessProgram: "daybreakRed" })), "retry accepted a program other than daybreakBlue");
const native = await turn("reverser", {}, { preserveNativeTurnSettings: true });
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
