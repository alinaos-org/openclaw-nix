# openclaw-nix

Current [OpenClaw](https://github.com/openclaw/openclaw) releases on Nix, built from
source, with every OpenClaw package (gateway, CLI, runtime plugins) from the same
release.

It builds on [nix-openclaw](https://github.com/openclaw/nix-openclaw)'s source recipe,
CLI tool bundle and runtime-plugin builder, and adds:

- **The current stable release** (`release.nix`, `releases.nix`), pinned to the exact
  commit the release tag peels to, plus every runtime plugin OpenClaw's catalogs list,
  locked at the same release (`pins/runtime-plugin-locks`, generated per release) and
  the few outside the catalogs (`pins/runtime-plugins.json`). Evaluation fails while the
  lock set is for another release, so no plugin falls behind the gateway.
- **One release everywhere.** The overlay's gateway, its CLI bundle and every pinned
  plugin (whose `openclaw/plugin-sdk` peer links that gateway) derive from one build;
  `checkSingleRelease` fails a closure that carries any other OpenClaw release.
- **Nix-layout repairs** in the source build (`packages/gateway`): host-only pnpm
  fetch, per-plugin dependency trees, the `openclaw` self-reference, CJS plugin
  entries, managed Codex app-server links, procps and esbuild shutdown fixes for the
  asset build. Each fails the build if a release moves the code it repairs.
- **A hotfix layer** (`packages/hotfix`) for upstream bugs not yet fixed in a release,
  each patch anchored to the exact code it replaces, tested in the build and listed in
  its [register](packages/hotfix/register.nix) (see "Hotfix layer" below).
- **A state fence** (`packages/state-fence.nix`): an entrypoint that refuses implicit
  or protected state directories, so a candidate or recovery binary run by hand
  cannot migrate production state. It wraps a finished tree, so several fenced
  gateways share one build.

## Use

```nix
{
  # A release tag (see "Versions and support"); `main` moves with every merge.
  inputs.openclaw-nix.url = "github:alinaos-org/openclaw-nix/2026.10.3-r1";

  outputs = {nixpkgs, openclaw-nix, ...}: {
    nixosConfigurations.host = nixpkgs.lib.nixosSystem {
      modules = [
        {nixpkgs.overlays = [openclaw-nix.overlays.default];}
        # pkgs.openclaw-gateway, pkgs.openclaw, pkgs.openclawRuntimePlugins.<id>
      ];
    };
  };
}
```

`openclaw-nix.lib.mkOverlay { ... }` customises the package set;
`lib.mkPackageSetOverlay` takes the same arguments without nix-openclaw's overlay, for
consumers that already apply it.

| Argument | Effect |
|---|---|
| `sharedBuild` | Use this flake's own source build, from its own locked nixpkgs: the build CI publishes to the cache. Do not make this flake's `nixpkgs` input follow yours, or the build is yours again. |
| `customize` | Changes applied to a copy of the finished tree (`packages/custom`), so the source build stays shared: `replaceBundledChannels` and `extraCommands`, below. |
| `gatewayArgs` | Changes to the source build itself (below); the build is then the consumer's own. Not combinable with `sharedBuild`. |
| `excludeToolNames` | Tools to drop from nix-openclaw's CLI tool bundle. |

`customize`:

| Argument | Effect |
|---|---|
| `replaceBundledChannels` | Channel ids an external plugin with the same id replaces: the bundled plugin trees are removed and their entries dropped from the bundled channel config metadata, so config validation, aliases and discovery defer to the external plugin's schema. Fails when the release no longer bundles the channel. |
| `extraCommands` | Shell run last on the copy, with `$out`, `$root` (`$out/lib/openclaw`) and `$node` set. |

`gatewayArgs`:

| Argument | Effect |
|---|---|
| `extraSourcePatches` | Source patches (paths, or `{name, patch}`) applied before pnpm, `-p1`, zero fuzz. Their digest is part of the Control UI build identity. |
| `extraTests` | Upstream vitest files run before pruning. |
| `extraInstallCommands` | Shell at the end of the install phase (`$out`, `$node`). |
| `localRevision` | Version suffix, `<release>-nix.N`. |

Control UI changes need neither: OpenClaw's native Control UI plugins (manifest
`controlUi`, enabled by `gateway.controlUi.experimental.customPlugins`) add session
actions, pages, panels and replacements without rebuilding the UI.

Builders under `pkgs.openclawNix`:

```nix
pkgs.openclawNix.customize {                          # a customize layer
  gateway = pkgs.openclawNix.compiledGateway;
  replaceBundledChannels = ["chat"];
}
pkgs.openclawNix.hotfix pkgs.openclaw-gateway        # the hotfix layer
pkgs.openclawNix.stateFence {                         # a fenced entrypoint
  gateway = pkgs.openclawNix.hotfix pkgs.openclaw-gateway;
  hostname = "myhost";
  stateDir = "/srv/openclaw";
  protectedStateDirs = ["/srv/openclaw"];
}
pkgs.openclawNix.checkSingleRelease { roots = [config.system.build.toplevel]; }
```

## Workstations: several gateways for one desktop user

`nixosModules.workstation` runs gateways as systemd **user** units of one desktop user,
over nix-openclaw's Home Manager module. That suits a workstation, where agents use the
user's own tools, logins and project checkouts. It is the module nova (alinaos) runs, so
another machine can reproduce that setup by declaring its instances:

```nix
{
  imports = [
    home-manager.nixosModules.home-manager
    openclaw-nix.nixosModules.workstation
  ];

  services.openclaw.workstation = {
    user = "alice";
    sharedEnvironmentFile = config.sops.secrets.openclaw_env.path; # VAR=value lines
    interactiveInstance = "main";
    instances.main = {
      configFile = ./openclaw.json; # the instance's config; agents, models, channels
      gatewayPort = 18789;
      uiOverlay.enable = true; # the Control UI may save, within its policy
    };
  };
}
```

Per instance:

- **Unit and state.** It gets `openclaw-gateway-<name>.service` and
  `~/.openclaw-<name>`. Its read-only `stateDir`, `unitName` and config paths are for
  other modules to read.
- **Packages.** It runs the release's gateway, optionally a hotfix or customized one,
  with the host's `bundledRuntimePlugins` copied into the trusted tree and the state
  fence.
- **Config.** The Nix config is rendered and, with `runtimeConfigJqFilter`, prepared at
  each start by the same prepare step as the other modules: Control UI overlay,
  migration snapshot, plugin copies.
- **Secrets.** These come from the shared env file, minus `unsetEnvironment`, or from a
  per-instance `environmentFile`. The gateway password comes from a file or is derived
  from the shared token.
- **Unit tuning.** `memoryHigh`/`memoryMax`, `stopTimeout`,
  `inaccessiblePaths`/`readOnlyPaths`, `keepRunningOnActivation` (keep-old) and a
  strict-Nix `declarativeTwin`.
- **CLIs.** It gets `oc-<name>`, `openclaw-overlay-<name>` and
  `openclaw-<name>-mode`.
- **Rollback.** `openclaw-<name>-restore` rolls the state back, as in "Upgrade and
  rollback" below. Use `systemctl --user stop`, then the target generation's restore
  command, then switch to that generation.
- **Canary.** `canary.enable` runs a weekly agent turn through `oc-<name>` and writes
  `<stateDir>/hooks-state/canary.json` for a health check. The instance needs a
  password, because `oc-<name>` clears the shared token.

For the host, beside the instances:

- **Workspace files.** `agentFiles.workspaces.<name> = {workspace; files;}` copies each
  agent's `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md` and `HEARTBEAT.md` (and
  optionally `BOOT.md`) from the repository into its workspace at activation. They
  are single-link copies, because the gateway refuses store files. A retired
  `TOOLS.md` moves to a dated quarantine, and `openclaw-agent-files-audit` reports
  drift. Once every workspace has its full set, `skipBootstrap = true` stops the
  gateway from seeding its own.
