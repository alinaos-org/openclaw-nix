# openclaw-nix

Current [OpenClaw](https://github.com/openclaw/openclaw) releases on Nix, built from
source, with every OpenClaw package (gateway, CLI, runtime plugins) from the same
release.

It builds on [nix-openclaw](https://github.com/openclaw/nix-openclaw)'s source recipe,
CLI tool bundle and runtime-plugin builder, and adds:

- **The current stable release** (`release.nix`, `releases.nix`), pinned to the exact
  commit the release tag peels to, plus the npm runtime plugins pinned to the same
  release (`pins/runtime-plugins.json`).
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

## Servers: the NixOS module

`nixosModules.openclaw` runs each gateway as a system service, which is what a server
wants; the Home Manager modules suit a workstation where gateways belong to a desktop
user.

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
- `sessionIcons.enable` for the session menu's Icon library
  ([`packages/openclaw-session-icons`](packages/openclaw-session-icons/README.md)),
  copied into the state directory before it loads (`materializePlugins`).

The port stays closed unless `openFirewall` is set: terminate TLS and authenticate users
in a reverse proxy on the same host.

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
and pnpm hashes) and `scripts/pin-runtime-plugins.py <version>` re-pins the plugins.
The `release-watch` workflow runs both daily and opens a pull request when OpenClaw
publishes a new stable release; CI builds and tests it there. It needs "Allow GitHub
Actions to create and approve pull requests" enabled for the organization and the
repository.

When a hotfix patch fails on a new release, upstream either fixed the bug (drop the
patch and its test) or moved the code (re-port its anchors).

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

- **Reproducible:** `reproducibility` rebuilds the gateway weekly with
  `nix build --rebuild` and fails if the output differs from the cached one. Anyone can
  run the same check: `nix build github:alinaos-org/openclaw-nix/<tag>#gateway --rebuild`.
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
are built with [nix-openclaw](https://github.com/openclaw/nix-openclaw), which is
AGPL-3.0 with no additional permissions, so an organization with an AGPL policy should
review this before deploying. The parts that come from nix-openclaw, as of this
release:

| openclaw-nix output | nix-openclaw part | How it is used |
|---|---|---|
| `gateway` (and every layer over it) | `nix/packages/openclaw-gateway-source.nix` | the source recipe, called and overridden |
| `gateway` | `nix/scripts/gateway-build.sh`, `gateway-prebuild.sh` | copied into the build and edited (`packages/gateway`) |
| `runtime-plugins`, `pkgs.openclawRuntimePlugins` | `nix/lib/openclaw-runtime-plugin.nix`, `nix/generated/openclaw-runtime-plugins` | the plugin builder and its generated locks |
| `overlays.default` | `overlays.default` | applied first, for the CLI tool bundle |
| `homeManagerModules.configOverlay` | `homeManagerModules.openclaw` | extends its `programs.openclaw.instances` options |

These are build recipes and configuration modules. None of nix-openclaw's code runs
inside the gateway, and none is served over a network. `NOTICE` lists the components
and their licenses. Removing the dependency means replacing each row with an
openclaw-nix implementation written from OpenClaw's own build. That is tracked as
future work, and the server module (`nixosModules.openclaw`) already needs none of it
beyond the packages.
