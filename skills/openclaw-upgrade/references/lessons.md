# Lessons

What broke or nearly broke OpenClaw upgrades on Nix hosts, folded into the step that
catches it. Host-specific incidents and decisions are in the host profile.

## Cadence

- OpenClaw ships a stable release about every four days, plus a parallel older line.
  Chasing each one is more risk than value: batch, every two to three weeks, sooner only
  for a security fix or a bug you are actually hitting, and name that reason.
- No betas on production. A `-beta.N` previews next month's schema changes.
- A line's first stable carries the month's breaking work (2026.10.1 bumped the state
  schema 19 to 20, removed plugin SDK subpaths and reshaped the worker bundle). Budget a
  patch re-port; a later `.x` of the same line is usually routine.
- Upgrade the cheapest instance first and production last, and keep one recovery
  gateway a release behind, so a broken release always leaves a known-good one.
- A version bump changes the gateway units, so activation itself restarts them and cuts
  their running turns. Pick the window with whoever owns them.

## Builds

- The gateway's source build peaks around 15 GB: `--max 16G` and nothing else beside it.
  With `sharedBuild` it downloads instead; each copy layer (customize, hotfix, a plugin
  graft) then costs about 1.5 minutes and its size on disk.
- Cap every heavy build in its own scope outside every gateway cgroup
  (`scripts/build-capped.sh`): if the scope runs out, the kernel kills the build, not a
  gateway. On ZFS the watchdog counts half the ARC above its floor as available;
  `MemAvailable` alone once stopped builds with 7 GB of reclaimable cache on hand.
- Long-running gateways are the main memory consumer (heap growth, and a Codex
  app-server per agent per Control UI load that stays resident). Check `ps --sort=-rss`
  before a heavy build; other agents' work (a `cargo test` in a gateway lane) counts too.
- Split evaluation-heavy batches; one toplevel plus its contracts per call.
- `systemd-run` expands `${VAR}` in its arguments, and an unset variable becomes empty:
  pass Nix expressions without `${` (`builtins.getAttr n p`), or two failed evaluations
  compare as "identical".
- Scan `dist/` one file at a time: a whole-tree scan in Python reached 14 GB.
- 2026.10.1's "Managed command exited while its process group remained active" in
  `plugins:assets:build` had two causes: no `ps` in the build sandbox, and esbuild's
  `stop()` returning before its service child was reaped. Both are fixed in the build;
  retries stay off by default so a regression shows.
- A host's closure build runs no flake checks. Main's checks can already be red from
  other work: build the same check on main before blaming the candidate, and remember a
  contract stops at its first false assertion, so an inherited failure can hide a new
  one.

## Qualifying on copies

`scripts/qualify-candidate.sh <candidate-bin> <instance>...` snapshots each instance's
live state (SQLite online backup of every database, read-only with a busy timeout, so a
running gateway is fine; caches, logs, media, old backups, runtime-plugin trees, WAL and
lock files skipped), records schema versions and row counts, runs the candidate's
`doctor --fix` on the copy in a `ProtectHome=read-only` scope, counts again, and has the
candidate open the migrated copy. PASS needs doctor and admission to exit 0, no lost
records and no unreadable database. Never run the candidate against live state.

- The copy drops every `*lease*` table's rows: they name the live gateway, which is
  alive, so doctor would refuse with "An agent database is in use".
- Only records may not shrink. Doctor drops derived caches (cached
  `systemPromptReport` snapshots) and drains queues: reported as "trimmed (derived)".
  It also deletes a database whose only rows are metadata and search-index shadow rows
  (2026.10.5 repairs agent databases a bug registered as `(multiple)*.sqlite`), and
  drops tables a release retires (2026.10.5: the Skill Workshop proposal tables):
  reported as "removed (no user rows)" and "retired by the release". A new retirement
  is a lost record until its table and doctor's log line are added to the census, after
  reading the release's retirement code.
- Doctor exit 1 whose only errors are plugin dependencies missing from the copy is the
  harness (the snapshot skips plugin `node_modules`), not a failure.
- A fenced binary refuses to run without its own state: probe its version with a
  scratch state.
- Doctor rewrites the copy's config (`doctor-config.json` against `.before.json`): that
  diff is what it would propose on the live gateway.
- It refuses to start without twice the state size plus 20 GB free. Put the copies
  (`OPENCLAW_UPGRADE_SCRATCH_ROOT`) on a filesystem whose snapshots do not keep them: on
  ZFS a deleted copy stays allocated while any snapshot taken during the run holds it.
