# One OpenClaw release, everywhere. Apply after nix-openclaw's overlay:
#
#   openclaw-gateway        the gateway built from source (packages/gateway)
#   openclaw                the CLI bundle, wrapping that gateway
#   openclawRuntimePlugins  every pinned npm plugin, linked to that gateway
#   openclawNix             release data and builders: hotfix, stateFence,
#                           mkRuntimePlugin, checkSingleRelease
#
# Anything a consumer builds against the plugin SDK should link
# `final.openclaw-gateway` too, so a closure never mixes OpenClaw releases.
{nix-openclaw}: {
  # Arguments for packages/gateway: extraSourcePatches, extraTests,
  # extraInstallCommands, localRevision.
  gatewayArgs ? {},
  # Tools to drop from nix-openclaw's CLI bundle (for example ones the host
  # installs itself, so each exists once on PATH).
  excludeToolNames ? [],
}: final: prev: let
  inherit (final) lib;
  release = import ./release.nix;
  pins = builtins.fromJSON (builtins.readFile ./pins/runtime-plugins.json);
  upstreamLocks = import "${nix-openclaw}/nix/generated/openclaw-runtime-plugins";

  gateway = final.callPackage ./packages/gateway ({inherit nix-openclaw;} // gatewayArgs);

  # Plugins nix-openclaw's generated lock set does not describe.
  manualLocks.voyage = {
    id = "voyage";
    packageName = "@openclaw/voyage-provider";
    dependencyMode = "none";
    runtimeExtensions = ["./dist/index.js"];
    dependencies = {};
    optionalDependencies = {};
    bundledPackageRoots = [];
  };

  pinnedLock = id: let
    pin = pins.plugins.${id};
    compat = ">=${pins.version}";
  in
    (upstreamLocks.${id} or manualLocks.${id} or (throw "openclaw-nix: no lock shape for runtime plugin ${id}"))
    // {
      version = pins.version;
      inherit (pin) tarballUrl npmIntegrity npmShasum nixHash dependencies;
      openclawCompat = compat;
      peerOpenClaw = compat;
    }
    // lib.optionalAttrs (pin.bundleDependencies != []) {
      inherit (pin) bundleDependencies;
      bundledPackageRoots = map (dep: "node_modules/${dep}") pin.bundleDependencies;
    };

  mkRuntimePlugin = lock:
    final.callPackage "${nix-openclaw}/nix/lib/openclaw-runtime-plugin.nix" {
      openclawPackage = gateway;
    }
    lock;

  pinnedPlugins =
    if pins.version != release.current
    then throw "openclaw-nix: pins/runtime-plugins.json is for ${pins.version}, release.nix is ${release.current}; run scripts/pin-runtime-plugins.py"
    else lib.mapAttrs (id: _: mkRuntimePlugin (pinnedLock id)) pins.plugins;

  # OpenClaw's own packages carry the release in their names. Plugins with an
  # independent version scheme (third-party npm plugins) are not matched.
  coreNamePattern = "^/nix/store/[a-z0-9]{32}-openclaw(-gateway(-[a-z]+)?|-runtime-plugin-(${lib.concatStringsSep "|" (lib.attrNames pins.plugins ++ ["acpx" "codex"])}))?-(20[0-9]{2}\\.[0-9]+\\.[0-9]+)";
in {
  openclaw-gateway = gateway;

  openclaw = (prev.openclawPackages.withTools {inherit excludeToolNames;}).openclaw.override {
    openclaw-gateway = gateway;
    inherit (gateway) version;
  };

  openclawRuntimePlugins = (prev.openclawRuntimePlugins or {}) // pinnedPlugins;

  openclawNix = {
    inherit release pins gateway mkRuntimePlugin;
    pinnedLock = pinnedLock;

    # The post-build fixes (packages/hotfix) over a gateway tree.
    hotfix = gw: final.callPackage ./packages/hotfix {gateway = gw;};

    # A fenced entrypoint over a final gateway tree (packages/state-fence.nix).
    stateFence = args: final.callPackage ./packages/state-fence.nix args;

    # A check that fails when the runtime closure of `roots` carries an
    # OpenClaw gateway, CLI or pinned plugin of any release but the current one.
    checkSingleRelease = {
      name ? "openclaw-single-release",
      roots,
    }:
      final.runCommand name {
        closure = final.closureInfo {rootPaths = roots;};
        nativeBuildInputs = [final.gnugrep final.gawk];
      } ''
        stale=$(grep -E '${coreNamePattern}' "$closure/store-paths" \
          | grep -vE -- '-${lib.escapeRegex release.current}([^0-9.]|$)' || true)
        if [ -n "$stale" ]; then
          echo "OpenClaw packages from a release other than ${release.current}:" >&2
          printf '  %s\n' $stale >&2
          exit 1
        fi
        echo "single OpenClaw release ${release.current}: $(grep -cE '${coreNamePattern}' "$closure/store-paths") packages checked"
        touch "$out"
      '';
  };
}
