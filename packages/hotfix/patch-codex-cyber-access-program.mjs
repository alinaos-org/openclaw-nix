// OpenAI retires the gpt-daybreak-blue-latest / -red-latest aliases on 2026-10-28; the
// models stay, and Daybreak becomes a per-request choice (Codex app-server: the
// experimental `cyberAccessProgram` on turn/start, which OpenClaw's client already opts
// into with experimentalApi). OpenClaw 2026.10.4 never sends it: Daybreak rides only on
// the alias slug, which is also its cyber-failover default.
//
// Three edits, all in the bundled codex plugin:
// - turn/start carries cyberAccessProgram "daybreakBlue" for an agent listed in
//   OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS (comma-separated agent ids), and for the
//   cyber-failover retry. Every other turn omits it, as upstream does ("omission
//   preserves automatic behavior"). Native-settings (supervision) turns, which send no
//   model, are untouched.
// - The failover retry requests Daybreak itself, and counts a turn as "already Daybreak"
//   only when that turn requested it, so a plain refusal on the failover model is
//   retried once on the same model with Daybreak.
// - The failover default model becomes gpt-6-sol (an explicit
//   appServer.cyberFailover.model still wins).
// Authorization stays server-owned: an unentitled workspace gets 401/403, which the
// failover already records as unavailable.
//
// From 2026.11.5 upstream sends cyberAccessProgram itself (Access: a session choice,
// else the model/agent params.accessPrograms.cyber setting, else "standard"), and its
// cyber failover retries the same model with daybreak_blue, so the second and third
// edits are upstream's own and only the first remains, as one edit in the codex
// plugin's resolveCodexCyberAccessProgram: an agent listed in
// OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS defaults to daybreak_blue where it would get
// Standard. Its configuring twin, params.accessPrograms on the model or agent, cannot
// stand in: any authored params entry counts as a request transport override
// (hasAuthoredProviderRequestParams), which Codex declares it cannot reproduce, so the
// turn would leave the Codex runtime for OpenClaw's. A session choice, the failover
// retry and an explicit Daybreak Red setting still win; the listed agent's model
// fallbacks (Kimi, Claude CLI) are untouched, since only the codex plugin reads the
// variable. Upstream checks entitlement (account/read and the model's advertised
// availableAccessPrograms.cyber) before turn/start.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.4"), "codex cyber-access-program hotfix is qualified from 2026.10.4");
const codex = path.join(root, "dist", "extensions", "codex");
const setup = path.join(codex, ".setup");

const MARKER = "/* openclaw-nix-codex-cyber-access-program-v1 */";
const ENV = "OPENCLAW_CODEX_DAYBREAK_BLUE_AGENTS";
const RETRY_PARAM = "openclawNixCodexCyberAccessProgram";
const helper = [
  `function openclawNixCodexCyberAccessProgram(params) { ${MARKER}`,
  `\tif (params?.${RETRY_PARAM} === "daybreakBlue") return "daybreakBlue";`,
  "\tconst agentId = typeof params?.agentId === \"string\" ? params.agentId.trim().toLowerCase() : \"\";",
  "\tif (!agentId) return void 0;",
  `\treturn (process.env.${ENV} ?? "").split(",").some((id) => id.trim().toLowerCase() === agentId) ? "daybreakBlue" : void 0;`,
  "}",
].join("\n");

