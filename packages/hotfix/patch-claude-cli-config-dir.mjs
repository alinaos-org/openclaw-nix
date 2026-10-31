// Claude Code keeps its session transcripts in $CLAUDE_CONFIG_DIR/projects when that
// variable is set, and in ~/.claude/projects otherwise. OpenClaw always looks in
// $HOME/.claude/projects, so a gateway that runs Claude with its own CLAUDE_CONFIG_DIR
// (nova's prod and merlin since 2026-10-24) finds no transcript for any claude-cli
// session. With the live Claude process still running, each turn is then pinned to
// that exact process, and any change to its fingerprint (a system prompt drift, a
// session patch) fails the turn with "Managed CLI live session is no longer reusable.
// | cli_live_session_changed", which the chat shows as "Your AI session expired".
// Without a live process the session resets with reason=missing-transcript and Claude
// starts over without the conversation. Both resolvers (the per-workspace project dir
// and the projects root the history import reads) follow CLAUDE_CONFIG_DIR, in the main
// bundle and in the worker bundles. A caller that passes homeDir explicitly keeps
// upstream's $homeDir/.claude/projects.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.8"), "claude-cli config dir hotfix is qualified from 2026.10.8");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-claude-cli-config-dir-v1 */";
const configDir = (homeDirExpr, normalize) => `${normalize}(${homeDirExpr}) ? void 0 : process.env.CLAUDE_CONFIG_DIR?.trim()`;

// Readable main-bundle copies.
const projectDirBefore = "\treturn path.join(homeDir, CLAUDE_PROJECTS_DIRNAME, sanitizeClaudeCliProjectKey(canonicalWorkspaceDir));";
const projectDirAnchor = [
  "function resolveClaudeCliProjectDirForWorkspace(params) {",
  "\tconst homeDir = normalizeOptionalString(params.homeDir) || process.env.HOME || os.homedir();",
  "\tconst canonicalWorkspaceDir = canonicalizeWorkspaceDir(params.workspaceDir);",
  projectDirBefore,
].join("\n");
const projectDirAfter = [
  `\tconst openclawNixClaudeConfigDir = ${configDir("params.homeDir", "normalizeOptionalString")}; ${MARKER}`,
  "\tif (openclawNixClaudeConfigDir) return path.join(path.resolve(openclawNixClaudeConfigDir), \"projects\", sanitizeClaudeCliProjectKey(canonicalWorkspaceDir));",
  projectDirBefore,
].join("\n");
const projectsRootAnchor = "function resolveClaudeProjectsDir(homeDir) {\n\treturn path.join(normalizeOptionalString(homeDir) || process.env.HOME || os.homedir(), CLAUDE_PROJECTS_RELATIVE_DIR);";
const projectsRootAfter = [
  "function resolveClaudeProjectsDir(homeDir) {",
  `\tconst openclawNixClaudeConfigDir = ${configDir("homeDir", "normalizeOptionalString")}; ${MARKER}`,
  "\tif (openclawNixClaudeConfigDir) return path.join(path.resolve(openclawNixClaudeConfigDir), \"projects\");",
  "\treturn path.join(normalizeOptionalString(homeDir) || process.env.HOME || os.homedir(), CLAUDE_PROJECTS_RELATIVE_DIR);",
].join("\n");

// Minified worker copies: the same two functions with renamed locals.
const id = "[\\w$]+";
const projectDirMin = new RegExp(`function resolveClaudeCliProjectDirForWorkspace\\((${id})\\)\\{let (${id})=(${id})\\(\\1\\.homeDir\\)\\|\\|process\\.env\\.HOME\\|\\|(${id})\\.homedir\\(\\),(${id})=canonicalizeWorkspaceDir\\(\\1\\.workspaceDir\\);return (${id})\\.join\\(\\2,`, "g");
const projectDirMinAfter = (_, p, home, norm, os, ws, pathId) =>
  `function resolveClaudeCliProjectDirForWorkspace(${p}){let ${home}=${norm}(${p}.homeDir)||process.env.HOME||${os}.homedir(),${ws}=canonicalizeWorkspaceDir(${p}.workspaceDir);` +
  `let openclawNixClaudeConfigDir=${norm}(${p}.homeDir)?void 0:process.env.CLAUDE_CONFIG_DIR?.trim();${MARKER}` +
  `if(openclawNixClaudeConfigDir)return ${pathId}.join(${pathId}.resolve(openclawNixClaudeConfigDir),"projects",sanitizeClaudeCliProjectKey(${ws}));return ${pathId}.join(${home},`;
