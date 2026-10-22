# Release Recovery Branches

## Runtime config qualification

1. Validate the effective runtime artifact, not raw declarative JSON that still requires the service's release/schema transform. Apply the exact runtime filter to the candidate's generated config in private scratch state, then reproduce user-owned plugin staging before validation. Do not run a production prepare script merely to obtain a test config: it writes live state.
2. Existing staged copies may be reused only after verifying the exact content-addressed plugin-set ID and ordered package basenames including store hashes. Rewrite paths in the scratch config, never production. If the set differs, stage the candidate's exact plugins under private user-owned scratch paths instead. Run the intended validator with both state and config explicitly isolated.
3. Raw-schema failures or missing channel targets caused by unstaged store plugins are test-setup failures, not reasons to remove settings or channels. Require config validation and plugin discovery/registration after normalization; do not waive genuine load failures. Preserve channel configuration and authorization.

## Archive recovery

1. If native archiving stalls on regenerable plugin caches, use SQLite snapshots and individually captured ordinary files in a private filesystem archive. Exclude only proven-regenerable caches and ephemeral IPC, retain the old Nix closure, and enumerate workspaces from both `agents.entries` and legacy `agents.list`. Complete when the archive roots and exclusions are explicit.
2. Use read-only SQLite source connections, an explicit read transaction, a unique destination per database, and explicitly closed connections. Bound lock/no-progress waits separately from total copy time: successful page progress on a large database is not `SQLITE_BUSY`. The verified Python backup callback used a 7-second busy bound and a 600-second total bound; retain status and page counts on failure. Complete each snapshot with `PRAGMA quick_check` before archiving it.
3. If an exclusively locked database remains busy, attempt a stable file-family capture without writing the source: enumerate the main file and any WAL/rollback journal, hash them, copy them into private scratch space, then re-enumerate and rehash the sources and copies. Require identical membership and matching before/copied/after hashes. Retry at most three changed captures, then stop rather than accepting an inconsistent backup. On a matching scratch copy, allow normal SQLite recovery, run `quick_check`, and create an online-backup snapshot. Record this fallback separately from a direct online backup. Verify the exact previously failing database before restarting a bulk archive run.
4. Disable tar inode-based hardlink reuse for temporary snapshot files. Re-read the compressed archive, compare every archived database’s SHA-256 with its source snapshot, repeat `quick_check`, and verify the archive checksum independently. A valid database can still be the wrong database. Mark interrupted archives incomplete and keep only verified files in the accepted manifest.
5. Label fallback archives as non-native restore format with per-file/per-database consistency, not globally atomic snapshots or tested restores. Stage restoration separately from live state. Once upgraded state has migrated, a retained old closure alone is not a safe downgrade; require a compatible state restore before an older binary opens it.

## Failing gate triage

When a contract, closure, formatter, or diff-integrity gate fails against the candidate, diagnose before editing expectations. For a failing contract, compare the same assertion on unchanged `main` and inspect the exact generated artifact first. Classify host-specific derivation differences only after tracing their embedded host identity, config, or unit; preserve exact equality for portable packages. Check existing per-profile model defaults and fallback chains rather than changing configuration to satisfy stale tests. Permit one narrow packaging repair cycle; if no exact validated candidate exists within 45 minutes, stop and report the blocker instead of retrying indefinitely.

## Startup admission recovery

1. Preserve the first failed canary receipt. A just-activated gateway can be active while database inspection/migration or state-lifecycle ownership still blocks agent calls. Compare service/startup logs, the exact error, and read-only `PRAGMA user_version` for the affected agent databases. Retry functional checks after bounded preparation; do not infer readiness from process or HTTP liveness alone.
2. If the error still cites an older schema than the actual database, inspect the installed version’s admission implementation before selecting repair. OpenClaw 2026.9.5 retains startup refusals in process memory; a newer on-disk schema does not clear them. Do not choose `doctor --fix`, manually alter SQLite, or repeat system activation solely from a stale schema number in the error. If the disk really remains unmigrated or unhealthy, use that version’s supported repair guidance instead of assuming a restart will migrate it.
3. With restart authorization and validated config, restart one affected secondary gateway through the supported lifecycle path. Require its original authenticated agent-list and exact-model response checks to pass before applying the same recovery to other affected gateways. Keep a working production gateway untouched. Respect the host’s restart controls; do not turn a secondary-instance recovery into a shell self-restart workaround.
4. Rerun fleet version, API, model, actual startup-log, and readiness comparisons after recovery. Preserve failed receipts separately, publish the verified replacement, and report remaining channel or event-loop degradation rather than claiming clean fleet health. Complete only when the original functional checks pass; a restart command alone is not recovery evidence.

## Leaked agent-database leases

A stop that ends `active-leases` on every agent database even with nothing running
means a handle outlives the work that opened it: the next start runs background
inspection and refuses those agents meanwhile. Find the owner from data, not code:

1. Read the shared state database's `agent_database_leases` (read-only) before and
   after a stop, and match each lease id to the `clean-close receipt` lines: the leaked
   one never gets a receipt. Correlate its `opened_at` with the gateway's log (on nova
   prod, 2026-10-22: 04:30 dreaming opened one on every agent database).
2. Reproduce on a copy: an online backup of the state database and one agent's database
   (lease rows dropped), the config's paths rewritten to the copy and its gateway port
   pointed at nothing, and a CLI command that runs the same code in-process (here
   `memory session-backfill --agent <id>`, a preview that writes nothing), in a
   `systemd-run` scope with `ProtectHome=read-only`. A lease left by the exited process
   is the leak.
3. In a scratch copy of the package's `dist` (other entries symlinked, top-level files
   copied: the worker resolver refuses a symlinked `package.json`), log
   `new Error().stack` with `Error.stackTraceLimit` raised and the Worker `threadId` at
   every `insertInto("agent_database_leases")` and at `releaseOpenClawAgentDatabaseLease`.
   That named the writable open inside the history Worker (openclaw-nix's
   `corpusRevisionReadOnly`, fixed upstream on main), then proved the patch: no lease
   left, and the same output.

## Unchanged cache recovery

When an unrelated cache download blocks the closure, compare running and candidate build dependencies with `nix why-depends --derivation`, then check the exact output with `nix-store --check-validity`; runtime-closure absence does not prove the dependency changed, and a partial output directory is not reusable. For repeated large-transfer resets, recover the unchanged official cache artifact using bounded 1 MiB HTTP/1.1 range requests with six concurrent transfers, retaining completed chunks and validating each response's Content-Range and byte count. Assemble in offset order, verify the official narinfo FileHash, and import from a local file cache containing the original narinfo/signature through `nix copy --from`; keep normal signature verification enabled. Run `nix store verify`, retain a GC root with `nix-store --add-root … --realise`, and prove exact-derivation reuse with `nix build --offline --no-link` before retrying the closure.
