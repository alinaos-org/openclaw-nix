# Releases in openclaw-nix

## The release pull request

The `release-watch` workflow runs daily (06:17 UTC); dispatch it by hand to pick up a
release the same day (2026.10.4). When OpenClaw publishes a stable release newer than
`release.nix`'s `current`, it runs:

- `scripts/new-release.py <v>`: tag to the commit it peels to, which must equal the
  release notes' "release SHA"; the source hash; the pnpm bootstrap version; the pnpm
  dependency hash (from `.#gateway.pnpmDeps`); the `releases.nix` entry and
  `release.nix`.
- `scripts/generate-plugin-locks.sh <v>`: every runtime plugin OpenClaw's catalogs list,
  locked at the same release, into `pins/runtime-plugin-locks` (`report.json` says which
  were skipped and why). Evaluation fails while the set is for another release.
- `scripts/pin-runtime-plugins.py <v>`: the few plugins outside the catalogs
  (`pins/runtime-plugins.json`), at the same release. Exit 2 means a plugin's
  dependencies changed: check its lock shape (`overlay.nix`, `manualLocks`).

It pushes `release-<v>`, opens a pull request and dispatches CI on it. To do it by hand,
run the same three scripts in a clone (the lock generation takes hours on a slow link;
the `plugin-locks` workflow runs it on a branch instead).

Opening the pull request needs "Allow GitHub Actions to create and approve pull requests"
(Settings, Actions, General: the organization first, then the repository). Without it the
workflow fails after pushing the branch, and the CI dispatch after that never runs; open
the pull request by hand and CI starts on it (2026.10.3). While a release pull request
stays open, each run rebases its branch onto a moved `main` and reruns CI, as long as
the branch holds only the watcher's own commit; anything else it leaves for a person.

`main` takes a pull request once `eval`, `build` and `nixos-module` pass on a branch up
to date with it. The code-owner ruleset is disabled until there is a second
maintainer, so arm auto-merge with a rebase and the pull request lands when CI is
green. GitHub refuses to arm one that is already mergeable; merge that one directly.
Merging tags `<release>-r1` (the `tag-release` workflow). A later openclaw-nix fix on the same release is tagged
`-r2` and up by dispatching that workflow. Hosts that pin tags move to the new tag
instead of running `nix flake update`.

Release-specific values are data, not gates: the `releases.nix` entry
(`pnpmBootstrapVersion`, `tsdownHeapMb`, `buildTimestamp`) and the plugin locks.

## CI and the cache

- `eval` evaluates every package and check with `nix eval` of their `drvPath`s. Not
  `nix flake check --no-build`: it evaluates read-only, so a source copy the CLI tool
  bundle needs is never added to a fresh store and evaluation fails.
- `build` builds the gateway, the hotfix layer, the CLI bundle and the plugins, then the
  `single-release`, `state-fence` and `customize` checks, and pushes the source build and
  its pnpm dependency set to the Cachix cache (`CACHIX_CACHE`, `CACHIX_AUTH_TOKEN`), from
  release pull requests too. On the free 4-core runner a release builds in 11 to 14
  minutes, most of it the 6-minute source build. Nix is pinned to the version consumers
  build with, so derivations match.
- A consumer gets the cached compile only with `sharedBuild = true`, no `gatewayArgs`,
  and this flake's `nixpkgs` not followed (its `nix-openclaw` may follow this flake's).
  After removing a `follows`, run `nix flake update openclaw-nix`: a plain relock
  resolved a fresh nixpkgs instead of this flake's locked one. The pnpm dependency set is
  a fixed-output path, so every consumer reuses it, even one compiling its own gateway.
- Merge the release pull request any way (merge, squash or rebase): the gateway's store
  path follows the source content, not the commit, so the build CI pushed stays valid
  (2026.10.3: a rebase merge kept the path).
- The cached compile is a large download (2026.10.3: 880 MB compressed, 2.9 GB unpacked).
  On a slow link with the pnpm set already local (the release kept its hash), compiling
  is faster: about 5 minutes on 8 cores, and the same store path.
  `scripts/fetch-or-compile.sh` makes that choice before the consumer's closure: it
  compiles with substitution off only when nothing but the source and the compile is
  missing, and fetches otherwise.
