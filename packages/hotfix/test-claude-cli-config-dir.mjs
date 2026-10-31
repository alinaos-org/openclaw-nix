// Behavioural check for patch-claude-cli-config-dir.mjs: every patched resolver, readable
// and minified, puts transcripts under $CLAUDE_CONFIG_DIR/projects when it is set, keeps
// an explicit homeDir, and falls back to $HOME/.claude/projects. The patched files still
// parse, and the main project-dir chunk still loads and resolves through its export.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const dist = path.join(root, "dist");
const MARKER = "/* openclaw-nix-claude-cli-config-dir-v1 */";
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".claude-cli-config-dir-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-claude-cli-config-dir-v1");
assert.equal(receipt.patched.projectDir.length, 3);
assert.equal(receipt.patched.projectsRoot.length, 3);

// The function's source from its header to the brace that closes it.
const functionSource = (text, header) => {
  const start = text.indexOf(header);
  assert(start >= 0, `${header} missing`);
  let depth = 0;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`${header} never closes`);
};
const normalize = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const fakeOs = { homedir: () => "/home/fallback" };
const key = (dir) => dir.replace(/[^a-zA-Z0-9]/g, "-");
const env = (vars) => ({ env: { HOME: "/home/user", ...vars } });

const run = (source, bindings, vars, ...args) => vm.runInNewContext(`(${source})`, {
  path, process: env(vars), canonicalizeWorkspaceDir: (dir) => dir, sanitizeClaudeCliProjectKey: key, ...bindings,
})(...args);
// Names the function uses for path, os, the normaliser and its relative-dir constant.
const bindingsFor = (source, kind) => {
  const pathId = source.match(/return ([\w$]+)\.join\(/)[1];
  const normId = source.match(/([\w$]+)\((?:[\w$]+\.homeDir|[\w$]+)\)\s*\|\|\s*process\.env\.HOME/)[1];
  const osId = source.match(/process\.env\.HOME\s*\|\|\s*([\w$]+)\.homedir\(\)/)[1];
  const constId = kind === "projectDir"
    ? source.match(/\.join\([\w$]+,\s*([\w$]+),\s*sanitizeClaudeCliProjectKey/)[1]
    : source.match(/homedir\(\),\s*([\w$]+)\)/)[1];
  return { [pathId]: path, [normId]: normalize, [osId]: fakeOs, [constId]: path.join(".claude", "projects") };
};

const workspace = "/home/matthew/projects";
for (const [kind, header] of [["projectDir", "function resolveClaudeCliProjectDirForWorkspace("], ["projectsRoot", "function resolveClaudeProjectsDir("]]) {
  for (const name of receipt.patched[kind]) {
    const source = functionSource(fs.readFileSync(path.join(dist, name), "utf8"), header);
    assert(source.includes(MARKER), `${name}: ${kind} not patched`);
    const bindings = bindingsFor(source, kind);
    const call = (vars, home) => kind === "projectDir"
      ? run(source, bindings, vars, { workspaceDir: workspace, homeDir: home })
      : run(source, bindings, vars, home);
    const tail = kind === "projectDir" ? [key(workspace)] : [];
    // CLAUDE_CONFIG_DIR set (and trimmed, resolved): its own projects folder.
    assert.equal(call({ CLAUDE_CONFIG_DIR: " /home/user/.openclaw-prod/claude/ " }), path.join("/home/user/.openclaw-prod/claude/projects", ...tail), `${name} ${kind}`);
    // An explicit homeDir keeps upstream's layout even with the variable set.
    assert.equal(call({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/other"), path.join("/home/other/.claude/projects", ...tail), `${name} ${kind}`);
    // Unset or blank: $HOME/.claude/projects, as before.
    assert.equal(call({}), path.join("/home/user/.claude/projects", ...tail), `${name} ${kind}`);
    assert.equal(call({ CLAUDE_CONFIG_DIR: "  " }), path.join("/home/user/.claude/projects", ...tail), `${name} ${kind}`);
  }
}

const touched = [...new Set([...receipt.patched.projectDir, ...receipt.patched.projectsRoot])];
for (const name of touched) execFileSync(process.execPath, ["--check", path.join(dist, name)]);

// The real module, through its export, with the gateway's own process environment.
const mainChunk = receipt.patched.projectDir.find((name) => !name.includes(path.sep));
const resolver = Object.values(await import(pathToFileURL(path.join(dist, mainChunk)).href)).find((value) => typeof value === "function");
const saved = process.env.CLAUDE_CONFIG_DIR;
try {
  process.env.CLAUDE_CONFIG_DIR = "/tmp/openclaw-nix-claude-config";
  assert.equal(resolver({ workspaceDir: "/nonexistent/ws" }), path.join("/tmp/openclaw-nix-claude-config/projects", key("/nonexistent/ws")));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(resolver({ workspaceDir: "/nonexistent/ws", homeDir: "/h" }), path.join("/h/.claude/projects", key("/nonexistent/ws")));
} finally {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
}
console.log(`Claude CLI transcripts follow CLAUDE_CONFIG_DIR (${touched.join(", ")})`);
