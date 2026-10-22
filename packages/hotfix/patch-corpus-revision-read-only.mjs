// Memory's transcript corpus (dreaming, session backfill, memory forget) is read in the
// pooled session-history Workers: readSessionTranscriptCorpusInventory lists the
// entries read-only, but each entry's content revision came from
// readTranscriptStatsSync, a writable openOpenClawAgentDatabase inside the Worker. That
// claims an agent-database lease the Worker's own handle cache keeps until the
// process exits, and no shutdown releases it. On nova prod the 04:30 dreaming run left
// one on every agent database, so every later stop ended `active-leases` and the next
// start held all 16 agents for background inspection (92 s on 2026-10-22, main's boot
// run failing). Upstream keeps the inventory's revisions on the read-only reader on
// main (openclaw/openclaw#168631); 2026.10.x stable diverged before it.
//
// Same behaviour here: the inventory projects with readOnly, an entry passes it to the
// revision, and a read-only revision reads its stats through the chunk's
// readTranscriptStatsBatchReadOnlySync (no lease; an unavailable transcript has no
// revision, as a failed read already had). Every other caller keeps the writable read.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.5"), "corpus revision read-only hotfix is qualified from 2026.10.5");
const dist = path.join(root, "dist");

const ID = "openclaw-nix-corpus-revision-read-only-v1";
const MARKER = `/* ${ID} */`;
const count = (text, needle) => text.split(needle).length - 1;

const revisionBefore = "function readTranscriptContentRevisionSync(params) {\n\tconst stats = readTranscriptStatsSync(params);\n\treturn [";
const revisionAfter = [
  "function readTranscriptContentRevisionSync(params) {",
  `\tconst { readOnly, ...scope } = params; ${MARKER}`,
  "\tconst stats = readOnly ? readTranscriptStatsBatchReadOnlySync([scope])[0] : readTranscriptStatsSync(scope);",
  "\tif (!stats) return;",
  "\treturn [",
].join("\n");
const readOnlyReader = "function readTranscriptStatsBatchReadOnlySync(scopes) {";
const entryBefore = "\t\t\t...transcriptKey ? { sessionKey: transcriptKey } : {},\n\t\t\tstorePath: databasePath\n\t\t}) : void 0;";
const entryAfter = `\t\t\t...transcriptKey ? { sessionKey: transcriptKey } : {},\n\t\t\tstorePath: databasePath,\n\t\t\treadOnly: options.readOnly === true ${MARKER}\n\t\t}) : void 0;`;
const projection = "function projectSessionTranscriptCorpusEntries(scope, options, artifacts, sessionEntries, databasePath = scope.storePath, continuation) {";
const inventoryBefore = "function readSessionTranscriptCorpusInventory(scope, options, artifacts, databasePath, continuation) {\n\treturn projectSessionTranscriptCorpusEntries(scope, options, artifacts, readCorpusSessionEntries({";
const inventoryAfter = `function readSessionTranscriptCorpusInventory(scope, options, artifacts, databasePath, continuation) {\n\toptions = {\n\t\t...options,\n\t\treadOnly: true\n\t}; ${MARKER}\n\treturn projectSessionTranscriptCorpusEntries(scope, options, artifacts, readCorpusSessionEntries({`;

const patchedFiles = {};
for (const name of fs.readdirSync(dist).filter((entry) => entry.endsWith(".mjs")).sort()) {
  const file = path.join(dist, name);
  if (fs.lstatSync(file).isSymbolicLink()) continue;
  let text = fs.readFileSync(file, "utf8");
  const hasRevision = count(text, "function readTranscriptContentRevisionSync(") > 0;
  const hasInventory = count(text, "function readSessionTranscriptCorpusInventory(") > 0;
  if (!hasRevision && !hasInventory) continue;
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  if (hasRevision) {
    assert(!patchedFiles.revision, `readTranscriptContentRevisionSync in ${patchedFiles.revision} and ${name}`);
    assert.equal(count(text, revisionBefore), 1, `content revision anchor changed in ${name}`);
    // The read-only reader must be this chunk's own binding, not an import alias.
    assert.equal(count(text, readOnlyReader), 1, `${name}: readTranscriptStatsBatchReadOnlySync is not defined beside the revision`);
    text = text.replace(revisionBefore, revisionAfter);
    patchedFiles.revision = name;
  }
  if (hasInventory) {
    assert(!patchedFiles.corpus, `readSessionTranscriptCorpusInventory in ${patchedFiles.corpus} and ${name}`);
    assert.equal(count(text, projection), 1, `corpus projection signature changed in ${name}`);
    assert.equal(count(text, entryBefore), 1, `corpus entry revision anchor changed in ${name}`);
    assert.equal(count(text, inventoryBefore), 1, `corpus inventory anchor changed in ${name}`);
    // The entry's revision call must sit inside the projection, where `options` is its parameter.
    const start = text.indexOf(projection), next = text.indexOf("\nfunction ", start + 1);
    assert(text.indexOf(entryBefore) > start && text.indexOf(entryBefore) < next, `${name}: entry revision is not inside the projection`);
    text = text.replace(entryBefore, entryAfter).replace(inventoryBefore, inventoryAfter);
    patchedFiles.corpus = name;
  }
  fs.writeFileSync(file, text);
}
assert(patchedFiles.revision, "readTranscriptContentRevisionSync not found");
assert(patchedFiles.corpus, "readSessionTranscriptCorpusInventory not found");

fs.writeFileSync(path.join(root, ".corpus-revision-read-only-hotfix.json"), JSON.stringify({
  id: ID, upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`Memory corpus: Worker inventory revisions read-only in ${patchedFiles.corpus} and ${patchedFiles.revision}`);
