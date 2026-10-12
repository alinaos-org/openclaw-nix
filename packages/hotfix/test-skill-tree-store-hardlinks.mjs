// Behavioural check for patch-skill-tree-store-hardlinks.mjs on the installed tree: a
// hardlinked skill inside the (store) package root is readable, one outside the store
// is still refused.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [root] = process.argv.slice(2);
const dist = path.join(root, "dist");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".skill-tree-store-hardlinks-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-skill-tree-store-hardlinks-v1");
const chunk = receipt.patchedFiles.find((name) => name.startsWith("bundle-"));
const text = fs.readFileSync(path.join(dist, chunk), "utf8");
const alias = /\breadSkillBundleTree as (\w+)/.exec(/export \{([^}]*)\}/.exec(text)?.[1] ?? "")?.[1];
assert(alias, "bundle chunk no longer exports readSkillBundleTree");
const readSkillBundleTree = (await import(pathToFileURL(path.join(dist, chunk)).href))[alias];

function hardlinkedSkill(parent) {
  const dir = fs.mkdtempSync(path.join(parent, "skill-hardlink-"));
  fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: probe\ndescription: hardlink probe\n---\nbody\n");
  fs.linkSync(path.join(dir, "SKILL.md"), path.join(dir, ".second-link"));
  return dir;
}

// Outside the store the hardlink is still refused.
const outside = hardlinkedSkill(os.tmpdir());
await assert.rejects(readSkillBundleTree(outside), /hardlink/);
fs.rmSync(outside, { recursive: true, force: true });

// Inside the package root (a store path while it builds) it is allowed.
if (fs.realpathSync(root).startsWith("/nix/store/")) {
  const inside = hardlinkedSkill(root);
  try {
    const files = await readSkillBundleTree(inside);
    assert.deepEqual(files.map((file) => file.path).sort(), [".second-link", "SKILL.md"]);
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
  }
} else {
  console.log("Skill tree: package root is not in /nix/store here; store-side case skipped");
}
console.log(`Skill tree: store hardlinks allowed, others refused (${receipt.patchedFiles.join(", ")})`);
