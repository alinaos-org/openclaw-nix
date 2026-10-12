// Bundled channel plugins that an external plugin with the same channel id
// replaces (customize layer, replaceBundledChannels). Upstream `preferOver`
// settles which plugin owns the channel, but the base config validator still
// checks channels.<id> against the bundled plugin's schema first, so an external
// plugin with a different schema is rejected before ownership is resolved.
// Filter the ids out of the bundled channel config metadata wherever the build
// inlines it (the shared generated module, and worker bundles carrying their own
// copy), so validation, aliases and discovery all defer to the external plugin,
// and remove the bundled plugin trees.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, ...ids] = process.argv.slice(2);
assert(root && ids.length > 0, "usage: replace-bundled-channels.mjs OPENCLAW_ROOT CHANNEL_ID...");
for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9-]*$/, `invalid channel id: ${id}`);

const MARKER = "/* openclaw-nix-replace-bundled-channels-v1 */";
const RAW = "RAW_BUNDLED_CHANNEL_CONFIG_METADATA";
const ANCHOR = `JSON.parse(${RAW})`;
const FILTERED = `${ANCHOR}${MARKER}.filter((entry) => !${JSON.stringify(ids)}.includes(entry.channelId))`;
const count = (text, needle) => text.split(needle).length - 1;
// The raw metadata is JSON inside a string or template literal, so its quotes
// may be escaped.
const declares = (text, id) => new RegExp(`\\\\?"channelId\\\\?":\\\\?"${id}\\\\?"`).test(text);

function* scripts(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    // Dirents are lstat types: symlinked trees (dist-runtime) are skipped.
    if (entry.isDirectory() && entry.name !== "node_modules") yield* scripts(file);
    else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) yield file;
  }
}

const patchedFiles = [];
for (const file of scripts(path.join(root, "dist"))) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(RAW)) continue;
  const name = path.relative(root, file);
  // Every inlined copy is parsed the same way; a renamed or restructured copy
  // would otherwise keep the bundled schema.
  assert(count(text, ANCHOR) > 0, `${name}: bundled channel metadata is not parsed as ${ANCHOR}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  for (const id of ids) {
    assert(declares(text, id), `${name}: the bundled channel metadata has no "${id}"; drop it from replaceBundledChannels`);
  }
  fs.writeFileSync(file, text.split(ANCHOR).join(FILTERED));
  patchedFiles.push(name);
}
assert(
  patchedFiles.some((name) => /^dist\/bundled-channel-config-metadata\.generated-[^/]+\.m?js$/.test(name)),
  "bundled channel config metadata module not found",
);

const removed = [];
for (const id of ids) {
  const trees = ["dist/extensions", "dist-runtime/extensions", "extensions"]
    .map((dir) => path.join(dir, id))
    .filter((tree) => fs.lstatSync(path.join(root, tree), {throwIfNoEntry: false}));
  assert(trees.length > 0, `no bundled plugin tree for "${id}"`);
  for (const tree of trees) fs.rmSync(path.join(root, tree), {recursive: true, force: true});
  removed.push(...trees);
}

fs.writeFileSync(path.join(root, ".replace-bundled-channels.json"), JSON.stringify({
  id: "openclaw-nix-replace-bundled-channels-v1", channels: ids, patchedFiles, removed,
}, null, 2) + "\n");
console.log(`Replaced bundled channels ${ids.join(", ")}: metadata filtered in ${patchedFiles.join(", ")}; removed ${removed.join(", ")}`);
