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

`openclaw-nix.lib.mkOverlay { gatewayArgs = ...; excludeToolNames = [...]; }` customises
the build; `lib.mkPackageSetOverlay` is the same without nix-openclaw's overlay, for
consumers that already apply it. `gatewayArgs`:

| Argument | Effect |
|---|---|
| `extraSourcePatches` | Source patches (paths, or `{name, patch}`) applied before pnpm, `-p1`, zero fuzz. Their digest is part of the Control UI build identity. |
| `extraTests` | Upstream vitest files run before pruning. |
| `extraInstallCommands` | Shell at the end of the install phase (`$out`, `$node`). |
| `localRevision` | Version suffix, `<release>-nix.N`. |

Builders under `pkgs.openclawNix`:

```nix
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
minutes. Set the repository variable `CACHIX_CACHE` and the secret `CACHIX_AUTH_TOKEN`
to push the release's pnpm dependency set to a Cachix cache. Its store path depends on
its hash alone, so a consumer that adds the cache as a substituter fetches it instead
of resolving it from the npm registry, even when its own `extraSourcePatches` give it a
different gateway build. `BUILD_RUNNER` selects a larger runner (the source build peaks
around 15 GB).

## License

MIT. nix-openclaw, used as a flake input and not copied here, is AGPL-3.0.
