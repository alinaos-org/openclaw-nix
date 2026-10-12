// The replaced channels are gone from the bundled channel config metadata as the
// gateway loads it, every other bundled channel remains, every inlined copy is
// filtered, and the bundled plugin trees are removed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

const [root, ...ids] = process.argv.slice(2);
const MARKER = "/* openclaw-nix-replace-bundled-channels-v1 */";
const ANCHOR = "JSON.parse(RAW_BUNDLED_CHANNEL_CONFIG_METADATA)";
const count = (text, needle) => text.split(needle).length - 1;
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".replace-bundled-channels.json"), "utf8"));
assert.deepEqual(receipt.channels, ids);

const generated = receipt.patchedFiles.find((name) => name.includes("bundled-channel-config-metadata.generated-"));
const module = await import(pathToFileURL(path.join(root, generated)).href);
const metadata = Object.values(module).find(Array.isArray);
assert(metadata?.length > 0, "the generated module exports no bundled channel metadata");
for (const id of ids) {
  assert(!metadata.some((entry) => entry.channelId === id), `bundled channel "${id}" is still in the metadata`);
}

for (const name of receipt.patchedFiles) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  assert.equal(count(text, `${ANCHOR}${MARKER}.filter(`), count(text, ANCHOR), `${name}: an unfiltered copy remains`);
}
for (const tree of receipt.removed) {
  assert.equal(fs.lstatSync(path.join(root, tree), {throwIfNoEntry: false}), undefined, `${tree} still exists`);
}
console.log(`Replaced bundled channels: ${metadata.length} bundled channels remain, none of ${ids.join(", ")}`);
