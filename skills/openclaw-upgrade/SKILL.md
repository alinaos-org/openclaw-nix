---
name: openclaw-upgrade
description: "Upgrade OpenClaw on a host that builds it with openclaw-nix: review and merge openclaw-nix's release pull request, move the host's openclaw-nix input, build from the shared cache, qualify every gateway against copies of its state, activate, then verify versions, native Control UI and live model canaries. Read the host profile (references/host.md) first."
---

# OpenClaw upgrade

One procedure for every agent that moves a host to a new OpenClaw release. A release is
made in [openclaw-nix](https://github.com/alinaos-org/openclaw-nix): its `release-watch`
workflow opens a pull request for each stable release, and CI builds the gateway from
source with its hotfix layer, the customize layer and the pinned plugins, runs their
tests, and pushes the source build and its pnpm dependency set to the binary cache. A
host then moves its `openclaw-nix` input, builds only its own layers, qualifies,
activates and verifies.

**Read `references/host.md` first.** It is the host profile, installed with this skill
by `openclaw-nix.lib.mkUpgradeSkill { hostProfile = ...; }`: who may activate, the
instances and the package each one runs, the build, check and activation commands, the
canaries, and the host's own hazards and history. Its `scripts/host.env` gives the
generic scripts their host defaults. If there is no host profile, stop and write one
([host profile](references/host-profile.md)) before changing anything.

## Rules

- Preparing and qualifying a candidate needs no approval. Activation, any gateway
  restart, pushes and cloud changes need the approval the host profile names, given in
  the current conversation.
- An agent running inside a gateway never activates a change that restarts that
  gateway, and never restarts it: it prepares the candidate and hands over the window.
- Never run a candidate binary against live state (qualify on copies), never hand-edit a
  gateway's rendered config, and never delete state: move it to a dated quarantine.
- Change the build in openclaw-nix, not on the host. A host's own gateway changes are its
  customize layer (`replaceBundledChannels`, `extraCommands`) and native Control UI
  plugins. A source patch (`gatewayArgs`) makes the host compile its own gateway on every
  release and loses the cache.
- Improve this skill by commit: the generic procedure in openclaw-nix
  (`skills/openclaw-upgrade/`), host facts in the host profile. A runtime or workshop
  copy with the same name outranks the installed one and silently replaces it.

## Fast path: a routine stable release

1. **Release.** Review openclaw-nix's `release-<v>` pull request: the tag and release SHA,
   the changelog against every patch, the customize layer's anchors and the host's
   plugins ([releases](references/releases.md)), and what a
   [version sweep misses](references/lessons.md#what-a-version-sweep-misses). A patch
   whose code moved fails CI's build and is re-ported or dropped there. Merge once CI is
   green: the build is then in the cache.
2. **Decide** to take it now ([cadence](references/lessons.md#cadence)): a stable release
   with a reason, in the host's instance order, inside an approved restart window.
3. **Candidate.** In a fresh worktree off the host's main branch, `nix flake update
   openclaw-nix`. Check that the host's compile is still openclaw-nix's own: its
   derivation equals openclaw-nix's `.#gateway` (the host profile names the contract that
   asserts it). Otherwise the host compiles locally and the cache does not help.
4. **Build** the compile first with `scripts/fetch-or-compile.sh`: it compiles here when
   the release kept its pnpm dependency set (about 5 min, the same path as the cache's),
   and fetches otherwise. Then each instance's package with `scripts/build-capped.sh`
   (the copy layers build locally, about 1.5 min each), then
   `scripts/check-plugin-sdk-imports.py <package>` against the package the main gateway
   will run.
5. **Qualify** each instance on copies of its state, in parallel and never beside a
   source build: `scripts/qualify-candidate.sh <package>/bin/openclaw <instance>`
   ([qualifying on copies](references/lessons.md#qualifying-on-copies)). Then the host's
   contracts in small memory-capped batches.
6. **Activate** as the host profile says: commit, rebase onto the newest main, wait for
   running sessions, clear the [restart hazards](references/lessons.md#restart-hazards),
   activate, restart any keep-old instance, check every instance's version, run the
   canaries and the [native UI check](references/lessons.md#native-control-ui), and read
   each gateway's startup log.
7. **Record** the release, timings and anything that surprised you, and fold lessons into
   this skill or the host profile by commit.

## Procedure

Use this for the step that fails, a beta, a state schema migration or new plugins. Each
step ends with what must be true before the next.

0. **Decide.** Apply [cadence](references/lessons.md#cadence) and the host's instance
   order. Done when the target release, the reason, the order and the approved window
   are written down.
1. **Baseline.** Capture each gateway's health, readiness, agent list and a model
   canary; the live version and derivations; the worktree, pins and saved logs; and
   whether the request authorizes activation or only preparation (stop before
   activation if only preparation). Read how the host owns config (Nix only, or Nix plus
   preserved UI edits) before assuming every field is Nix's. Done when baseline, target,
   field ownership and authorization are explicit.
2. **Release source.** openclaw-nix's release table pins the commit the tag peels to,
   which must equal the release notes' release SHA; never a branch or tag. Done when the
   source is authenticated and its runtime requirements (Node, pnpm) fit.
3. **Patch layers.** Walk the changelog against the hotfix layer, the customize layer
   and every host plugin ([patch layer](references/releases.md#patch-layer)). Drop what
   upstream fixed, re-port what it moved, and extend a gate only after that patch's test
   passes on the candidate. Then check what a
   [version sweep misses](references/lessons.md#what-a-version-sweep-misses): new bundled
   plugins, overrides the release made obsolete, keys nix-openclaw's typed module does
   not know yet and separately versioned layers. Done when each patch is dropped or
   re-ported with its reason and each of those is checked.
4. **Rollback evidence.** Make sure the host's rollback (its profile) covers state as
   well as the closure: a newer release migrates databases, after which an old closure
   alone is no downgrade. Use [archive recovery](references/recovery.md#archive-recovery)
   when a backup stalls. Let it block activation, not qualification.
5. **Cheap checks first:** pin consistency, package metadata, focused contracts,
   formatting and the host's config-policy checks, before any long build. Reuse a cached
   output only after confirming it is the exact candidate
   ([unchanged cache recovery](references/recovery.md#unchanged-cache-recovery)).
6. **Instances.** List every declared instance, not only the main one, and decide for
   each whether it follows the release or stays frozen as a recovery pin. Done when each
   has a recorded follow-or-freeze decision.
7. **Builds.** Run heavy builds outside every gateway's cgroup and memory-capped
   ([builds](references/lessons.md#builds)), with full output in a persistent log and no
   client-side timeout. A system closure does not run every flake check: build the
   contracts too. Check plugin loading and registration as well as config validation:
   discovery or ownership warnings, SDK import failures and failed registrations fail
   the candidate even when validation exits 0. For a generated config with release
   transforms or staged plugins, see
   [runtime config qualification](references/recovery.md#runtime-config-qualification).
   If a gate fails, [triage](references/recovery.md#failing-gate-triage) before editing
   any expectation (one narrow repair cycle, 45 minutes).
8. **Qualify on copies** with `scripts/qualify-candidate.sh`, each instance against the
   exact package it will run. Read the doctor's proposed config changes
   ([doctor proposals](references/lessons.md#doctor-proposals)). Done when every gate
   exits 0 against the exact candidate commit.
9. **Activate.** Commit the validated candidate; require a clean worktree and a
   fast-forward onto main; compare what the activation restarts against the live
   generation; wait for running sessions; activate with the host's command. Treat an
   interruption or a success line alone as no evidence: read the service and system
   state. Done when the system profile is the candidate; gateway adoption is the next
   step.
10. **Startup.** For each gateway: unit state and restart count, the running package and
    version, and its real log sink (an empty journal proves nothing when output goes to
    a file). Wait for readiness, not just an active unit. Check the host's config
    preservation, hooks and skills, [stray plugin installs](references/lessons.md#stray-plugin-installs)
    and [native UI](references/lessons.md#native-control-ui).
11. **Versions.** Resolve every wrapper and running process to its package and version
    and compare with the follow-or-freeze decisions. A keep-old instance keeps its old
    process until restarted, and a fenced binary refuses to run without its own state
    directory; that refusal is the fence working.
12. **Canaries.** Agent list and a known-good model call on every upgraded gateway, plus
    one per newly enabled model (a catalog entry proves no entitlement). If a call
    reports a migration or ownership error, use
    [startup admission recovery](references/recovery.md#startup-admission-recovery).
    Compare readiness, event loop and warnings with the baseline and report residual
    failures separately rather than claiming clean health.
13. **Record** commits, generation, logs, timings, canary results, rollback artifact and
    every frozen pin with its reason, in the host's notes; fold new lessons in by commit.
    Done when a later agent can reconstruct the release without the conversation.
