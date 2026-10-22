// 10.5 doctor repair installs every configured plugin it cannot find. Both
// detectConfiguredPluginInstallHealthIssues (findings: "Run `openclaw doctor --fix` to
// install <spec>") and repairMissingPluginInstallsWithLease (the install itself) walk
// the install context's collectInstallCandidates(): configured plugin ids, channels and
// providers that resolve to a downloadable npm or ClawHub package but are neither
// bundled nor discovered. Every mutating caller funnels into that repair loop: doctor
// --fix (config repair, plugin convergence before migrations, the release backfill),
// openclaw update's post-core convergence, and the codex/copilot runtime repair after
// `models set` or a provider login (CLI or the Gateway's models.auth.login).
//
// On a Nix gateway every plugin comes from Nix (bundled, or a runtime plugin on a load
// path), so such an install writes a stray npm/ClawHub install and an install record
// into the state directory (one broke merlin). Upstream nix-openclaw skips the loops
// only under OPENCLAW_NIX_MODE=1, but our writable gateways run with 0, and the config
// overlay's first start on a new release runs `doctor --fix` with Nix mode off. So skip
// candidates unconditionally, unless OPENCLAW_NIX_ALLOW_RUNTIME_PLUGIN_INSTALL=1:
// - the repair loop reports each skipped plugin through its own failure path (a warning
//   naming the plugin, and failedPluginIds), the same as a failed download: doctor then
//   keeps the plugin's config entry and defers model-ref retirement for it;
// - the detection loop reports it as "not provided by Nix" instead of "not installed".
// Recorded installs (updateNpmInstalledPlugins) and `openclaw plugins install` are
// unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.5"), "missing-plugin auto-install hotfix is qualified from 2026.10.5");
const dist = path.join(root, "dist");

const ID = "openclaw-nix-missing-plugin-auto-install-v1";
const MARKER = `/* ${ID} */`;
const ALLOW = "OPENCLAW_NIX_ALLOW_RUNTIME_PLUGIN_INSTALL";
const KIND = "not-provided-by-nix";
const skip = (env) => `${env}.${ALLOW} !== "1" && process.env.${ALLOW} !== "1"`;
const notProvided = (id) => `"plugin " + ${id} + " is configured but not provided by Nix; add it to the gateway's runtime plugins (automatic install skipped; ${ALLOW}=1 allows it)"`;
const detail = `"${KIND}": { message: "is not provided by Nix; add it to the gateway's runtime plugins.", fixHint: "Add it to the gateway's runtime plugins. Automatic plugin installs are off on this gateway (${ALLOW}=1 allows them).", action: "would-skip-configured-plugin-install" }, ${MARKER}`;

// The source chunk and its minified worker copies (locals renamed, function names kept).
// Both loops open the same way:
//   for (const candidate of context.collectInstallCandidates(records, deferred)) {
//     [detection only: if (reported.has(candidate.pluginId)) continue;]
//     const repair = resolveConfiguredPluginCandidateRepair({candidate, records, env, context});
//     if (!repair) continue;
// and the skip goes right after that `continue`, before anything is resolved or installed.
const V = "[\\w$]+";
// property `name` or `name: value` of an object literal
const prop = (name, value) => `${name}(?:\\s*:\\s*${value})?`;
// groups: candidate, context, records
const loopHead = `for\\s*\\(\\s*(?:const|let)\\s+(${V})\\s+of\\s+(${V})\\.collectInstallCandidates\\(\\s*(${V})\\s*,\\s*${V}\\s*\\)\\s*\\)\\s*\\{\\s*`;
// groups: repair, env (undefined for the shorthand `env`); arguments are backreferences
const repairCall = (cand, records, context, repair) => `(?:const|let)\\s+(${V})\\s*=\\s*${V}\\(\\s*\\{\\s*${prop("candidate", `\\${cand}`)}\\s*,\\s*${prop("records", `\\${records}`)}\\s*,\\s*${prop("env", `(${V})`)}\\s*,\\s*${prop("context", `\\${context}`)}\\s*\\}\\s*\\)\\s*;?\\s*if\\s*\\(\\s*!\\${repair}\\s*\\)\\s*continue;?`;
// Detection is preceded by `const reported = new Set(issues.map((issue) => issue.pluginId));`.
// groups: reported, issues, (arrow parameter), candidate, context, records, repair, env
const detectLoop = new RegExp(`(?:const|let)\\s+(${V})\\s*=\\s*new Set\\(\\s*(${V})\\.map\\(\\s*\\(?\\s*(${V})\\s*\\)?\\s*=>\\s*\\3\\.pluginId\\s*\\)\\s*\\)\\s*;?\\s*`
  + loopHead
  + `if\\s*\\(\\s*\\1\\.has\\(\\s*\\4\\.pluginId\\s*\\)\\s*\\)\\s*continue;?\\s*`
  + repairCall(4, 6, 5, 7), "g");
// groups: candidate, context, records, repair, env
const repairLoop = new RegExp(loopHead + repairCall(1, 3, 2, 4), "g");
// CONFIGURED_PLUGIN_INSTALL_ISSUE_DETAILS = { "missing-install-record": { message: "is not installed.", ...
const table =new RegExp(`(${V})\\s*=\\s*\\{(?=\\s*"missing-install-record"\\s*:\\s*\\{\\s*message\\s*:\\s*(["'\`])is not installed\\.\\2)`, "g");
const count = (text, needle) => text.split(needle).length - 1;
const esc = (name) => name.replace(/\$/g, "\\$");