- **Heartbeat checklists.** Since 9.x a heartbeat reads its cron job's scratch, not
  `HEARTBEAT.md`. With `heartbeatChecklists.enable`, a user unit writes each ticking
  heartbeat's Nix `HEARTBEAT.md` into its scratch after every gateway start. A
  replaced scratch is kept under `~/.local/share/openclaw/retired-heartbeat-scratch`.
  `heartbeatChecklists.tool`'s `check <instance>` prints drift for a health report.
- **Nightly UI sync.** With `uiSync = {enable; repo; sourceFile;}`, each `uiOverlay`
  instance's Control UI edits become a commit on the branch `<name>-ui-sync` of the
  host's checkout every night. It never pushes, merges or activates. Merge the branch,
  and the overlay entries prune themselves at the next start. `schedule`, `renames`
  and `exclude` tune it.

`checks.workstation` boots a VM and checks:
- a user's gateway, running as that user's unit and started at boot;
- secrets from the shared env file, kept out of the configs;
- a native Control UI plugin (session-icons), served from state;
- an agent turn against a stub model provider;
- the restore command;
- the workspace files and the retirement of `TOOLS.md`;
- the heartbeat checklist sync;
- a Control UI edit folded into a commit.

`lib.mkWorkstationModule {optionPath = [...];}` puts the options at another path, for a
host that keeps its own namespace.