- `checkSingleRelease` matches OpenClaw's own package names, including layered ones
  (`openclaw-gateway-custom-fenced-<release>`), and fails a closure carrying any other
  release.

## Patch layer

The gateway is built from source at an immutable revision. Three kinds of change sit on
it, each failing the build when a release moves the code it changes:

- **Build repairs** (`packages/gateway`): Nix-layout fixes in the source build, such as
  the host-only pnpm fetch, per-plugin dependency trees, the `openclaw` self-reference,
  CJS entries as regular files, managed Codex app-server links, procps and the esbuild
  shutdown fix, plugin assets copied before the runtime overlay is staged, and bundled
  Control UI builds materialized in `dist-runtime`.
- **Hotfixes** (`packages/hotfix/patch-*.mjs`, most with a `test-*.mjs` run in the
  build): edits to the built, minified `dist/` for upstream bugs not yet fixed. `dist/`
  file names are content-hashed (`targets-D2B3dd7O.mjs`), so each release moves the code
  they target. Each patch checks the exact text it replaces, found exactly once, in the
  chunk it expects; worker copies are found by content, and sandboxed checks take
  minified helper names from the call shape. Gates read "from release X on" (`atLeast`),
  so a new release needs no version edit and inherits every patch.
- **The consumer's customize layer** (`packages/custom`): `replaceBundledChannels` fails
  when the release stops bundling a replaced channel; `extraCommands` carry their own
  anchor checks (for example a plugin SDK export patch).

Per release, read the changelog against each patch, each host plugin and anything on the
host that speaks the gateway protocol (a route allowlist, for example). When a patch
fails, decide from the changelog and the new code whether upstream fixed the bug (drop
the patch, its test and its gate) or moved it (re-port the anchors).

Auditing a point release: GitHub's compare view stops at 300 files, so diff the sources:
`diff -rq <old>/src <new>/src`, each from `nix eval --raw .#gateway.passthru.upstreamSource`
at the old and new openclaw-nix commit, then grep each patch's anchor symbol in the
changed files.

When the hotfix layer fails, the base package is already built. `scripts/scratch-patch-chain.sh`
evaluates the layer's own `installPhase` and runs it on a scratch copy of that base
(about a minute), reporting every failing patch at once where each Nix rebuild stops at
the first. Start each retry from a fresh copy: a patch that fails part-way leaves its
edit behind, and the next run fails with "already patched" or a phantom "anchor changed".
Afterwards, `scripts/check-plugin-sdk-imports.py <patched package>` checks every host
plugin's `openclaw/plugin-sdk/*` imports against the candidate's built exports; a missing
one would only show at gateway start.

## Release notes

- 2026.10.1, the first stable of the October line (3,055 commits), needed four patches,
  an SDK bridge and one plugin re-ported (25 minutes):
  - The plugin SDK dropped eight subpaths the changelog still called "removal-pending"
    (`infra-runtime`, `config-runtime`, `channel-lifecycle`, `channel-message`,
    `channel-reply-pipeline`, `command-auth`, `discord`, `telegram-account`). Code using
    the trusted diagnostic listener moved to `diagnostic-runtime`.
  - The cloud-worker bundle was split: `dist/worker/worker.mjs` is a stub, the code is
    in `worker/sqlite-store.worker.mjs` (50 MB) and about 5,000 `worker-chunk-*.mjs`,
    some with minified imported helpers.
  - `package-update-activation-recovery.mjs` no longer carries second copies of the
    skill delivery and node enrollment code, and the node bootstrap packer moved into
    `dist/gateway/worker-environments/node-bootstrap-artifact.worker.js`.
  - patch-media-owner had been a no-op since 9.9 and was dropped.
- 2026.10.2 (85 PRs) dropped nothing: none of the six dist patches' source files
  changed, and all six applied unchanged.
- 2026.10.2, later the same day: bundled native Control UI (workboard, slack, discord)
  had never loaded ("Control UI assets could not be loaded" in `plugins.controlUi.list`).
  The build copied plugin assets after the `dist-runtime` overlay was staged, the
  overlay stages links (the asset reader skips links), and the reader rejects hard
  links, which Nix store optimisation creates for every identical file. Fixed by two
  build repairs and the seventh hotfix, `patch-control-ui-store-hardlinks.mjs`.
