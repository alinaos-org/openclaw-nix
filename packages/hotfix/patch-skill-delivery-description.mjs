// 9.8 cloud-worker turns ship every candidate skill to the worker, checked against the
// protocol's SkillResourceDeliverySchema (description maxLength 1024). Local turns
// accept longer descriptions; on 2026-10-05 Anthropic's claude-api skill (1068
// characters as the gateway parses it) was enough to fail the whole catalog with
// "Selected skill catalog exceeds the worker resource contract", so no worker turn ran.
// Clamp each description to the contract when the delivery is built; nothing else
// changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.9.8"), "skill delivery description hotfix is qualified from 2026.9.8");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-skill-delivery-description-v1 */";
// From 2026.11.5 on upstream's build mangles local names (tsdown minify, mangle with
// keepNames), so the parameters and loop variables are single letters that can change
// with any rebuild. The anchors therefore match the code's shape with any identifiers
// in those places; each shape must still occur exactly once.
const header = /^async function prepareSkillResourceDelivery\(\w+, \w+, \w+ = \[\], \w+\) \{$/gm;
const helper = [
  `function clampSkillDeliveryDescription(text) { ${MARKER}`,
  "\tif (typeof text !== \"string\" || text.length <= 1024) return text;",
  "\tlet cut = text.slice(0, 1021);",
  "\tif (/[\\uD800-\\uDBFF]$/u.test(cut)) cut = cut.slice(0, -1);",
  "\treturn `${cut}...`;",
  "}",
].join("\n");
// 11.4 and earlier: `description: skill.description, revision: bundle.revision, files`;
// 11.5: `description: e.description, revision: s.revision, files: r`.
const field = /^(\t\t\tdescription: )(\w+\.description),(\n\t\t\trevision: \w+\.revision,\n\t\t\tfiles(?:: \w+)?\n\t\t\}\);)$/gm;
const count = (text, pattern) => typeof pattern === "string" ? text.split(pattern).length - 1 : [...text.matchAll(pattern)].length;

const patchedFiles = [];
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  const text = fs.readFileSync(file, "utf8");
  if (count(text, header) === 0) continue;
  assert.equal(count(text, header), 1, `prepareSkillResourceDelivery repeated in ${name}`);
  assert.equal(count(text, field), 1, `skill delivery description anchor changed in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  // The clamp mirrors this protocol bound; if upstream changes it, re-derive the clamp.
  assert.equal(count(text, "Selected skill catalog exceeds the worker resource contract."), 1, `${name}: delivery schema check moved`);
  fs.writeFileSync(file, text
    .replace(header, (line) => `${helper}\n${line}`)
    .replace(field, (_, lead, value, rest) => `${lead}clampSkillDeliveryDescription(${value}), ${MARKER}${rest}`));
  patchedFiles.push(name);
}
assert(patchedFiles.some((name) => /^resources-.*\.mjs$/.test(name)), "skill resources chunk not patched");
// 9.8-9.9 bundle a second copy into package-update-activation-recovery.mjs; 10.1's
// recovery runtime no longer carries one, so only the live chunk is patched.
const recoveryCopy = !atLeast(version, "2026.10.1");
if (recoveryCopy) assert(patchedFiles.includes("package-update-activation-recovery.mjs"), "update-recovery copy not patched");
assert.equal(patchedFiles.length, recoveryCopy ? 2 : 1, `unexpected skill delivery builders: ${patchedFiles.join(", ")}`);

fs.writeFileSync(path.join(root, ".skill-delivery-description-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-skill-delivery-description-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Skill delivery: descriptions clamped to the worker contract in ${patchedFiles.join(", ")}`);