function* scripts(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "extensions") yield* scripts(file);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) yield file;
  }
}

const patchedFiles = [];
for (const file of scripts(dist)) {
  const text = fs.readFileSync(file, "utf8");
  const loops = (text.match(/\bof\s+[\w$]+\.collectInstallCandidates\(/g) ?? []).length;
  const detects = count(text, "async function detectConfiguredPluginInstallHealthIssues(");
  const repairs = count(text, "async function repairMissingPluginInstallsWithLease(");
  if (loops + detects + repairs === 0) continue;
  const name = path.relative(root, file);
  assert(detects === 1 && repairs === 1 && loops === 2, `${name}: expected one detection and one repair candidate loop (${detects}/${repairs}/${loops})`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  const within = (index, fn) => text.lastIndexOf("async function ", index) === text.indexOf(`async function ${fn}(`);

  // Detection: report a skipped candidate as not provided by Nix.
  const detect = [...text.matchAll(detectLoop)];
  assert.equal(detect.length, 1, `${name}: detection candidate loop anchor changed`);
  const [dm] = detect;
  assert(within(dm.index, "detectConfiguredPluginInstallHealthIssues"), `${name}: detection loop moved out of detectConfiguredPluginInstallHealthIssues`);
  const [, , issues, , dCand, , , , dEnv = "env"] = dm;
  const detectAfter = `${dm[0]} if (${skip(dEnv)}) { ${MARKER} ${issues}.push({ kind: "${KIND}", pluginId: ${dCand}.pluginId }); continue; }`;

  // The issue kinds' table: findings and repair effects read it by kind.
  const tables = [...text.matchAll(table)];
  assert.equal(tables.length, 1, `${name}: configured-plugin issue table anchor changed`);
  const [tm] = tables;
  const tableName = esc(tm[1]);
  assert(new RegExp(`function configuredPluginInstallIssueToHealthFinding\\(\\s*(${V})\\s*\\)\\s*\\{\\s*(?:const|let)\\s+${V}\\s*=\\s*${tableName}\\[\\s*\\1\\.kind\\s*\\]`).test(text), `${name}: findings no longer read the issue table`);
  assert(new RegExp(`function configuredPluginInstallIssueToRepairEffect\\(\\s*(${V})\\s*\\)\\s*\\{\\s*return\\s*\\{\\s*kind\\s*:\\s*["'\`]package["'\`]\\s*,\\s*action\\s*:\\s*${tableName}\\[\\s*\\1\\.kind\\s*\\]\\.action`).test(text), `${name}: repair effects no longer read the issue table`);

  // Repair: skip the install through the loop's own failure path.
  const repair = [...text.matchAll(repairLoop)];
  assert.equal(repair.length, 1, `${name}: repair candidate loop anchor changed`);
  const [rm] = repair;
  assert(within(rm.index, "repairMissingPluginInstallsWithLease"), `${name}: repair loop moved out of repairMissingPluginInstallsWithLease`);
  const [, rCand, , , , rEnv = "env"] = rm;
  const fnStart = text.indexOf("async function repairMissingPluginInstallsWithLease(");
  const body = text.slice(fnStart, rm.index);
  const failure = [...body.matchAll(new RegExp(`\\brecordFailure\\s*=\\s*\\(\\s*(${V})\\s*,\\s*(${V})\\s*,\\s*${V}\\s*\\)\\s*=>`, "g"))];
  assert.equal(failure.length, 1, `${name}: recordFailure is no longer defined once in the repair`);
  const [, fPlugin, fMessages] = failure[0];
  assert(new RegExp(`else\\s*\\{\\s*for\\s*\\(\\s*(?:const|let)\\s+(${V})\\s+of\\s+${esc(fMessages)}\\s*\\)\\s*warn\\(\\s*\\1\\s*,\\s*${esc(fPlugin)}\\s*\\)`).test(body.slice(failure[0].index)), `${name}: recordFailure no longer warns each message for the plugin`);
  const repairAfter = `${rm[0]} if (${skip(rEnv)}) { ${MARKER} recordFailure(${rCand}.pluginId, [${notProvided(`${rCand}.pluginId`)}]); continue; }`;

  // Apply back to front so earlier offsets stay valid.
  const edits = [
    [dm.index, dm[0].length, detectAfter],
    [tm.index, tm[0].length, `${tm[0]} ${detail}`],
    [rm.index, rm[0].length, repairAfter],
  ].sort((a, b) => b[0] - a[0]);
  let patched = text;
  for (const [index, length, replacement] of edits) patched = patched.slice(0, index) + replacement + patched.slice(index + length);
  assert.equal(count(patched, MARKER), 3, `${name}: expected three edits`);
  fs.writeFileSync(file, patched);
  patchedFiles.push(name);
}
assert(patchedFiles.some((name) => /^dist\/missing-configured-plugin-install-[^/]+\.mjs$/.test(name)), "configured-plugin install chunk not patched");

fs.writeFileSync(path.join(root, ".missing-plugin-auto-install-hotfix.json"), JSON.stringify({
  id: ID, upstreamVersion: version, escapeHatch: ALLOW, patchedFiles,
}, null, 2) + "\n");
console.log(`Configured plugins: automatic installs skipped unless ${ALLOW}=1 in ${patchedFiles.join(", ")}`);
