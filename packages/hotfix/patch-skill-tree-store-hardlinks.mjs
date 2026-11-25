// 9.8 cloud-worker turns ship the agent's skills to the worker. readSkillBundleTree
// refuses any file with more than one hard link, which keeps a writable skill folder
// from smuggling a hardlink to a private file into the bundle. Nix store optimisation
// hardlinks every identical store file, so the bundled skills (lib/openclaw/skills)
// all have nlink > 1 and every worker turn failed with "hardlinked path not allowed".
// Allow hard links only when the skill root's real path is in /nix/store: store files
// are immutable and world-readable, and their links come only from deduplication.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.9.8"), "skill-tree store hardlink hotfix is qualified from 2026.9.8");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-skill-tree-store-hardlinks-v1 */";
const header = /async function readSkillBundleTree\(([\w$]+),\s*[\w$]+,\s*([\w$]+)\)\s*\{/g;
const readCall = /const ([\w$]+)\s*=\s*await ([\w$]+)\.read\(([\w$]+)\.relativePath,\s*\{\s*hardlinks:\s*(?:"reject"|\x60reject\x60),\s*symlinks(?::\s*([\w$]+))?,\s*maxBytes:\s*SKILL_LIBRARY_MAX_FILE_BYTES\s*\}\)/g;
const helper = [
  `function isImmutableNixStoreRoot(rootReal) { ${MARKER}`,
  "\treturn typeof rootReal === \"string\" && rootReal.startsWith(\"/nix/store/\");",
  "}",
].join("\n");
const escape = (name) => name.replace(/\$/g, "\\$");
const once = (text, pattern, name) => {
  const hits = [...text.matchAll(pattern)];
  assert.equal(hits.length, 1, `${name}: expected one ${pattern}`);
  return hits[0];
};

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("async function readSkillBundleTree(")) continue;
  const [signature, directory, options] = once(text, header, name);
  const [call, read, safeRoot, entry, symlinks = "symlinks"] = once(text, readCall, name);
  assert(!text.includes(MARKER), `${name} is already patched`);
  const walked = once(text, new RegExp(`for\\s*\\(const ${escape(entry)} of ([\\w$]+)\\.entries\\)\\s*\\{`, "g"), name)[1];
  for (const shape of [
    `const ${escape(walked)}\\s*=\\s*await walkDirectory\\(${escape(directory)},`,
    `const ${escape(symlinks)}\\s*=\\s*${escape(options)}\\?\\.symlinks\\s*\\?\\?\\s*(?:"reject"|\\x60reject\\x60);`,
    `const ${escape(safeRoot)}\\s*=\\s*await root\\(${escape(directory)}\\)\\.catch\\(`,
    `path\\.relative\\(${escape(safeRoot)}\\.rootReal,\\s*${escape(read)}\\.realPath\\)`,
  ]) once(text, new RegExp(shape, "g"), name);
  const replacement = call.replace(/hardlinks:\s*["\x60]reject["\x60],/,
    () => `hardlinks: isImmutableNixStoreRoot(${safeRoot}.rootReal) ? "allow" : "reject", ${MARKER}`);
  fs.writeFileSync(file, text.replace(signature, () => `${helper}\n${signature}`).replace(call, () => replacement));
  patchedFiles.push(name);
}
assert(patchedFiles.some((name) => /^bundle-.*\.mjs$/.test(name)), "skill bundle chunk not patched");
// 9.8-9.9 bundle a second copy into package-update-activation-recovery.mjs; 10.1's
// recovery runtime no longer carries one, so only the live chunk is patched.
const recoveryCopy = !atLeast(version, "2026.10.1");
if (recoveryCopy) assert(patchedFiles.includes("package-update-activation-recovery.mjs"), "update-recovery copy not patched");
assert.equal(patchedFiles.length, recoveryCopy ? 2 : 1, `unexpected skill tree readers: ${patchedFiles.join(", ")}`);

fs.writeFileSync(path.join(root, ".skill-tree-store-hardlinks-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-skill-tree-store-hardlinks-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Skill tree: store hardlinks allowed in ${patchedFiles.join(", ")}`);