const count = (text, needle) => text.split(needle).length - 1;
const ownFiles = (dir, pattern) => fs.readdirSync(dir).filter((name) => pattern.test(name)).map((name) => path.join(dir, name)).filter((file) => !fs.lstatSync(file).isSymbolicLink());
// From 2026.11.5: one edit in upstream's own Access resolver (see the header).
if (atLeast(version, "2026.11.5")) {
  const files = ownFiles(setup, /\.mjs$/);
  const header = "function resolveCodexCyberAccessProgram(params) {";
  const hits = files.filter((file) => fs.readFileSync(file, "utf8").includes(header));
  assert.equal(hits.length, 1, `expected one file with ${header}, got ${hits.map((f) => path.basename(f)).join(", ") || "none"}`);
  const [file] = hits;
  const text = fs.readFileSync(file, "utf8");
  assert.equal(count(text, MARKER), 0, `${path.basename(file)} is already patched`);
  const programBefore = "const program = params.cyberAccessProgram ?? programs?.cyber;";
  const programAfter = "const program = params.cyberAccessProgram ?? openclawNixCodexDaybreakBlueDefault(params, programs?.cyber);";
  for (const anchor of ["//#region extensions/codex/src/app-server/access-program.ts", header, programBefore,
    "const configured = params.runtimePlan?.transport.resolveExtraParams().accessPrograms;",
    'return program === "daybreak_blue" ? "daybreakBlue" : program === "daybreak_red" ? "daybreakRed" : program === "standard" ? "standard" : void 0;']) {
    assert.equal(count(text, anchor), 1, `anchor changed in ${path.basename(file)}: ${anchor.slice(0, 70)}`);
  }
  // The failover half is upstream's from this release; refuse if that changes.
  const harnessFiles = ownFiles(setup, /^harness-.*\.mjs$/).filter((f) => fs.readFileSync(f, "utf8").includes("//#region extensions/codex/harness.ts"));
  assert.equal(harnessFiles.length, 1, "expected one codex harness chunk");
  const harnessText = fs.readFileSync(harnessFiles[0], "utf8");
  assert.equal(count(harnessText, 'cyberAccessProgram: "daybreak_blue",'), 1, "upstream's failover retry no longer requests daybreak_blue");
  assert.equal(count(harnessText, "currentAccessProgram: resolveCodexCyberAccessProgram(params),"), 1, "upstream's failover no longer reads the turn's Access");
  const failoverFiles = ownFiles(setup, /^cyber-failover-.*\.mjs$/).filter((f) => fs.readFileSync(f, "utf8").includes("//#region extensions/codex/src/app-server/cyber-failover.ts\n"));
  assert.equal(failoverFiles.length, 1, "expected one cyber-failover chunk");
  assert(!fs.readFileSync(failoverFiles[0], "utf8").includes("gpt-daybreak"), "upstream's failover names a Daybreak alias again");
  const defaultHelper = [
    `function openclawNixCodexDaybreakBlueDefault(params, configured) { ${MARKER}`,
    '\tif (configured !== void 0 && configured !== "standard") return configured;',
    "\tconst agentId = typeof params?.agentId === \"string\" ? params.agentId.trim().toLowerCase() : \"\";",
    "\tif (!agentId) return configured;",
    `\treturn (process.env.${ENV} ?? "").split(",").some((id) => id.trim().toLowerCase() === agentId) ? "daybreak_blue" : configured;`,
    "}",
  ].join("\n");
  const patched = text.replace(header, `${defaultHelper}\n${header}`).replace(programBefore, programAfter);
  assert.notEqual(patched, text, `${path.basename(file)} unchanged`);
  fs.writeFileSync(file, patched);
  const patchedFiles = [path.relative(root, file)];
  fs.writeFileSync(path.join(root, ".codex-cyber-access-program-hotfix.json"), JSON.stringify({
    id: "openclaw-nix-codex-cyber-access-program-v1", upstreamVersion: version, env: ENV, mode: "access-default",
    failoverModel: null, patchedFiles,
  }, null, 2) + "\n");
  console.log(`Codex cyber access program (listed agents default to daybreak_blue; failover is upstream's): ${patchedFiles.join(", ")}`);
  process.exit(0);
}

// Exactly one file carries `needle`; patch it with `edit` after checking every anchor.
const patchOne = (files, needle, anchors, edit) => {
  const hits = files.filter((file) => fs.readFileSync(file, "utf8").includes(needle));
  assert.equal(hits.length, 1, `expected one file with ${needle.slice(0, 60)}, got ${hits.map((f) => path.basename(f)).join(", ") || "none"}`);
  const [file] = hits;
  const text = fs.readFileSync(file, "utf8");
  assert.equal(count(text, MARKER), 0, `${path.basename(file)} is already patched`);
  assert.equal(count(text, "cyberAccessProgram"), 0, `${path.basename(file)} already handles cyberAccessProgram (upstream fix? drop this patch)`);
  for (const anchor of anchors) assert.equal(count(text, anchor), 1, `anchor changed in ${path.basename(file)}: ${anchor.trim().slice(0, 70)}`);
  const patched = edit(text);
  assert.notEqual(patched, text, `${path.basename(file)} unchanged`);
  fs.writeFileSync(file, patched);
  return path.relative(root, file);
};

