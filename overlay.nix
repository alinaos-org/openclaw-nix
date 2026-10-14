# One OpenClaw release, everywhere. Apply after nix-openclaw's overlay:
#
#   openclaw-gateway        the gateway built from source (packages/gateway),
#                           plus the consumer's customize layer if any
#   openclaw                the CLI bundle, wrapping that gateway
#   openclawRuntimePlugins  every pinned npm plugin, linked to that gateway
#   openclawNix             release data and builders: customize, hotfix,
#                           stateFence, mkRuntimePlugin, checkSingleRelease
#
# Anything a consumer builds against the plugin SDK should link
# `final.openclaw-gateway` too, so a closure never mixes OpenClaw releases.
{
  nix-openclaw,
  self,
}: {
  # Arguments for packages/gateway: extraSourcePatches, extraTests,
  # extraInstallCommands, localRevision. They make the source build the
  # consumer's own; prefer `customize` where it can express the change.
  gatewayArgs ? {},
  # Use this flake's own source build, from its own locked nixpkgs: the one CI
  # builds and the binary cache serves. Leave this flake's nixpkgs input
  # unfollowed so the build stays identical.
  sharedBuild ? false,
  # Arguments for packages/custom (replaceBundledChannels, extraCommands): the
  # consumer's changes as a copy layer over the source build.
  customize ? {},
  # Tools to drop from nix-openclaw's CLI bundle (for example ones the host
  # installs itself, so each exists once on PATH).
  excludeToolNames ? [],
}: final: prev: let
  inherit (final) lib;
  release = import ./release.nix;
  # Every runtime plugin OpenClaw's catalogs list, locked at the release
  # (scripts/generate-plugin-locks.sh, run by release-watch for each release).
  releaseLocksDir = ./pins/runtime-plugin-locks;
  releaseLocksFor = (builtins.fromJSON (builtins.readFile ./pins/runtime-plugin-locks/report.json)).openclawVersion;
  releaseLocks =
    if releaseLocksFor != release.current
    then throw "openclaw-nix: pins/runtime-plugin-locks is for ${releaseLocksFor}, release.nix is ${release.current}; run scripts/generate-plugin-locks.sh ${release.current}"
    else import releaseLocksDir;
  # Plugins outside those catalogs, pinned to the release by scripts/pin-runtime-plugins.py.
  pins = builtins.fromJSON (builtins.readFile ./pins/runtime-plugins.json);

  # The gateway's source recipe: our nix-openclaw's nix/gateway-recipe (the
  # August recipe packages/gateway's repairs are written against; upstream's
  # later one breaks the @openclaw/ai step on 2026.10.x). Only that directory,
  # so a nix-openclaw change elsewhere never rebuilds the gateway.
  gatewayRecipe = builtins.path {
    name = "openclaw-gateway-recipe";
    path = "${nix-openclaw.outPath}/nix/gateway-recipe";
    filter = path: _: baseNameOf path != "README.md";
  };
  compiledGateway =
    if sharedBuild
    then
      assert lib.assertMsg (gatewayArgs == {})
      "openclaw-nix: sharedBuild uses this flake's own gateway build; express gatewayArgs as customize";
        self.packages.${final.stdenv.hostPlatform.system}.gateway
    else
      final.callPackage ./packages/gateway ({
          inherit gatewayRecipe;
          # The recipe's own pnpm (nix-openclaw's overlay no longer exports it,
          # and nixpkgs' pnpm_11 is built on another Node).
          pnpm_11 = prev.callPackage "${gatewayRecipe}/packages/pnpm-11.nix" {};
        }
        // gatewayArgs);
  customizeGateway = args: final.callPackage ./packages/custom args;
  gateway =
    if customize == {}
    then compiledGateway
    else customizeGateway ({gateway = compiledGateway;} // customize);

  # The lock shape of a plugin pinned by hand outside the catalogs: add one here
  # with its pins/runtime-plugins.json entry (none today; the catalogs cover them).
  manualLocks = {};

  pinnedLock = id: let
    pin = pins.plugins.${id};
    compat = ">=${pins.version}";
  in
    (manualLocks.${id} or (throw "openclaw-nix: no lock shape for runtime plugin ${id}"))
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

  # The builder runs nix-openclaw's nix/scripts and nothing else of it. Only that
  # directory is its source, so a nix-openclaw change elsewhere (its Home Manager
  # module, say) does not rebuild every plugin.
  nixOpenclawScripts = builtins.path {
    name = "nix-openclaw-scripts";
    path = nix-openclaw.outPath;
    filter = path: _: let
      rel = lib.removePrefix "${nix-openclaw.outPath}/" (toString path);
    in
      rel == "nix" || rel == "nix/scripts" || lib.hasPrefix "nix/scripts/" rel;
  };
  # nix-openclaw's plugin builder, reading package-lock files from the release's
  # lock set (packages/runtime-plugin/builder.nix).
  buildRuntimePlugin = {
    openclawPackage ? gateway,
    linkOpenClawPeer ? openclawPackage != null,
  }:
    final.callPackage ./packages/runtime-plugin/builder.nix {
      inherit openclawPackage linkOpenClawPeer;
      nix-openclaw = nixOpenclawScripts;
      packageLockDir = releaseLocksDir;
    };
  mkRuntimePlugin = buildRuntimePlugin {};

  releasePlugins = lib.mapAttrs (_: mkRuntimePlugin) releaseLocks;
  # A catalog plugin is never also pinned by hand: the release's lock wins.
  manualPins = removeAttrs pins.plugins (lib.attrNames releaseLocks);
  pinnedPlugins =
    if manualPins != {} && pins.version != release.current
    then throw "openclaw-nix: pins/runtime-plugins.json is for ${pins.version}, release.nix is ${release.current}; run scripts/pin-runtime-plugins.py ${release.current}"
    else lib.mapAttrs (id: _: mkRuntimePlugin (pinnedLock id)) manualPins;
  # Every plugin this package set builds at the release.
  runtimePluginIds = lib.attrNames releasePlugins ++ lib.attrNames pinnedPlugins;

  # OpenClaw's own packages carry the release in their names, after any layer
  # suffixes (openclaw-gateway-custom-fenced-<release>). Plugins with an
  # independent version scheme (third-party npm plugins) are not matched.
  coreNamePattern = "^/nix/store/[a-z0-9]{32}-openclaw(-gateway(-[a-z]+)*|-runtime-plugin-(${lib.concatStringsSep "|" (runtimePluginIds ++ ["acpx" "codex"])}))?-(20[0-9]{2}\\.[0-9]+\\.[0-9]+)";
in {
  openclaw-gateway = gateway;

  openclaw = (prev.openclawPackages.withTools {inherit excludeToolNames;}).openclaw.override {
    openclaw-gateway = gateway;
    inherit (gateway) version;
  };

  # Native Control UI plugins that ship with openclaw-nix. The plugin's own tests
  # run in the build (a manifest/registration mismatch drops a plugin at load),
  # and its SDK peer links the gateway in the closure.
  openclawRuntimePlugins =
    (prev.openclawRuntimePlugins or {})
    // releasePlugins
    // pinnedPlugins
    // {
      # The session menu's Custom icons library: a native Control UI dialog that saves a
      # colour SVG icon through the gateway's own sessions.patch. No config.
      session-icons =
        final.runCommand "openclaw-runtime-plugin-session-icons-0.2.0" {
          nativeBuildInputs = [final.nodejs_22];
        } ''
          mkdir -p $out/node_modules
          cp -r ${./packages/openclaw-session-icons}/. $out/
          node --test $out/tests/*.test.mjs
          ln -s ${final.openclaw-gateway}/lib/openclaw $out/node_modules/openclaw
        '';
    };

  openclawNix = {
    inherit release pins gateway compiledGateway mkRuntimePlugin buildRuntimePlugin runtimePluginIds;
    # The release's lock set ({id = lock;}) and the directory it was generated in.
    runtimePluginLocks = releaseLocks;
    runtimePluginLocksDir = releaseLocksDir;
    pinnedLock = pinnedLock;

    # A consumer's changes as a copy layer over a gateway tree (packages/custom).
    customize = customizeGateway;

    # Nix config plus a Control UI that can save (packages/config-overlay).
    configOverlay = self.lib.mkConfigOverlay final;

    # The openclaw-upgrade skill with a host profile (lib.mkUpgradeSkill).
    upgradeSkill = args: self.lib.mkUpgradeSkill ({pkgs = final;} // args);

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
