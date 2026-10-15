# OpenClaw gateway built from source at a pinned release commit (releases.nix),
# on top of nix-openclaw's source recipe (our fork's nix/gateway-recipe, passed
# as gatewayRecipe). Supports stable 2026.10.x on.
#
# What this adds to the upstream recipe, each a repair for the Nix store layout
# with a check that fails the build when a release moves the code it targets:
# - pnpm: drop the pnpm-12 self-management lock document (Nix supplies pnpm)
#   and fetch the dependency store for the host platform only;
# - build: tsx runners, the AI and external-plugin dist steps, esbuild
#   shutdown ownership, procps for the managed process-group check;
# - install: per-plugin dependency trees, the `openclaw` self-reference, CJS
#   plugin entries as regular files, the managed Codex app-server links, a
#   plain `bin/openclaw` launcher on the gateway's Node.
#
# And openclaw-nix's own source changes (patches/, applied before a consumer's),
# each with the upstream tests it changes run in the build:
# - session-icon-picker.patch: the Control UI's session icon picker offers every
#   emoji (search, categories, recent choices) and openclaw-nix's 72-icon library
#   under Icons. Its emoji catalog is scripts/generate-session-emoji.mjs's output.
#
# Host identity (which state directory a host may use) is not part of this
# build: see ../state-fence.nix. Consumer-specific changes go through
# `extraSourcePatches`, `extraTests` and `extraInstallCommands`.
{
  lib,
  stdenv,
  callPackage,
  runCommand,
  fetchFromGitHub,
  fetchPnpmDeps,
  bashNonInteractive,
  coreutils,
  findutils,
  jq,
  patch,
  procps,
  sqlite,
  nodejs_24,
  pnpm_11,
  gatewayRecipe,
  releases ? import ../../releases.nix,
  release ? (import ../../release.nix).current,
  # Appended to the version: <release>-<localRevision>. Bump when this build
  # changes for the same upstream release.
  localRevision ? "nix.3",
  # Source patches applied in order, before pnpm: a list of paths, or of
  # { name, patch } attrsets. Applied with -p1 and zero fuzz.
  extraSourcePatches ? [],
  # Upstream vitest files (relative to the source root) run before pruning,
  # for example the tests a consumer patch touches.
  extraTests ? [],
  # Shell run at the end of the install phase. $out and $node are set.
  extraInstallCommands ? "",
}: let
  releaseInfo = releases.${release} or (throw "openclaw-nix: unsupported OpenClaw release ${release}");
  upstreamVersion = release;
  inherit (releaseInfo) rev buildTimestamp;
  _supported =
    lib.assertMsg (lib.versionAtLeast upstreamVersion "2026.10.1")
    "openclaw-nix builds OpenClaw 2026.10.1 and later (got ${upstreamVersion})";
  version = "${upstreamVersion}-${localRevision}";
  node = nodejs_24;
  system = stdenv.hostPlatform.system;
  pnpmDepsHash =
    releaseInfo.pnpmDepsHash.${system}
    or (throw "openclaw-nix: no pnpmDepsHash for ${system} in release ${release}");

  # openclaw-nix's own changes, then the consumer's. A release that moves the code a
  # patch targets fails `patch -F0` below: re-port the patch (or drop it).
  ownSourcePatches = [
    {
      name = "session-icon-picker.patch";
      patch = ./patches/session-icon-picker.patch;
    }
  ];
  # Control UI tests the own patches change; run with the UI's vitest config.
  ownUiTests = [
    "ui/src/components/session-icon-catalog.test.ts"
    "ui/src/components/session-menu.test.ts"
    "ui/src/components/session-people-search.test.ts"
  ];
  sourcePatches =
    ownSourcePatches
    ++ map (p:
      if builtins.isAttrs p
      then p
      else {
        name = baseNameOf (toString p);
        patch = p;
      })
    extraSourcePatches;
  patchesId = builtins.hashString "sha256" (lib.concatMapStrings (p: builtins.hashFile "sha256" p.patch) sourcePatches);
  # One reproducible identity across the runtime and Control UI build steps.
  controlUiBuildId = "${version}-${builtins.substring 0 12 rev}-${
    builtins.replaceStrings [":"] ["-"] buildTimestamp
  }${lib.optionalString (sourcePatches != []) "-p${builtins.substring 0 12 patchesId}"}";

  sourceInfo = {
    owner = "openclaw";
    repo = "openclaw";
    pnpmMajor = "11";
    releaseVersion = upstreamVersion;
    runtimePluginVersion = upstreamVersion;
    inherit rev;
    applyPublicSurfaceHardlinksPatch = false;
    applySkipPluginAutoEnableNixModePatch = false;
    applyNixStorePluginOwnershipPatch = false;
  };
  upstreamSrc = fetchFromGitHub {
    inherit (sourceInfo) owner repo rev;
    hash = releaseInfo.sourceHash;
  };

  src = runCommand "openclaw-${upstreamVersion}-source" {} ''
    cp -R ${upstreamSrc} $out
    chmod -R u+w $out
    ${lib.concatMapStrings (p: ''
        echo "applying ${p.name}"
        ${patch}/bin/patch -d $out -p1 --batch --forward --no-backup-if-mismatch -F0 < ${p.patch}
      '')
      sourcePatches}
    # Upstream pins pnpm 12 through package-manager self-management, recorded
    # as a leading YAML document in pnpm-lock.yaml. Nix supplies a pinned pnpm,
    # so drop exactly that bootstrap document and keep the dependency lock.
    ${node}/bin/node --input-type=module - "$out" <<'EOF'
    import fs from "node:fs";
    const root = process.argv[2];
    const lockPath = `''${root}/pnpm-lock.yaml`;
    const lock = fs.readFileSync(lockPath, "utf8");
    const secondDocument = lock.indexOf("\n---\nlockfileVersion:", 1);
    const bootstrapDocument = lock.slice(0, secondDocument);
    if (
      secondDocument < 0 ||
      !bootstrapDocument.includes("packageManagerDependencies:") ||
      !bootstrapDocument.includes("pnpm@${releaseInfo.pnpmBootstrapVersion}")
    ) {
      throw new Error("pnpm 12 package-manager lock document missing");
    }
    // Retaining the bootstrap document's packages leaves unreachable tarballs
    // that the nixpkgs fetcher rejects as an incomplete store.
    fs.writeFileSync(lockPath, lock.slice(secondDocument + "\n---\n".length));

    const workspacePath = `''${root}/pnpm-workspace.yaml`;
    const workspace = fs.readFileSync(workspacePath, "utf8");
    const releasePolicy = `minimumReleaseAge: 10080
    minimumReleaseAgeStrict: true`;
    if (!workspace.includes(releasePolicy)) {
      throw new Error("pnpm release-age policy anchor missing");
    }
    fs.writeFileSync(
      workspacePath,
      workspace.replace(releasePolicy, "minimumReleaseAge: 0\nminimumReleaseAgeStrict: false\nminReleaseAge: 0"),
    );
    EOF
    ${jq}/bin/jq '.packageManager = "pnpm@11.2.2"' $out/package.json > $out/package.json.pnpm
    mv $out/package.json.pnpm $out/package.json
    ${jq}/bin/jq '.pnpm.onlyBuiltDependencies = [
      "@openclaw/fs-safe", "@google/genai", "@lydell/node-pty",
      "@matrix-org/matrix-sdk-crypto-nodejs", "@tloncorp/api",
      "@tloncorp/tlon-skill", "baileys", "authenticate-pam", "esbuild",
      "protobufjs", "sharp", "openclaw", "@openclaw/proxyline", "clawpdf",
      "@openclaw/crabline", "rastermill", "node-pty"
    ]' $out/package.json > $out/package.json.tmp
    mv $out/package.json.tmp $out/package.json
    cat >> $out/pnpm-workspace.yaml <<'EOF'
    # Large agent-runtime artifacts: a ten-minute fetch timeout is too short on
    # slow links and leaves pnpm's virtual store partially linked.
    fetchTimeout: 3600000
    fetchRetries: 10
    fetchRetryFactor: 2
    fetchRetryMintimeout: 10000
    fetchRetryMaxtimeout: 60000
    networkConcurrency: 4
    managePackageManagerVersions: false
    EOF
  '';

  # fetchPnpmDeps v4 passes --force so one fixed-output store fits every OS and
  # CPU. OpenClaw's optional native toolchain makes that store several GB of
  # Darwin, Windows, ARM and musl payloads, so fetch for the host only.
  hostPlatformFetchPnpmDeps = args:
    (fetchPnpmDeps args).overrideAttrs (old: let
      originalInstallPhase = old.installPhase or "";
      # nixpkgs moved the v4 install flags into an `installFlagsArray` bash
      # array (2026-09); strip --force from either shape.
      hostInstallPhase =
        builtins.replaceStrings ["--force \\\n" "  \"--force\"\n"] ["" ""] originalInstallPhase;
      preFixupBlocks = lib.splitString "\n\n" (old.preFixup or "");
      hostPreFixup = lib.last preFixupBlocks;
    in {
      installPhase = assert lib.assertMsg (hostInstallPhase != originalInstallPhase)
      "openclaw-nix: could not remove fetchPnpmDeps --force for a host-only fetch"; hostInstallPhase;
      # v4's preFixup rejects lockfile entries omitted for other platforms. pnpm
      # already verified every fetched tarball; keep the store-index normalization.
      preFixup = assert lib.assertMsg
      (builtins.length preFixupBlocks == 2 && lib.hasInfix "normalize-pnpm-store-index" hostPreFixup)
      "openclaw-nix: could not isolate the fetchPnpmDeps v4 completeness check"; hostPreFixup;
    });

  baseGateway = callPackage "${gatewayRecipe}/packages/openclaw-gateway-source.nix" {
    inherit sourceInfo pnpmDepsHash;
    nodejs_22 = node;
    gatewaySrc = src;
    inherit pnpm_11;
    fetchPnpmDeps = hostPlatformFetchPnpmDeps;
  };

  tsxBuildRunner = runCommand "openclaw-tsx-build-runner" {} ''
    mkdir -p $out/bin
    cat >$out/bin/openclaw-tsx <<'EOF'
    #!${bashNonInteractive}/bin/bash
    set -euo pipefail

    if [[ -f scripts/tsx.mjs ]]; then
      export OPENCLAW_BUILD_ALL_NO_PNPM=1
      exec node --import ./scripts/tsx.mjs "$@"
    fi
    exec pnpm exec tsx "$@"
    EOF
    chmod 0555 $out/bin/openclaw-tsx
  '';

  aiDependencyMaterializer = runCommand "openclaw-materialize-ai-dependencies" {} ''
    mkdir -p $out/bin
    cat >$out/bin/openclaw-materialize-ai-dependencies <<'EOF'
    #!${bashNonInteractive}/bin/bash
    set -euo pipefail

    ai_modules=node_modules/@openclaw/ai/node_modules
    if [ ! -d "$ai_modules" ]; then
      exit 0
    fi

    while IFS= read -r -d "" ai_dep; do
      ai_dep_target="$(${coreutils}/bin/readlink "$ai_dep")"
      ai_dep_relative="''${ai_dep_target/node_modules\/.pnpm/.pnpm}"
      if [ "$ai_dep_relative" = "$ai_dep_target" ]; then
        echo "unexpected @openclaw/ai dependency target: $ai_dep_target" >&2
        exit 1
      fi
      ${coreutils}/bin/ln -sfn "$ai_dep_relative" "$ai_dep"
    done < <(${findutils}/bin/find "$ai_modules" -type l -print0)
    EOF
    chmod 0555 $out/bin/openclaw-materialize-ai-dependencies
  '';

  tests = ["src/plugins/hardlink-policy.test.ts"] ++ extraTests;

  gatewayBuild = runCommand "openclaw-gateway-build" {} ''
    cp ${gatewayRecipe}/scripts/gateway-build.sh $out
    chmod u+w $out
    sed -i \
      -e 's#scripts/bundled-plugin-assets\.mjs#scripts/bundled-plugin-assets.mts#g' \
      -e 's#node scripts/bundled-plugin-assets\.mts#${tsxBuildRunner}/bin/openclaw-tsx scripts/bundled-plugin-assets.mts#g' \
      -e 's#node scripts/bundle-a2ui\.mjs#${tsxBuildRunner}/bin/openclaw-tsx scripts/bundle-a2ui.mts#g' \
      -e '/log_step "build: runtime-postbuild"/i log_step "build: tsdown-ai" ${tsxBuildRunner}/bin/openclaw-tsx scripts/tsdown-build.mts --config tsdown.ai.config.ts' \
      -e '/log_step "build: runtime-postbuild"/i log_step "build: external-plugins:local-dist" ${tsxBuildRunner}/bin/openclaw-tsx scripts/build-external-plugin-local-dist.mts' \
      -e '/log_step "build: runtime-postbuild"/i log_step "build: plugins:assets:copy" ${tsxBuildRunner}/bin/openclaw-tsx scripts/bundled-plugin-assets.mts --phase copy' \
      -e '/log_step "build: plugins:assets:copy"/c\  : # plugins:assets:copy runs before runtime-postbuild (above)' \
      -e ${lib.escapeShellArg ''/log_step "build: plugins:assets:build"/i log_step "build: retain esbuild shutdown ownership" node ${./fix-esbuild-shutdown.mjs}''} \
      -e '/log_step "build: plugin-sdk dts"/d' \
      -e '/log_step "build: write-plugin-sdk-entry-dts"/d' \
      -e ${lib.escapeShellArg ''/log_step "pnpm prune --prod"/i ${lib.concatMapStrings (t: "test -f ${t} && ") tests}log_step "test: downstream contracts" node node_modules/vitest/vitest.mjs run ${lib.concatStringsSep " " tests}''} \
      -e ${lib.escapeShellArg ''/log_step "pnpm prune --prod"/i log_step "test: openclaw-nix Control UI changes" node node_modules/vitest/vitest.mjs run --config ui/vitest.config.ts ${lib.concatStringsSep " " ownUiTests}''} \
      -e 's#write-cli-compat\.ts#write-cli-startup-metadata.ts#g' \
      $out
    cat >> $out <<'EOF'
    log_step "materialize @openclaw/ai dependencies" ${aiDependencyMaterializer}/bin/openclaw-materialize-ai-dependencies
    if [ -L node_modules/@openclaw/ai ]; then
      ai_target="$(readlink -f node_modules/@openclaw/ai)"
      ai_tmp="$(mktemp -d)"
      cp -a "$ai_target" "$ai_tmp/ai"
      rm node_modules/@openclaw/ai
      mv "$ai_tmp/ai" node_modules/@openclaw/ai
      rmdir "$ai_tmp"
    fi
    if [ -L node_modules/@openclaw/session-url-contract ]; then
      rm node_modules/@openclaw/session-url-contract
    fi

    build_id="$(${jq}/bin/jq -er '.buildId | select(type == "string" and length > 0)' dist/build-info.json)"
    if [ "$build_id" != "$OPENCLAW_CONTROL_UI_BUILD_ID" ]; then
      echo "runtime build id '$build_id' does not match pinned Control UI build id '$OPENCLAW_CONTROL_UI_BUILD_ID'" >&2
      exit 1
    fi
    if ! grep -R -F -q -- "$build_id" dist/control-ui; then
      echo "runtime build id '$build_id' is not embedded in dist/control-ui" >&2
      exit 1
    fi
    EOF
  '';

  gatewayPrebuild = runCommand "openclaw-gateway-prebuild" {} ''
    cp ${gatewayRecipe}/scripts/gateway-prebuild.sh $out
    chmod u+w $out
    ${node}/bin/node --input-type=module - "$out" <<'EOF'
    import fs from "node:fs";

    const path = process.argv[2];
    const source = fs.readFileSync(path, "utf8");
    const anchor = 'log_step "chmod pnpm store writable" chmod -R +w "$store_path"\n';
    if (!source.includes(anchor)) {
      throw new Error("nix-openclaw pnpm-store extraction anchor missing");
    }

    const restore = `

    # nixpkgs fetchPnpmDeps v4 serializes pnpm 11's SQLite index as SQL so the
    # fixed-output store is reproducible. Reconstruct it before pnpm performs
    # an offline install; content blobs alone cannot satisfy package lookups.
    if [ -f "$store_path/v11/index.db.sql" ]; then
      rm -f "$store_path/v11/index.db"
      ${sqlite}/bin/sqlite3 "$store_path/v11/index.db" < "$store_path/v11/index.db.sql"
      rm "$store_path/v11/index.db.sql"
    fi
    `;

    fs.writeFileSync(path, source.replace(anchor, anchor + restore));
    EOF
    chmod 0555 $out

    grep -Fq '${sqlite}/bin/sqlite3 "$store_path/v11/index.db"' $out
  '';