A new machine can start from the template, which includes a host flake, the gateway
declarations and an instance config:

```sh
nix flake init -t github:alinaos-org/openclaw-nix#workstation
```

## Servers: the NixOS module

`nixosModules.openclaw` runs each gateway as a system service, which is what a server
wants; `nixosModules.workstation` (above) suits a workstation where gateways belong to a
desktop user.

```nix
{
  imports = [openclaw-nix.nixosModules.openclaw];

  services.openclaw.instances.main = {
    port = 18789;
    credentials.OPENCLAW_GATEWAY_TOKEN = "/run/secrets/openclaw-gateway-token";
    settings = {
      gateway = {
        mode = "local";
        port = 18789;
        bind = "loopback";
        auth = {mode = "token"; token = "$OPENCLAW_GATEWAY_TOKEN";};
      };
      agents.defaults.workspace = "/var/lib/openclaw/main/workspace";
    };
    configOverlay.enable = true; # the Control UI may save, within its policy
  };
}
```

Each instance is `openclaw-<name>.service`:

- its own system user and group (`openclaw-<name>`), state in `/var/lib/openclaw/<name>`
  (mode 0700), and OpenClaw's file logs in `/var/log/openclaw/<name>`, removed after
  `logRetention` (30 days); console output goes to the journal;
- secrets as `credentials`: files loaded with systemd's `LoadCredential` and exported only
  inside the service's own wrappers, so they appear in neither the unit, the store nor the
  rendered config, which references them as `"$NAME"`;
- the same prepare step as the Home Manager module: validation with a fallback to the
  pure Nix render, doctor on copies after a package change, and the optional Control UI
  overlay;
