// Exercise the packaged content-revision reader with stubbed stats readers, and check
// that the Worker inventory hands it readOnly, without booting OpenClaw or opening state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = process.argv[2];
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".corpus-revision-read-only-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-corpus-revision-read-only-v1");
const marker = `/* ${receipt.id} */`;
const read = (name) => fs.readFileSync(path.join(root, "dist", name), "utf8");

const runtime = read(receipt.patchedFiles.revision);
const start = runtime.indexOf("function readTranscriptContentRevisionSync(params) {");
const end = runtime.indexOf("\n}\n", start);
assert(start >= 0 && end > start, "content revision reader not found");
assert(runtime.slice(start, end).includes(marker), "content revision reader is not patched");
// Arguments are recorded as plain data: objects built in the VM context carry its prototypes.
const calls = [];
const record = (kind, value) => calls.push([kind, JSON.parse(JSON.stringify(value))]);
const stats = { maxSeq: 7, sizeBytes: 512, eventCount: 3, lastMutationAtMs: 10, lastObservedMutationAtMs: 11 };
const sandbox = {
  readTranscriptStatsSync: (scope) => (record("writable", scope), stats),
  readTranscriptStatsBatchReadOnlySync: (scopes) => (record("read-only", scopes), scopes.map((scope) => (scope.sessionId === "gone" ? null : stats))),
};
const revision = vm.runInNewContext(`(${runtime.slice(start, end + 2)})`, sandbox);
const scope = { agentId: "herald", env: { OPENCLAW_STATE_DIR: "/state" }, sessionId: "s1", sessionKey: "agent:herald:main", storePath: "/state/agents/herald/agent/openclaw-agent.sqlite" };

// The Worker inventory's read stays on the read-only reader, without its flag.
assert.equal(revision({ ...scope, readOnly: true }), "sqlite:7:512:3:10:11");
assert.deepEqual(calls.splice(0), [["read-only", [scope]]]);
// An unavailable transcript has no revision instead of a writable open.
assert.equal(revision({ ...scope, sessionId: "gone", readOnly: true }), undefined);
assert.deepEqual(calls.splice(0).map(([kind]) => kind), ["read-only"]);
// Every other caller keeps upstream's writable read, with its parameters unchanged.
assert.equal(revision(scope), "sqlite:7:512:3:10:11");
assert.deepEqual(calls.splice(0), [["writable", scope]]);
assert.equal(revision({ ...scope, readOnly: false }), "sqlite:7:512:3:10:11");
assert.deepEqual(calls.splice(0), [["writable", scope]]);

// The corpus hands readOnly to each entry's revision, and the Worker inventory sets it.
const corpus = read(receipt.patchedFiles.corpus);
assert.equal(corpus.split(marker).length, 3, "corpus chunk carries its two marked edits");
assert(corpus.includes(`storePath: databasePath,\n\t\t\treadOnly: options.readOnly === true ${marker}`), "entry revision does not pass readOnly");
const inventory = corpus.slice(corpus.indexOf("function readSessionTranscriptCorpusInventory("));
assert(/^function readSessionTranscriptCorpusInventory\(scope, options, [^)]*\) \{\n\toptions = \{\n\t\t\.\.\.options,\n\t\treadOnly: true\n\t\}; /.test(inventory), "inventory does not project read-only");
assert(inventory.indexOf("return projectSessionTranscriptCorpusEntries(scope, options,") > 0, "inventory no longer projects with its options");
// The corpus calls this chunk's revision reader, so the patched one is the one that runs.
const binding = /import \{[^}]*\b(\w+) as readTranscriptContentRevisionSync\b[^}]*\} from "\.\/([^"]+)"/.exec(corpus);
assert(binding && binding[2] === receipt.patchedFiles.revision, "corpus imports its content revision from another chunk");
console.log(`Memory corpus: Worker inventory revisions stay read-only (${receipt.patchedFiles.corpus}, ${receipt.patchedFiles.revision})`);