in
  assert _supported;
    baseGateway.overrideAttrs (final: old: {
      pname = "openclaw-gateway";
      inherit version;
      __intentionallyOverridingVersion = true;
      pnpmDeps = baseGateway.passthru.pnpmDeps;
      # The asset hooks certify process-group exit with `ps`; without it the
      # sandbox cannot certify cleanup and the step fails closed.
      nativeBuildInputs = (old.nativeBuildInputs or []) ++ [procps];
      env =
        (old.env or {})
        // {
          PNPM_DEPS = final.pnpmDeps;
          GATEWAY_PREBUILD_SH = gatewayPrebuild;
          GIT_COMMIT = rev;
          OPENCLAW_BUILD_TIMESTAMP = buildTimestamp;
          OPENCLAW_CONTROL_UI_BUILD_ID = controlUiBuildId;
          # The sandbox hides the cgroup memory controller, so tsdown cannot
          # size its own heap.
          OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB = releaseInfo.tsdownHeapMb;
        };
      # The diffs asset builder owns an unreferenced esbuild service: stop it
      # before the command exits, and run the script without the tsx loader
      # worker, whose own esbuild instance stop() cannot join.
      postPatch =
        (old.postPatch or "")
        + ''

          substituteInPlace scripts/build-diffs-viewer-runtime.mts \
            --replace-fail 'import { build, type Plugin } from "esbuild";' 'import { build, stop, type Plugin } from "esbuild";' \
            --replace-fail '  await buildDiffsViewerRuntime(process.argv[2]);' '  try { await buildDiffsViewerRuntime(process.argv[2]); } finally { await stop(); }'
          substituteInPlace extensions/diffs/package.json extensions/diffs-language-pack/package.json \
            --replace-fail 'node --import tsx ../../scripts/build-diffs-viewer-runtime.mts' 'node ../../scripts/build-diffs-viewer-runtime.mts'
        '';
      buildPhase = "${gatewayBuild}";
      installPhase =
        old.installPhase
        + ''

          node=${node}/bin/node

          # pnpm prune removes workspace-level links but keeps the packages in
          # the root virtual store. Give each bundled plugin its exact declared
          # dependency tree beside both runtime layouts (per plugin, so
          # conflicting versions stay isolated).
          $node --input-type=module - "$PWD/extensions" "$out/lib/openclaw" <<'EOF'
          import {
            existsSync,
            mkdirSync,
            readFileSync,
            readdirSync,
            realpathSync,
            symlinkSync,
          } from "node:fs";
          import path from "node:path";

          const sourceExtensions = process.argv[2];
          const root = process.argv[3];
          const virtualStore = path.join(root, "node_modules", ".pnpm");
          const packageIndex = new Map();

          function readManifest(packageRoot) {
            const manifestPath = path.join(packageRoot, "package.json");
            if (!existsSync(manifestPath)) return null;
            return JSON.parse(readFileSync(manifestPath, "utf8"));
          }

          function indexPackage(packageRoot) {
            const manifest = readManifest(packageRoot);
            if (!manifest?.name || !manifest?.version) return;
            const key = manifest.name + "\0" + manifest.version;
            const paths = packageIndex.get(key) ?? [];
            const canonicalRoot = realpathSync(packageRoot);
            if (!paths.includes(canonicalRoot)) paths.push(canonicalRoot);
            packageIndex.set(key, paths);
          }

          for (const contextName of readdirSync(virtualStore)) {
            const modulesRoot = path.join(virtualStore, contextName, "node_modules");
            if (!existsSync(modulesRoot)) continue;
            for (const entry of readdirSync(modulesRoot, { withFileTypes: true })) {
              const entryRoot = path.join(modulesRoot, entry.name);
              if (entry.name.startsWith("@")) {
                if (!entry.isDirectory()) continue;
                for (const scopedName of readdirSync(entryRoot)) {
                  indexPackage(path.join(entryRoot, scopedName));
                }
              } else {
                indexPackage(entryRoot);
              }
            }
          }

          for (const pluginName of readdirSync(sourceExtensions)) {
            const sourcePlugin = path.join(sourceExtensions, pluginName);
            const manifest = readManifest(sourcePlugin);
            const runtimePlugin = path.join(root, "dist-runtime", "extensions", pluginName);
            if (!manifest || !existsSync(runtimePlugin)) continue;

            const pluginModules = path.join(root, "extensions", pluginName, "node_modules");
            mkdirSync(pluginModules, { recursive: true });
            for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
              if (!/^[0-9]/.test(version)) continue;
              const existingManifest = readManifest(path.join(pluginModules, ...dependency.split("/")));
              if (existingManifest) {
                if (existingManifest.version !== version) throw new Error("existing plugin dependency version mismatch: " + pluginName + "/" + dependency);
                continue;
              }
              const candidates = packageIndex.get(dependency + "\0" + version) ?? [];
              if (candidates.length !== 1) {
                throw new Error(
                  "expected one virtual-store package for " +
                    pluginName +
                    " dependency " +
                    dependency +
                    "@" +
                    version +
                    ", found " +
                    candidates.length,
                );
              }
              const linkPath = path.join(pluginModules, ...dependency.split("/"));
              mkdirSync(path.dirname(linkPath), { recursive: true });
              symlinkSync(path.relative(path.dirname(linkPath), candidates[0]), linkPath);
            }

            for (const runtimeLayout of ["dist/extensions", "dist-runtime/extensions"]) {
              const runtimeRoot = path.join(root, runtimeLayout, pluginName);
              if (!existsSync(runtimeRoot)) continue;
              const linkPath = path.join(runtimeRoot, "node_modules");
              if (!existsSync(linkPath)) {
                symlinkSync(path.relative(runtimeRoot, pluginModules), linkPath);
              }
              for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
                if (!/^[0-9]/.test(version)) continue;
                let resolved = null;
                for (let dir = runtimeRoot; ; dir = path.dirname(dir)) {
                  resolved = readManifest(path.join(dir, "node_modules", ...dependency.split("/")));
                  if (resolved || path.dirname(dir) === dir) break;
                }
                if (resolved?.version !== version) {
                  throw new Error("installed plugin dependency mismatch: " + runtimeLayout + "/" + pluginName + " " + dependency + "@" + version);
                }
              }
            }
          }
          EOF

          # baileys imports `long` without declaring it. It is pinned in the
          # virtual store through protobufjs: restore the sibling link in each
          # baileys peer context instead of adding an unpinned dependency.
          long_package=""
          for long_candidate in "$out/lib/openclaw/node_modules/.pnpm"/long@*/node_modules/long; do
            [ -d "$long_candidate" ] || continue
            if [ -n "$long_package" ]; then
              echo "ambiguous long packages in the pnpm virtual store" >&2
              exit 1
            fi
            long_package="$long_candidate"
          done
          if [ -z "$long_package" ]; then
            echo "long package missing from the pnpm virtual store" >&2
            exit 1
          fi
          for baileys_store in "$out/lib/openclaw/node_modules/.pnpm"/baileys@*; do
            [ -d "$baileys_store/node_modules/baileys" ] || continue
            if [ ! -e "$baileys_store/node_modules/long" ]; then
              ln -s \
                "$(realpath --relative-to="$baileys_store/node_modules" "$long_package")" \
                "$baileys_store/node_modules/long"
            fi
          done

          # Fail the build if any declared bundled-plugin dependency is still
          # unresolved from the installed entrypoint layout.
          $node --input-type=module - "$out/lib/openclaw" <<'EOF'
          import { readdirSync, readFileSync } from "node:fs";
          import path from "node:path";

          const root = process.argv[2];
          const extensionsRoot = path.join(root, "dist-runtime", "extensions");
          for (const pluginName of readdirSync(extensionsRoot)) {
            const pluginRoot = path.join(extensionsRoot, pluginName);
            const manifestPath = path.join(pluginRoot, "package.json");
            let manifest;
            try {
              manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            } catch (error) {
              if (error?.code === "ENOENT") continue;
              throw error;
            }
            for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
              if (!/^[0-9]/.test(version)) continue;
              const dependencyManifestPath = path.join(
                pluginRoot,
                "node_modules",
                ...dependency.split("/"),
                "package.json",
              );
              const dependencyManifest = JSON.parse(readFileSync(dependencyManifestPath, "utf8"));
              if (dependencyManifest.name !== dependency) {
                throw new Error(`resolved unexpected package for ''${pluginName} dependency ''${dependency}`);
              }
            }
          }
          EOF

          # External first-party plugins (sms, perplexity, tavily, ...) import
          # the host as the bare package name `openclaw`, which an npm layout
          # resolves through a parent node_modules. Give the package the
          # self-reference an npm install provides.
          ln -s .. "$out/lib/openclaw/node_modules/openclaw"
          test "$(${coreutils}/bin/readlink -f "$out/lib/openclaw/node_modules/openclaw/package.json")" \
            = "$(${coreutils}/bin/readlink -f "$out/lib/openclaw/package.json")"

          # dist-runtime symlinks CJS plugin entries (msteams) into
          # dist/extensions, and discovery rejects entries whose real path
          # leaves the package directory. Materialize them as regular files.
          while IFS= read -r -d "" cjs_link; do
            cjs_target="$(${coreutils}/bin/readlink -f "$cjs_link")"
            rm "$cjs_link"
            cp "$cjs_target" "$cjs_link"
          done < <(${findutils}/bin/find "$out/lib/openclaw/dist-runtime/extensions" -mindepth 2 -maxdepth 2 -type l -name '*.cjs' -print0)
          test -z "$(${findutils}/bin/find "$out/lib/openclaw/dist-runtime/extensions" -mindepth 2 -maxdepth 2 -type l -name '*.cjs' -print -quit)"

          # Bundled native Control UI (workboard, slack, discord): the runtime
          # overlay stages every file as a link into dist/extensions, and the
          # Control UI asset reader skips links, so each declared browser build
          # must be regular files under dist-runtime/extensions. Fail the build
          # if one is missing.
          $node --input-type=module - "$out/lib/openclaw" <<'EOF'
          import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
          import path from "node:path";
          const root = process.argv[2];
          const materialized = [];
          for (const id of readdirSync(path.join(root, "dist", "extensions"))) {
            const manifestPath = path.join(root, "dist", "extensions", id, "openclaw.plugin.json");
            if (!existsSync(manifestPath)) continue;
            const { controlUi } = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (!controlUi?.entry) continue;
            const runtimePlugin = path.join(root, "dist-runtime", "extensions", id);
            if (!existsSync(runtimePlugin)) continue;
            const build = path.posix.dirname(controlUi.entry);
            rmSync(path.join(runtimePlugin, build), { recursive: true, force: true });
            cpSync(path.join(root, "dist", "extensions", id, build), path.join(runtimePlugin, build), {
              recursive: true,
              dereference: true,
            });
            for (const asset of [controlUi.entry, ...(controlUi.styles ?? [])]) {
              const file = path.join(runtimePlugin, asset);
              if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
                throw new Error(`''${id}: declared Control UI asset ''${asset} is not a regular file in dist-runtime`);
              }
            }
            materialized.push(id);
          }
          if (!materialized.includes("workboard")) {
            throw new Error(`no bundled Control UI materialized (found: ''${materialized.join(", ") || "none"})`);
          }
          console.log(`bundled Control UI materialized in dist-runtime: ''${materialized.join(", ")}`);
          EOF

          # Load the repaired artifacts the way discovery and the channel loader
          # do, so a layout change fails the build instead of the gateway.
          $node --input-type=module - "$out/lib/openclaw" <<'EOF'
          import { createRequire } from "node:module";
          import { pathToFileURL } from "node:url";
          const root = process.argv[2];
          const sms = await import(pathToFileURL(root + "/dist-runtime/extensions/sms/index.js"));
          if (sms.default?.kind !== "bundled-channel-entry" || sms.default?.id !== "sms") {
            throw new Error("bundled sms channel entry did not load through the openclaw self-reference");
          }
          const codexDoctor = await import(pathToFileURL(root + "/dist/extensions/codex/doctor-contract-api.js"));
          if (Object.keys(codexDoctor).length === 0) {
            throw new Error("codex doctor contract did not load through the openclaw self-reference");
          }
          const require = createRequire(pathToFileURL(root + "/package.json"));
          const msteams = require(root + "/dist-runtime/extensions/msteams/index.cjs");
          const msteamsEntry = msteams.default ?? msteams;
          if (msteamsEntry?.kind !== "bundled-channel-entry" || msteamsEntry?.id !== "msteams") {
            throw new Error("materialized msteams CJS entry did not load");
          }
          EOF

          # extensions/codex links @openai/codex only under its own
          # node_modules, which this layout does not install. The managed
          # app-server resolver probes <root>/node_modules/.bin/codex and
          # require.resolve("@openai/codex/package.json") from lib/openclaw.
          # Restore the two links an npm install leaves, from the virtual store.
          codex_pnpm_root=""
          for codex_candidate in "$out/lib/openclaw/node_modules/.pnpm"/@openai+codex@*/node_modules/@openai/codex; do
            if [ -f "$codex_candidate/bin/codex.js" ]; then
              if [ -n "$codex_pnpm_root" ]; then
                echo "ambiguous managed Codex app-server packages in the pnpm virtual store" >&2
                exit 1
              fi
              codex_pnpm_root="$codex_candidate"
            fi
          done
          if [ -z "$codex_pnpm_root" ]; then
            echo "managed Codex app-server package missing from the pnpm virtual store" >&2
            exit 1
          fi
          chmod u+w "$out/lib/openclaw/node_modules" "$out/lib/openclaw/node_modules/.bin"
          mkdir -p "$out/lib/openclaw/node_modules/@openai"
          ln -s \
            "$(realpath --relative-to="$out/lib/openclaw/node_modules/@openai" "$codex_pnpm_root")" \
            "$out/lib/openclaw/node_modules/@openai/codex"
          # Pin the interpreter instead of npm's "#!/usr/bin/env node" shebang.
          cat >"$out/lib/openclaw/node_modules/.bin/codex" <<CODEXBIN
          #!${bashNonInteractive}/bin/bash
          exec ${node}/bin/node "$out/lib/openclaw/node_modules/@openai/codex/bin/codex.js" "\$@"
          CODEXBIN
          chmod 0555 "$out/lib/openclaw/node_modules/.bin/codex"

          # Reproduce both resolver probes and run the selected command.
          $node --input-type=module - "$out/lib/openclaw" <<'EOF'
          import { execFileSync } from "node:child_process";
          import { accessSync, constants, readFileSync } from "node:fs";
          import { createRequire } from "node:module";
          import path from "node:path";

          const root = process.argv[2];
          const binPath = path.join(root, "node_modules", ".bin", "codex");
          accessSync(binPath, constants.X_OK);
          const require = createRequire(path.join(root, "package.json"));
          const manifestPath = require.resolve("@openai/codex/package.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          if (manifest.name !== "@openai/codex" || typeof manifest.bin?.codex !== "string") {
            throw new Error("resolved @openai/codex manifest does not declare a codex bin");
          }
          const packageBin = path.resolve(path.dirname(manifestPath), manifest.bin.codex);
          accessSync(packageBin, constants.X_OK);
          for (const [command, argv] of [[binPath, [binPath]], [packageBin, [process.execPath, packageBin]]]) {
            const version = execFileSync(argv[0], [...argv.slice(1), "--version"], { encoding: "utf8" }).trim();
            if (!version.includes("codex-cli")) {
              throw new Error(`managed Codex app-server reported unexpected version: ''${version}`);
            }
            console.log(`managed Codex app-server: ''${command} (''${version})`);
          }
          EOF

          # Reproducibility. nix-openclaw links dependencies some packages never
          # declare (strip-ansi, combined-stream, hasown) to the first copy `find`
          # lists, which depends on directory order: 2026.10.3's top-level strip-ansi
          # was 7.2.0 in one build and 6.0.1 in another. Its links are absolute,
          # unlike pnpm's, so point each at the highest version (ties by path).
          pnpm_store="$out/lib/openclaw/node_modules/.pnpm"
          for dep in strip-ansi combined-stream hasown; do
            chosen=$(
              for dir in "$pnpm_store"/*/node_modules/"$dep"; do
                if [ -d "$dir" ] && [ ! -L "$dir" ]; then
                  printf '%s\t%s\n' "$("$node" -p "require(process.argv[1]).version" "$dir/package.json")" "$dir"
                fi
              done | LC_ALL=C ${coreutils}/bin/sort -t "$(printf '\t')" -k1,1V -k2,2 | ${coreutils}/bin/tail -n 1 | ${coreutils}/bin/cut -f2
            )
            [ -n "$chosen" ] || continue
            while IFS= read -r -d "" link; do
              ${coreutils}/bin/ln -sfn "$chosen" "$link"
            done < <(${findutils}/bin/find "$out/lib/openclaw/node_modules" -name "$dep" -type l -lname "$pnpm_store/*" -print0)
          done
          # pnpm's install metadata records when it ran; record the release's build
          # time instead. The test run's Vitest cache is not part of the package.
          while IFS= read -r -d "" pnpm_meta; do
            "$node" -e '
              const fs = require("node:fs");
              const [file, stamp] = process.argv.slice(1);
              const data = JSON.parse(fs.readFileSync(file, "utf8"));
              if ("prunedAt" in data) data.prunedAt = new Date(stamp).toUTCString();
              if ("lastValidatedTimestamp" in data) data.lastValidatedTimestamp = Date.parse(stamp);
              fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
            ' "$pnpm_meta" ${lib.escapeShellArg buildTimestamp}
          done < <(${findutils}/bin/find "$out/lib/openclaw" \( -name .modules.yaml -o -name .pnpm-workspace-state-v1.json \) -type f -print0)
          rm -rf "$out/lib/openclaw/node_modules/.vite"

          ${extraInstallCommands}

          # The launcher. Nix mode and the persisted-registry switch default on;
          # host state checks belong to state-fence.nix.
          cat >"$out/bin/openclaw" <<'EOF'
          #!${bashNonInteractive}/bin/bash
          set -euo pipefail
          export OPENCLAW_NIX_MODE="''${OPENCLAW_NIX_MODE:-1}"
          export OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY="''${OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY:-1}"
          self_dir="$(${coreutils}/bin/dirname -- "$(${coreutils}/bin/realpath -e -- "$0")")"
          exec ${node}/bin/node "$self_dir/../lib/openclaw/dist/index.js" "$@"
          EOF
          chmod 0555 "$out/bin/openclaw"
        '';
      passthru =
        (old.passthru or {})
        // {
          inherit node upstreamVersion localRevision;
          releaseChannel = "stable";
          upstreamTag = "v${upstreamVersion}";
          # The pristine tree, for files the npm package ships but this layout
          # does not install (the hotfix layer's cloud-worker node bootstrap).
          upstreamSource = upstreamSrc;
          upstreamRev = rev;
          # Runtime plugins that 2026.10.x ships bundled at the release version.
          upstreamBundledRuntimePlugins = ["acpx" "codex"];
          sourcePatches = map (p: p.name) sourcePatches;
          buildIdentity = {
            commit = rev;
            timestamp = buildTimestamp;
            buildId = controlUiBuildId;
          };
        };
      meta =
        (old.meta or {})
        // {
          description = "OpenClaw ${upstreamVersion} gateway, built from source for Nix";
          homepage = "https://github.com/openclaw/openclaw/commit/${rev}";
          priority = 10;
        };
    })