// 1. turn/start: request Daybreak Blue for listed agents and the failover retry.
// From 2026.10.10 the builder is async and awaits the model selection.
const asyncBuilder = atLeast(version, "2026.10.10");
const buildHeader = `${asyncBuilder ? "async " : ""}function buildTurnStartParams(params, options) {`;
const modelSelection = `const modelSelection = options.preserveNativeTurnSettings ? void 0 : ${asyncBuilder ? "await " : ""}resolveCodexAppServerRequestModelSelection({`;
const tail = "\t\t...params.requireWorkspaceOnly === true ? { environments: [] } : options.environmentSelection ? { environments: options.environmentSelection } : {}\n\t};\n}";
// The builder's chunk is named by what the bundler groups with it (thread-lifecycle
// through 10.4, dynamic-tools in 10.5): find it by its header among the .setup chunks.
const turnStart = patchOne(ownFiles(setup, /\.mjs$/), buildHeader, [buildHeader, modelSelection, tail], (text) => text
  .replace(buildHeader, `${helper}\n${buildHeader}`)
  .replace(tail, "\t\t...modelSelection && openclawNixCodexCyberAccessProgram(params) ? { cyberAccessProgram: openclawNixCodexCyberAccessProgram(params) } : {},\n" + tail));

// The codex plugin's chunks mark their source modules with `//#region <path>` through
// 2026.10.9 and with a plain `// <path>` comment in 2026.10.10's published plugin;
// accept whichever form the file carries exactly once.
const regionMarker = (files, name) => {
  const forms = [...new Set(files.flatMap((file) => {
    const text = fs.readFileSync(file, "utf8");
    return [`//#region ${name}`, `// ${name}`].filter((form) => count(text, form) === 1);
  }))];
  assert.equal(forms.length, 1, `expected one region marker form for ${name}, got ${forms.join(", ") || "none"}`);
  return forms[0];
};

// 2. Failover: the retry asks for Daybreak; "already Daybreak" means this turn asked too.
const harnessRegion = regionMarker(ownFiles(codex, /^harness\.js$/), "extensions/codex/harness.ts");
const retryBefore = "const runAttemptOnModel = (model, isRetry = false) => runCodexAppServerAttempt(isRetry ? {\n\t\t\t\t...params,\n\t\t\t\tsuppressNextUserMessagePersistence: true\n\t\t\t} : params, {";
const retryAfter = `const runAttemptOnModel = (model, isRetry = false) => runCodexAppServerAttempt(isRetry ? {\n\t\t\t\t...params,\n\t\t\t\tsuppressNextUserMessagePersistence: true,\n\t\t\t\t${RETRY_PARAM}: "daybreakBlue"\n\t\t\t} : params, {`;
const currentBefore = "config: cyberFailover,\n\t\t\t\tcurrentModel: attemptModel,";
const currentAfter = "config: cyberFailover,\n\t\t\t\tcurrentModel: openclawNixCodexCyberAccessProgram(params) ? attemptModel : void 0,";
const harness = patchOne(ownFiles(codex, /^harness\.js$/), harnessRegion, [harnessRegion, retryBefore, currentBefore], (text) => text
  .replace(harnessRegion, `${harnessRegion}\n${helper}`)
  .replace(retryBefore, retryAfter)
  .replace(currentBefore, currentAfter));

// 3. Failover default: the retiring alias becomes gpt-6-sol.
const failoverRegion = regionMarker(ownFiles(setup, /^cyber-failover-.*\.mjs$/), "extensions/codex/src/app-server/cyber-failover.ts");
const defaultBefore = "const DEFAULT_CYBER_FAILOVER = {\n\tmode: \"auto\",\n\tmodel: \"gpt-daybreak-blue-latest\",";
const defaultAfter = `const DEFAULT_CYBER_FAILOVER = { ${MARKER}\n\tmode: "auto",\n\tmodel: "gpt-6-sol",`;
const failover = patchOne(ownFiles(setup, /^cyber-failover-.*\.mjs$/), failoverRegion, [failoverRegion, defaultBefore], (text) => text.replace(defaultBefore, defaultAfter));

const patchedFiles = [turnStart, harness, failover];
fs.writeFileSync(path.join(root, ".codex-cyber-access-program-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-codex-cyber-access-program-v1", upstreamVersion: version, env: ENV, failoverModel: "gpt-6-sol", patchedFiles,
}, null, 2) + "\n");
console.log(`Codex cyber access program: ${patchedFiles.join(", ")}`);