- `hardening` on by default: read-only system, no home directories, private `/tmp` and
  devices, no capabilities, a system-call filter. `systemd-analyze security` rates the
  unit 1.4 (the module's VM test fails above 3.0); override single settings with
  `serviceConfig` rather than turning it off;
- the gateway's own stop semantics: it drains active work for up to about five minutes
  before it exits (`KillMode=mixed`, `TimeoutStopSec=360s`);
- `sessionIcons.enable` (deprecated, see [Session icons](#session-icons)) for the
  session-icons plugin, copied into the state directory before it loads
  (`materializePlugins`).

The port stays closed unless `openFirewall` is set: terminate TLS and authenticate users
in a reverse proxy on the same host.

### Upgrade and rollback

A new package's first start snapshots the state, then migrates it: the gateway
stops, `backups/pre-migrate-<time>/state-snapshot.tgz` takes OpenClaw's databases and
JSON files (recording the versions it came from and goes to), and the new doctor
migrates the state in place. If doctor fails, the start is refused, and the state
and its snapshot are kept. Rolling the closure back alone is therefore no downgrade:
the old package would meet migrated databases. Roll the state back with it:

1. `systemctl stop openclaw-<name>`. It drains active work first, for up to about six
   minutes.
2. Run the restore command **from the generation you are rolling back to**:

   ```sh
   gen=/nix/var/nix/profiles/system-41-link   # the generation before the upgrade
   $gen/sw/bin/openclaw-<name>-restore list
   $gen/sw/bin/openclaw-<name>-restore restore latest
   ```

   Its package must be the one the snapshot was taken from. The current
   generation's command refuses, because its package is the newer one. It moves the
   files the snapshot covers aside into `backups/restore-<time>/replaced/`, unpacks
   the snapshot, and marks the state migrated for that package, so the old version
   does not migrate it again. It deletes nothing and starts nothing.
3. Switch to that generation (`$gen/bin/switch-to-configuration switch`, or
   `nixos-rebuild switch --rollback` when it is the previous one). That starts the
   gateway on the restored state.

What a rollback costs:

- **Recovery point:** the moment the upgrade started, for the databases and JSON
  (sessions, agent state, Control UI edits). Their post-upgrade versions stay in
  `backups/restore-<time>/replaced/`. Other files are left as they are: media, a
  runtime's own home (Codex's, for example) and workspaces.
- **Recovery time:** the stop's drain, the unpack and a start. A busy personal
  gateway's state is about 3.6 GiB in 7,600 files, a 1.5 GB snapshot that unpacks in a
  minute or two.
- **Rehearsal:** `checks.nixos-module` runs these exact steps on every pull request.
  It upgrades to a package that reports a newer version, adds a session, rolls back,
  and checks that the session is gone and the pre-upgrade one is back. Rehearse on a
  staging host with production-sized state before relying on it.

Snapshots are not pruned. Each one is about the state's compressed size, so move
old ones off the host once a release has been accepted.

`checks.nixos-module` boots a VM with one instance and checks it end to end:
- its own user, state and logs;
- credentials absent from the unit and the configs;
- the hardening score;
- one agent turn against a stub OpenAI-compatible provider, whose API key arrives only
  through the instance's credential;
- a native Control UI plugin (session-icons) served from the state directory;
- a Control UI edit surviving a restart;
- the rollback above.

CI runs it on every pull request.

## Control UI over a Nix config

nix-openclaw renders an instance's config and runs the gateway in Nix mode, where every
config write throws: the Control UI cannot save models, sign-in, heartbeats or thinking
levels. `homeManagerModules.configOverlay` (with nix-openclaw's Home Manager module)
keeps Nix authoritative and lets the Control UI save:

```nix
programs.openclaw.instances.prod.configOverlay = {
  enable = true;
  # policy = ./my-policy.json;   # allow/deny path patterns; the default is conservative
  sync = {                        # optional: a nightly review branch of the UI's changes
    enable = true;
    repo = "/home/me/config";
    worktree = "/home/me/config-prod-ui-sync";
    sourceFile = "openclaw/prod.json";
  };
};
```

The gateway runs from a writable `openclaw-runtime.json`. Before every start, the
overlay engine keeps the Control UI's changes to paths the policy allows
(`config-overlay.json`), reports the rest as drift (`config-drift.json`) and renders the
new Nix config with the overlay on top, falling back to the pure Nix render if the
result is invalid; an entry the Nix source later adopts prunes itself. On a new package
version it runs the new doctor once against disposable copies and writes its proposals
to `upgrade-config-drift.json` for the Nix source. `openclaw-overlay-<name>` lists,
drops or promotes entries (`promote` prints a merge patch for the source). The builders
(`pkgs.openclawNix.configOverlay` or `lib.mkConfigOverlay pkgs`: `cli`,
`prepareConfig`, `sync`) serve hosts that wire their own units.

## Session icons

The gateway build changes one Control UI surface
(`packages/gateway/patches/session-icon-picker.patch`): a session's **Icon & color**
picker offers every emoji through Emoji 16.0 (about 1,900, by category, with search and
recent choices first) and, under **Icons**, the six built-in glyphs and this repository's
library of 72 bold icons in nine groups (aerospace and simulation, AI, code, home lab,
security, business, finance, creative, life). A choice is saved as before, an emoji, a
glyph id or an SVG data URL in the session's `icon`, so every client shows it, and icons
saved by the earlier session-icons plugin still show as selected.

`scripts/generate-session-emoji.mjs` generates the emoji catalog from Unicode's
`emoji-test.txt`; run it with the gateway's Node, so it lists only emoji the gateway
accepts as an icon, then re-create the patch. The patch carries its own tests (the
picker's, the session menu's), which the build runs; a release that moves the picker's
code fails `patch` there, and the patch is re-ported.

The session-icons plugin (`runtimePlugins = ["session-icons"]`, the NixOS module's
`sessionIcons.enable`) is deprecated: its Custom icons… dialog duplicates the picker. It
goes after the 2026.11 releases.

## Upgrade skill

`skills/openclaw-upgrade` is the agent procedure for upgrading a host: review and merge
the release pull request, move the host's `openclaw-nix` input, build, qualify each
gateway against copies of its state, activate, and verify. A host installs it with its
own profile (who approves, its instances, commands, canaries and history):

```nix
skill = openclaw-nix.lib.mkUpgradeSkill {
  inherit pkgs;
  hostProfile = ./openclaw-upgrade-host; # references/host.md, scripts/host.env, ...
};
```

then copies `skill` to wherever its agents load skills. See
`skills/openclaw-upgrade/references/host-profile.md` for what a profile holds.

## Releases

`scripts/new-release.py <version>` adds a release (tag, release-SHA cross-check, source
and pnpm hashes), `scripts/generate-plugin-locks.sh <version>` locks every catalog
plugin at it (nix-openclaw's generator, at the pinned nix-openclaw, against the release's
source) and `scripts/pin-runtime-plugins.py <version>` re-pins the few outside the
catalogs. The `release-watch` workflow runs all three daily and opens a pull request
when OpenClaw publishes a new stable release; CI builds and tests it there, every plugin
included (`.#runtime-plugins`). It needs "Allow GitHub Actions to create and approve
pull requests" enabled for the organization and the repository. The `plugin-locks`
workflow regenerates the lock set on any branch. Plugins are built by nix-openclaw's
builder (`nix/lib/openclaw-runtime-plugin.nix`), called with this flake's lock set and
with only nix-openclaw's `nix/scripts` as its scripts, so a nix-openclaw change elsewhere
never rebuilds a plugin.

When a hotfix patch fails on a new release, upstream either fixed the bug (drop the
patch and its test) or moved the code (re-port its anchors). The same goes for this
repository's own source patches (`packages/gateway/patches`), which fail `patch -F0`.

### Hotfix layer

Patching upstream's build output is a last resort, for a bug that breaks a supported
deployment, and every patch is a security-review item. Each one:

- checks the exact code it replaces, found exactly once, so a release that moves or
  fixes that code fails the build instead of shipping a half-applied patch;
- has a test that exercises the patched code in the build;
- is listed in `packages/hotfix/register.nix`: what it fixes, the first release it is
  qualified for, its test (or why there is none), its upstream report and the
  condition for removing it;
- is reported upstream, and removed once upstream's fix ships in a pinned release.

`checks.hotfix-register` fails evaluation when a patch or test file is unregistered,
an entry lacks a test reason, an upstream status or a removal condition, or the
package's advertised markers (`passthru.hotfixes`) differ from the register. The
register is also `passthru.hotfixRegister`. As of 2026.10.3 there are seven patches,
none reported upstream yet, and one (the Codex stale-registration edit inside
`patch-mcp-close-rejection.mjs`) without a test.

Changes reach `main` only through pull requests whose `eval` and `build` checks pass on
a branch up to date with `main`, with a code owner's review (`.github/CODEOWNERS`).
Repository administrators may merge their own pull requests without that review, but
no one pushes to `main` directly. Release pull requests from `release-watch` always
need a code owner's approval.

## Versions and support

Pin a release tag rather than `main`. A tag is `<OpenClaw release>-r<N>`:

- `r1` is cut automatically when a release pull request moves `release.nix`'s
  `current` (the `tag-release` workflow), and later `r<N>` by hand for an openclaw-nix
  fix on the same OpenClaw release. Each GitHub release names the OpenClaw release, the
  gateway store path and what changed since the previous tag.
- The gateway package's own revision (`openclaw-gateway-<release>-nix.<N>`) changes only
  when the gateway build does, so a fix release that leaves the gateway alone keeps its
  store path and its cached build.

What is supported:

- **The latest tag.** Fixes land on `main` and in the next tag only; there are no
  backport branches.
- **One release behind, for recovery.** `release.nix`'s `accepted` keeps the previous
  OpenClaw release buildable, so a host can keep one instance a release behind (see the
  upgrade skill's cadence).
- **Stable OpenClaw releases only.** No betas, and no release published before its tag
  peels to the release notes' release SHA.
- **Interfaces** (`lib`, `overlays`, module options, `homeManagerModules`): a breaking
  change is named in the release notes, and a renamed option keeps working, with a
  warning, for at least one OpenClaw release line (about a month).

## CI and cache

`ci` evaluates every output, then builds the gateway, the hotfix layer, the CLI and the
plugins and runs the checks; on the free 4-core runner a release builds in about 11
minutes. With the repository variable `CACHIX_CACHE` and the secret
`CACHIX_AUTH_TOKEN` set, it pushes the source build and its pnpm dependency set to that
Cachix cache, from release pull requests too, so a release is cached before it is
merged. A consumer that adds the cache as a substituter and sets `sharedBuild`
downloads the gateway instead of compiling it. The dependency set's store path depends
on its hash alone, so even a consumer with its own `gatewayArgs` fetches that from the
cache instead of the npm registry. `BUILD_RUNNER` selects a larger runner (the source
build peaks around 15 GB).

The public cache is `alinaos-openclaw-nix`:

```nix
nix.settings = {
  extra-substituters = ["https://alinaos-openclaw-nix.cachix.org"];
  extra-trusted-public-keys = ["alinaos-openclaw-nix.cachix.org-1:vLkWgaUe6XR3H+bIMF6QvMvxbrZJLFL9WyaVyrRD8Jo="];
};
```

## Supply chain

- **Workflows** pin every action by commit SHA; Dependabot proposes updates weekly.
- **Each release** carries, from `release-evidence` (`scripts/release-evidence.sh`):
  SBOMs of the gateway's npm dependency tree and of its Nix runtime closure (CycloneDX
  and SPDX), grype's vulnerability matches for both with a summary
  (`vulnerabilities.md`), and `store-paths.json`, the cached store paths with their NAR
  hashes. The manifest and the SBOMs have a GitHub build-provenance attestation. The
  scan reports; it does not block a release.
- **Verify** a release before trusting the cache:

  ```sh
  gh release download 2026.10.3-r1 --repo alinaos-org/openclaw-nix -p store-paths.json
  gh attestation verify store-paths.json --repo alinaos-org/openclaw-nix
  # after substituting, each path's NAR hash must match the manifest's
  nix path-info --json --json-format 1 <path> | jq -r '.[].narHash'
  ```

- **Reproducibility:** `reproducibility` rebuilds the gateway weekly with
  `nix build --rebuild` and fails if the output differs from the cached one, listing
  the files that differ. It always publishes the cached build's per-file hashes
  (`scripts/file-hashes.sh`), so a host that compiled its own can compare. **The
  gateway was not reproducible** through `2026.10.3-nix.1`:
  - nix-openclaw linked three undeclared dependencies (`strip-ansi`, `combined-stream`,
    `hasown`) to whichever copy `find` listed first. `strip-ansi` resolved to 7.2.0 in
    one build and 6.0.1 in another.
  - pnpm's install timestamps (`prunedAt`, `lastValidatedTimestamp`) and a leftover
    Vitest cache varied.
  - The native Control UI's chunk hashes differed between two CI builds.
  
  `nix.2` fixes the first two: it links each of those dependencies to its highest
  version, records the release's build time in pnpm's metadata, and drops the cache.
  CI then rebuilt `nix.2` bit for bit. The Control UI difference was intermittent, so
  the weekly check is what shows whether it is gone. When it fails, it keeps both
  copies of the differing files.
- **Without this cache:** every source is a fixed-output fetch, so leaving the
  substituter out builds everything locally: the pnpm dependency set from the npm
  registry, then the compile (about 5 minutes on 8 cores, peaking around 15 GB).
- **A private cache**, signed with your own key, so no host trusts
  `alinaos-openclaw-nix.cachix.org`: build (or substitute and verify) the release on a
  builder, then copy it into your cache. With an S3 bucket:

  ```sh
  nix key generate-secret --key-name cache.example.com-1 > cache.secret
  nix key convert-secret-to-public < cache.secret > cache.public
  nix build github:alinaos-org/openclaw-nix/2026.10.3-r1#gateway --option substitute false
  nix copy --to "s3://example-nix-cache?region=eu-west-1&secret-key=$PWD/cache.secret" ./result
  ```

  Hosts then list only `s3://example-nix-cache?region=eu-west-1` in `substituters` and
  the contents of `cache.public` in `trusted-public-keys`. [Attic](https://github.com/zhaofengli/attic)
  works the same way for a self-hosted cache.

## Security

Report a vulnerability privately, as [SECURITY.md](SECURITY.md) describes, not in a
public issue. It also sets out what is in scope here and what belongs to OpenClaw or
nix-openclaw.

## License

openclaw-nix's own files are MIT (`LICENSE`). OpenClaw itself is MIT. Several outputs
are built with [nix-openclaw](https://github.com/alinaos-org/nix-openclaw) (our fork of
[upstream's](https://github.com/openclaw/nix-openclaw)), which is
AGPL-3.0 with no additional permissions, so an organization with an AGPL policy should
review this before deploying. The parts that come from nix-openclaw, as of this
release:

| openclaw-nix output | nix-openclaw part | How it is used |
|---|---|---|
| `gateway` (and every layer over it) | `nix/gateway-recipe/packages/openclaw-gateway-source.nix` and the files it reads | the source recipe, called and overridden |
| `gateway` | `nix/gateway-recipe/scripts/gateway-build.sh`, `gateway-prebuild.sh` | copied into the build and edited (`packages/gateway`) |
| `runtime-plugins`, `pkgs.openclawRuntimePlugins` | `nix/lib/openclaw-runtime-plugin.nix`, `nix/scripts` | the plugin builder, called with this flake's lock set, and the lock generator |
| `overlays.default` | `overlays.default` | applied first, for the CLI tool bundle |
| `homeManagerModules.configOverlay` | `homeManagerModules.openclaw` | extends its `programs.openclaw.instances` options |

These are build recipes and configuration modules. None of nix-openclaw's code runs
inside the gateway, and none is served over a network. `NOTICE` lists the components
and their licenses. Removing the dependency means replacing each row with an
openclaw-nix implementation written from OpenClaw's own build. That is tracked as
future work, and the server module (`nixosModules.openclaw`) already needs none of it
beyond the packages.
