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
  each patch anchored to the exact code it replaces and tested in the build.
- **A state fence** (`packages/state-fence.nix`): an entrypoint that refuses implicit
  or protected state directories, so a candidate or recovery binary run by hand
  cannot migrate production state. It wraps a finished tree, so several fenced
  gateways share one build.

## Use

```nix
{
  inputs.openclaw-nix.url = "github:alinaos-org/openclaw-nix";

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

## Releases

`scripts/new-release.py <version>` adds a release (tag, release-SHA cross-check, source
and pnpm hashes) and `scripts/pin-runtime-plugins.py <version>` re-pins the plugins.
The `release-watch` workflow runs both daily and opens a pull request when OpenClaw
publishes a new stable release; CI builds and tests it there.

When a hotfix patch fails on a new release, upstream either fixed the bug (drop the
patch and its test) or moved the code (re-port its anchors).

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

## License

MIT. nix-openclaw, used as a flake input and not copied here, is AGPL-3.0.
