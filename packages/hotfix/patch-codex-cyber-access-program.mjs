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
const buildHeader = "function buildTurnStartParams(params, options) {";
const modelSelection = "const modelSelection = options.preserveNativeTurnSettings ? void 0 : resolveCodexAppServerRequestModelSelection({";
const tail = "\t\t...params.requireWorkspaceOnly === true ? { environments: [] } : options.environmentSelection ? { environments: options.environmentSelection } : {}\n\t};\n}";
const turnStart = patchOne(ownFiles(setup, /^thread-lifecycle-.*\.mjs$/), buildHeader, [buildHeader, modelSelection, tail], (text) => text
  .replace(buildHeader, `${helper}\n${buildHeader}`)
  .replace(tail, "\t\t...modelSelection && openclawNixCodexCyberAccessProgram(params) ? { cyberAccessProgram: openclawNixCodexCyberAccessProgram(params) } : {},\n" + tail));

// 2. Failover: the retry asks for Daybreak; "already Daybreak" means this turn asked too.
const harnessRegion = "//#region extensions/codex/harness.ts";
const retryBefore = "const runAttemptOnModel = (model, isRetry = false) => runCodexAppServerAttempt(isRetry ? {\n\t\t\t\t...params,\n\t\t\t\tsuppressNextUserMessagePersistence: true\n\t\t\t} : params, {";
const retryAfter = `const runAttemptOnModel = (model, isRetry = false) => runCodexAppServerAttempt(isRetry ? {\n\t\t\t\t...params,\n\t\t\t\tsuppressNextUserMessagePersistence: true,\n\t\t\t\t${RETRY_PARAM}: "daybreakBlue"\n\t\t\t} : params, {`;
const currentBefore = "config: cyberFailover,\n\t\t\t\tcurrentModel: attemptModel,";
const currentAfter = "config: cyberFailover,\n\t\t\t\tcurrentModel: openclawNixCodexCyberAccessProgram(params) ? attemptModel : void 0,";
const harness = patchOne(ownFiles(codex, /^harness\.js$/), harnessRegion, [harnessRegion, retryBefore, currentBefore], (text) => text
  .replace(harnessRegion, `${harnessRegion}\n${helper}`)
  .replace(retryBefore, retryAfter)
  .replace(currentBefore, currentAfter));

// 3. Failover default: the retiring alias becomes gpt-6-sol.
const failoverRegion = "//#region extensions/codex/src/app-server/cyber-failover.ts";
const defaultBefore = "const DEFAULT_CYBER_FAILOVER = {\n\tmode: \"auto\",\n\tmodel: \"gpt-daybreak-blue-latest\",";
const defaultAfter = `const DEFAULT_CYBER_FAILOVER = { ${MARKER}\n\tmode: "auto",\n\tmodel: "gpt-6-sol",`;
const failover = patchOne(ownFiles(setup, /^cyber-failover-.*\.mjs$/), failoverRegion, [failoverRegion, defaultBefore], (text) => text.replace(defaultBefore, defaultAfter));

const patchedFiles = [turnStart, harness, failover];
fs.writeFileSync(path.join(root, ".codex-cyber-access-program-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-codex-cyber-access-program-v1", upstreamVersion: version, env: ENV, failoverModel: "gpt-6-sol", patchedFiles,
}, null, 2) + "\n");
console.log(`Codex cyber access program: ${patchedFiles.join(", ")}`);