- Run instances in parallel only with memory to spare: each doctor holds its copy's
  databases open beside the live gateways. With about 6 GB available, one host ran them
  one at a time (2026.10.4: 8 minutes, the main gateway 4.5 of them).

## Doctor proposals

Each version bump's first start runs the new doctor's migrations. Where the host keeps
config in Nix, doctor's proposed config and workspace changes are not applied; collect
them (from qualification, or the host's migration step), read the reason in doctor's
log, check the live behavior, then adopt each in the Nix source or reject it on purpose.
Record standing decisions in the host profile so the next release does not re-litigate
them.

## First start on a new release

For an instance with `migrateStateOnUpgrade`, the workstation module's prepare-config
(`ExecStartPre`) runs the version migration before the gateway starts. It tars and gzips
a pre-migrate snapshot of the state, then runs the new doctor on the real state, within
900 s (the unit's start timeout is 20 minutes). Until both finish the gateway is not
listening, so readyz reports connection refused rather than "not ready". On one host, a
1.5 GB main gateway's state took 2 minutes to snapshot and 3 for doctor, so it was down
6 minutes in all, against about 90 seconds for a restart on the same release. Follow
progress in the newest `backups/pre-migrate-*`: `state-snapshot.tgz`, then `doctor.log`,
then `.migrated-for-version` holding the new version. A `.migration-failed-for-version`
marker means the gateway refuses to start (see [restart hazards](#restart-hazards)).
Doctor's proposals land in `upgrade-config-drift.json` and
`upgrade-workspace-drift.json`; see [doctor proposals](#doctor-proposals).

## What a version sweep misses

Bumping every pinned version finds only what already exists at an older version. These
change shape instead, and all four were live gaps after the 2026.9.6 upgrade on one
host. Work them alongside the patch layers.

- **New bundled plugins.** Diff the candidate's `dist-runtime/extensions/` against
  `plugins.allow` and `plugins.entries`. A plugin shipped with `enabledByDefault: false`
  needs an `entries` block, an `allow` entry and its own secret wiring, none of which a
  version bump touches. Read its `openclaw.plugin.json` (`configContracts.secretInputs`,
  `contracts`) before wiring it. A decision provider (`decisionModels`,
  `decisionProviders`) is not a chat model: it never appears in `openclaw models list`
  and `infer model inspect` reports "Model not found" for it. That is expected. 2026.9.6
  shipped typesafe this way.
- **Overrides the release made obsolete.** Check every local model override, including
  `models.mode = "merge"` entries, against the new bundled catalog. An override for a
  model the release now catalogs must be deleted, not bumped: a stale one keeps serving
  worse metadata (no image input, fewer context options) while looking right. Assert the
  removal in a contract so it cannot come back. 2026.9.6 made a 9.5 Opus override
  obsolete.
- **nix-openclaw's typed module lagging upstream.** A new upstream config key fails
  evaluation in nix-openclaw's typed options until the module catches up, with an error
  that names the option rather than the lag. Add the key in a jq transform over the
  render instead (`configOverlay.transform`, or the host's own filter), gated to the
  release, and let the gateway validate the result. Re-check the gate on the next bump
  so the workaround does not outlive the lag. `agents.defaults.decisionModel` needed
  this on 2026.9.6.
- **Separately versioned layers.** The agent runtimes bundled in the gateway
  (`node_modules/.pnpm/@openai+codex@*`, `@anthropic-ai+claude-agent-sdk@*`) and the
  host's own CLIs move on their own versions (OpenClaw's desktop app does not: it is
  `pkgs.openclaw-desktop`, built for the release), and `openclaw plugins
  list` shows none of them. A clean plugin sweep says nothing about these; the host
  profile lists the ones it has.

## Restart hazards

- Live agent work: activation restarts gateways, which cuts every in-flight turn and
  kills whatever an agent launched in the gateway's cgroup (builds, tests, long `exec`
  calls). Worktrees and transcripts survive; the turn does not. List running sessions
  (`gateway call sessions.list --params '{"limit":60}'`, status `running`) on each
  gateway and wait for them, or have them reach a checkpoint first.
- Scheduled runs and the outgoing stop budget: `sessions.list` shows only turns already
  running, not a cron job due a minute later. The stop that activation triggers runs
  under the outgoing build's shutdown budget, so a release that changes the drain
  budget (openclaw-nix's stop-budget hotfix) protects only the stops after it. A cron
  turn the drain cuts closes its agent databases with `clean-close receipt:
  active-leases`, and the next start fails readiness with "database configuration
  changed during startup inspection". One clean restart with nothing running fixes it;
  no doctor. Before activating, list the cron jobs running or due in the next ten
  minutes: `nextRunAtMs` and `runningAtMs` in `cron_jobs.state_json` of each instance's
  `state/openclaw.sqlite`, opened read-only. Then activate after they finish.
- Agents that work on the host's repository land commits on main, often unpushed:
  rebase the candidate onto the newest local main just before activating, so a
  fast-forward-only activation refuses rather than dropping their commits.
- Exclusive databases: from 9.6 the first start on a new version runs a maintenance
  migration that needs every agent database to itself. An interactive `openclaw` CLI
  left open kept a gateway in a silent restart loop for 8 hours (`status=78/CONFIG`).
  Before activating, `pgrep -a openclaw` and close stray CLIs; after, check each unit's
  restart count and its log for "maintenance" or "database is in use".
- Nix mode: a fenced wrapper defaults `OPENCLAW_NIX_MODE` to 1. Doctor under Nix mode
  refuses ("config is immutable") and writes `.migration-failed-for-version`, after
  which the gateway refuses to start. Every writable-instance or doctor path sets
  `OPENCLAW_NIX_MODE=0` explicitly.
- A failed migration marker is a stop sign: read the newest
  `backups/pre-migrate-*/doctor.log` before removing it.
- After freeing disk space, a unit stuck in `start-limit-hit` needs
  `systemctl --user reset-failed <unit>` before `start`.
- Live-applied plugins: a gateway's `runtime-plugins/<set id>` and its rendered config
  belong to its start script. On 2026-10-19 an agent lane staged one plugin under the
  set id the next render would compute and pointed the live config at it; the next
  start skipped the copy, found the other plugins missing and hit `start-limit-hit`
  (prod down 6.4 min). The start script now uses a set only if its manifest
  (`.openclaw-nix-plugin-set.json`) names the exact plugin list and every plugin is
  there, and otherwise moves it to `.untrusted-plugin-set-<id>-<time>` (kept a week)
  with a WARN. A WARN like that after an activation means someone staged by hand:
  find who before the next one. Plugin changes go through Nix and an activation.

## Native Control UI

- Native plugin UI (manifest `controlUi`) loads only with Labs > Custom plugin UI
  (`gateway.controlUi.experimental.customPlugins`) for non-bundled plugins, and only
  from the Control UI the gateway itself serves over HTTPS or loopback.
- After a start, `gateway call plugins.controlUi.list` lists every native UI the gateway
  serves and its `diagnostics` (empty when healthy); `plugins.controlUi.status` shows
  each connected client's activations (`activated`). Both are read-only.
- The asset reader rejects symlinks and hard links. Nix store optimisation hard-links
  every identical store file, so a store-served build needs openclaw-nix's hotfix; a
  plugin materialized outside the store (link count 1) does not. Any other OpenClaw
  reader with `hardlinks: "reject"` will hit the same wall.
- A browser entry must be one plain module with no imports: the gateway serves the
  declared entry and styles as an immutable revision, nothing beside them.

## Hooks and skills

- Store-to-runtime syncs need `rsync --checksum`: store files all have mtime 0 and
  same-length store paths, so size and mtime skip changed files.
- Hook wrappers must import the running gateway's own bundled handlers; a wrapper left
  on an older release's handlers failed silently for 11 days on one host. After a start,
  check that the bundled hooks (boot-md, session-memory) ran without errors.
- Skill delivery to cloud workers carries two hotfixes (store hard links in skill trees,
  descriptions over 1,024 characters); re-check both against a candidate.

## Stray plugin installs

- A Nix-owned gateway loads plugins only from its bundled copies and Nix load paths, so
  OpenClaw's own install records (`plugins.installedIndex` in `state/openclaw.sqlite`)
  should be empty.
- Moving an install's directory aside does not uninstall it: the next start reinstalls
  the configured plugins from npm (copies that shadow the bundled build) and leaves
  `deferred-plugin-migration:<id>` rows in `migration_runs`, each printing "settings
  cannot be checked until its data/settings upgrade finishes" at every start.
- An npm copy links `node_modules/openclaw` to one gateway store path; the next gateway
  rebuild breaks that link (`missing-openclaw-peer-link`) and the plugin is unavailable.
- `update repair` treats the Nix package as an npm install and defers more rows;
  `doctor --fix` relinks peers but keeps the stale code. Uninstall each record with
  `--keep-files` against a throwaway config, quarantine the package directories, settle
  the rows, and verify (the host profile may carry a script for this).
- After every bump, each instance's `update status --json` has no `migrationWarnings`.
