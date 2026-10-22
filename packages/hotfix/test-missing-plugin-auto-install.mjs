// Behavioural check for patch-missing-plugin-auto-install.mjs on the packaged chunk,
// against a scratch state directory. Plugins from the official external catalog that
// this release does not bundle are configured: with the escape hatch set, doctor's
// detection still offers to install them (so they are real install candidates); without
// it, detection reports them as not provided by Nix, and the repair skips them through
// its failure path, warning per plugin, without an install or an install record.
// The worker copies are checked for the same three edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".missing-plugin-auto-install-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-missing-plugin-auto-install-v1");
const ALLOW = receipt.escapeHatch;
assert.equal(ALLOW, "OPENCLAW_NIX_ALLOW_RUNTIME_PLUGIN_INSTALL");
for (const name of receipt.patchedFiles) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  assert.equal(text.split(`/* ${receipt.id} */`).length - 1, 3, `${name}: expected the detection, table and repair edits`);
  assert.equal(text.split(`process.env.${ALLOW} !== "1"`).length - 1, 2, `${name}: both loops must read the escape hatch`);
}

// Never the operator's state: a scratch state directory, config and home.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "missing-plugin-auto-install-test-"));
Object.assign(process.env, {
  HOME: scratch,
  OPENCLAW_STATE_DIR: path.join(scratch, "state"),
  OPENCLAW_CONFIG_PATH: path.join(scratch, "state", "openclaw.json"),
});
delete process.env[ALLOW];
try {
  const chunk = receipt.patchedFiles.find((name) => /^dist\/missing-configured-plugin-install-[^/]+\.mjs$/.test(name));
  const source = fs.readFileSync(path.join(root, chunk), "utf8");
  const exported = (name) => {
    const alias = source.match(new RegExp(`\\b${name} as ([\\w$]+)`))?.[1];
    assert(alias, `${name} is no longer exported from ${chunk}`);
    return alias;
  };
  const mod = await import(pathToFileURL(path.join(root, chunk)).href);
  const detect = mod[exported("detectConfiguredPluginInstallHealthIssues")];
  const finding = mod[exported("configuredPluginInstallIssueToHealthFinding")];
  const effect = mod[exported("configuredPluginInstallIssueToRepairEffect")];
  const repair = mod[exported("repairMissingPluginInstallsForIds")];

  // Official external plugins 2026.10.5 does not bundle (ClawHub and npm installs).
  const external = ["agentmail", "telnyx", "openclaw-weixin", "openclaw-qqbot", "wecom-openclaw-plugin"];
  const bundled = new Set(fs.readdirSync(path.join(root, "dist", "extensions")));
  const ids = external.filter((id) => !bundled.has(id));
  const cfg = {plugins: {entries: Object.fromEntries(ids.map((id) => [id, {enabled: true}]))}};

  const allowed = await detect({cfg, env: {...process.env, [ALLOW]: "1"}});
  const candidates = allowed.filter((issue) => issue.kind === "missing-install-record").map((issue) => issue.pluginId);
  assert(candidates.length > 0, `none of ${ids.join(", ")} is an install candidate any more; pick other fixtures`);
  assert.match(finding(allowed.find((issue) => issue.kind === "missing-install-record")).fixHint, /doctor --fix` to install/);

  const skipped = await detect({cfg, env: process.env});
  assert.deepEqual(skipped.filter((issue) => issue.kind === "not-provided-by-nix").map((issue) => issue.pluginId), candidates);
  assert(!skipped.some((issue) => issue.kind === "missing-install-record"), "detection still offers an automatic install");
  for (const issue of skipped.filter((entry) => entry.kind === "not-provided-by-nix")) {
    assert.equal(finding(issue).message, `Configured plugin ${issue.pluginId} is not provided by Nix; add it to the gateway's runtime plugins.`);
    assert.match(finding(issue).fixHint, new RegExp(`${ALLOW}=1`));
    assert.equal(effect(issue).action, "would-skip-configured-plugin-install");
  }

  const result = await repair({cfg, pluginIds: ids, env: process.env});
  for (const id of candidates) {
    assert(result.warnings.includes(`plugin ${id} is configured but not provided by Nix; add it to the gateway's runtime plugins (automatic install skipped; ${ALLOW}=1 allows it)`), `no skip warning for ${id}: ${JSON.stringify(result.warnings)}`);
    assert(result.failedPluginIds?.includes(id), `${id} is not reported as failed, so doctor would drop its config`);
    assert.equal(result.records[id], undefined, `${id} gained an install record`);
  }
  assert.equal(result.repairedPluginIds, undefined, "a plugin was installed");
  assert(!result.changes.some((change) => /install/i.test(change)), `repair reported installs: ${result.changes.join("; ")}`);
  // Managed installs land in <config dir>/{extensions,npm}; nothing may appear there.
  const written = fs.readdirSync(scratch, {recursive: true, withFileTypes: true})
    .filter((entry) => entry.isDirectory() && (entry.name === "extensions" || entry.name === "npm"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((dir) => fs.readdirSync(dir).length > 0);
  assert.deepEqual(written, [], "plugin payloads written to the state directory");
  console.log(`Configured plugins: ${candidates.join(", ")} skipped and reported as not provided by Nix; ${ALLOW}=1 restores the install candidates (${receipt.patchedFiles.join(", ")})`);
} finally {
  fs.rmSync(scratch, {recursive: true, force: true});
}
