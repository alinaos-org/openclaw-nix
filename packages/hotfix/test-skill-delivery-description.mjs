// Behavioural check for patch-skill-delivery-description.mjs: the clamp keeps every
// description within the protocol's own schema, and leaves short ones unchanged.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

const [root] = process.argv.slice(2);
const dist = path.join(root, "dist");
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".skill-delivery-description-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-skill-delivery-description-v1");

const chunk = receipt.patchedFiles.find((name) => name.startsWith("resources-"));
const text = fs.readFileSync(path.join(dist, chunk), "utf8");
const start = text.indexOf("function clampSkillDeliveryDescription(text) {");
const end = text.indexOf("\n}\n", start);
assert(start >= 0 && end > start, "clamp helper missing");
const clamp = vm.runInNewContext(`(${text.slice(start, end + 2)})`);

// Validate against the real protocol schema the gateway and worker both check.
const schemaChunk = /from "\.\/(skill-resources-[^"]+\.mjs)"/.exec(text)?.[1];
assert(schemaChunk, "resources chunk no longer imports the skill-resources schema");
const schemaExports = /export \{([^}]*)\}/.exec(fs.readFileSync(path.join(dist, schemaChunk), "utf8"))?.[1] ?? "";
const schemaAlias = /\bSkillResourceDeliverySchema as (\w+)/.exec(schemaExports)?.[1];
assert(schemaAlias, "skill-resources chunk no longer exports SkillResourceDeliverySchema");
const schema = (await import(pathToFileURL(path.join(dist, schemaChunk)).href))[schemaAlias];
// Resolve typebox the way the gateway does: from its own node_modules, via the export map.
const typeboxDir = path.join(root, "node_modules", "typebox");
const valueEntry = JSON.parse(fs.readFileSync(path.join(typeboxDir, "package.json"), "utf8")).exports["./value"];
const { Value } = await import(pathToFileURL(path.join(typeboxDir, valueEntry.import ?? valueEntry.default)).href);
const delivery = (description) => ({ version: 1, skills: [{ name: "probe", description, revision: "a".repeat(64), files: [] }] });

for (const description of ["short", "x".repeat(1024), "x".repeat(1025), "y".repeat(5000), `${"z".repeat(1020)}😀😀😀`]) {
  const clamped = clamp(description);
  assert(clamped.length <= 1024, `clamped to ${clamped.length}`);
  assert(Value.Check(schema, delivery(clamped)), `schema rejects a clamped ${description.length}-character description`);
  if (description.length <= 1024) assert.equal(clamped, description);
  else assert(clamped.endsWith("..."));
}
assert(!Value.Check(schema, delivery("x".repeat(1025))), "the schema bound moved; re-derive the clamp");
console.log(`Skill delivery: clamp keeps descriptions within the worker contract (${receipt.patchedFiles.join(", ")})`);