const projectsRootMin = new RegExp(`function resolveClaudeProjectsDir\\((${id})\\)\\{return (${id})\\.join\\((${id})\\(\\1\\)\\|\\|process\\.env\\.HOME\\|\\|(${id})\\.homedir\\(\\),(${id})\\)\\}`, "g");
const projectsRootMinAfter = (_, h, pathId, norm, os, rel) =>
  `function resolveClaudeProjectsDir(${h}){let openclawNixClaudeConfigDir=${norm}(${h})?void 0:process.env.CLAUDE_CONFIG_DIR?.trim();${MARKER}` +
  `if(openclawNixClaudeConfigDir)return ${pathId}.join(${pathId}.resolve(openclawNixClaudeConfigDir),"projects");return ${pathId}.join(${norm}(${h})||process.env.HOME||${os}.homedir(),${rel})}`;

const count = (text, needle) => text.split(needle).length - 1;
const matches = (text, re) => (text.match(re) || []).length;
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name);
  if (entry.isSymbolicLink()) return [];
  if (entry.isDirectory()) return files(file);
  return /\.m?js$/.test(entry.name) ? [file] : [];
});

const patched = { projectDir: [], projectsRoot: [] };
for (const file of files(dist)) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("function resolveClaudeCliProjectDirForWorkspace(") && !text.includes("function resolveClaudeProjectsDir(")) continue;
  const name = path.relative(dist, file);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  const defs = count(text, "function resolveClaudeCliProjectDirForWorkspace(");
  const roots = count(text, "function resolveClaudeProjectsDir(");
  assert(defs <= 1 && roots <= 1, `${name}: a resolver is defined twice`);
  let next = text;
  if (defs === 1) {
    if (count(next, projectDirAnchor) === 1) next = next.replace(projectDirBefore, projectDirAfter);
    else {
      assert.equal(matches(next, projectDirMin), 1, `${name}: project dir resolver anchor changed`);
      next = next.replace(projectDirMin, projectDirMinAfter);
    }
    patched.projectDir.push(name);
  }
  if (roots === 1) {
    if (count(next, projectsRootAnchor) === 1) next = next.replace(projectsRootAnchor, projectsRootAfter);
    else {
      assert.equal(matches(next, projectsRootMin), 1, `${name}: projects root resolver anchor changed`);
      next = next.replace(projectsRootMin, projectsRootMinAfter);
    }
    patched.projectsRoot.push(name);
  }
  assert.equal(count(next, MARKER), defs + roots, `${name}: every resolver patched`);
  fs.writeFileSync(file, next);
}
// 2026.10.8: one readable copy of each in dist/, one minified copy of each in its own
// worker chunk, and one more of each inside the SQLite store worker.
assert.equal(patched.projectDir.length, 3, `project dir resolvers: ${patched.projectDir.join(", ")}`);
assert.equal(patched.projectsRoot.length, 3, `projects root resolvers: ${patched.projectsRoot.join(", ")}`);

fs.writeFileSync(path.join(root, ".claude-cli-config-dir-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-claude-cli-config-dir-v1", upstreamVersion: version, patched,
}, null, 2) + "\n");
console.log(`Claude CLI transcripts follow CLAUDE_CONFIG_DIR in ${[...new Set([...patched.projectDir, ...patched.projectsRoot])].join(", ")}`);
