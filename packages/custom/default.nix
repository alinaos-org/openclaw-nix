# A consumer's own changes, applied to a copy of a finished gateway tree, so the
# source build stays the one this flake's CI builds and its cache serves. Same
# copy discipline as the hotfix layer (../hotfix): a real copy keeps
# worker-relative imports and bundled-plugin trust boundaries intact, and is
# self-contained (../copy-layer.nix).
{
  lib,
  stdenvNoCC,
  gateway,
  # Bundled channel plugins that an external plugin with the same channel id
  # replaces. Their bundled copies are removed and their entries dropped from
  # the bundled channel config metadata, so config validation, aliases and
  # discovery defer to the external plugin's own schema. (Upstream `preferOver`
  # settles plugin ownership, but the base config validator still applies the
  # bundled channel's schema first.)
  replaceBundledChannels ? [],
  # Shell run last on the copy, with $out, $root (= $out/lib/openclaw) and
  # $node (the gateway's Node) set.
  extraCommands ? "",
}: let
  node = "${gateway.passthru.node}/bin/node";
  copyLayer = import ../copy-layer.nix {inherit lib;};
in
  assert lib.assertMsg (replaceBundledChannels != [] || extraCommands != "")
  "openclaw-nix: the customize layer has nothing to apply";
    stdenvNoCC.mkDerivation {
      pname = "openclaw-gateway-custom";
      inherit (gateway) version;
      dontUnpack = true;
      phases = ["installPhase"];
      # The finished tree leads to no tree it was copied from.
      disallowedRequisites = copyLayer.pathsOf (copyLayer.treesOf gateway);
      installPhase =
        ''
          ${copyLayer.copyTree gateway}
          root="$out/lib/openclaw"
          node=${node}
        ''
        + lib.optionalString (replaceBundledChannels != []) ''
          ${node} ${./replace-bundled-channels.mjs} "$root" ${lib.escapeShellArgs replaceBundledChannels}
          ${node} ${./test-replace-bundled-channels.mjs} "$root" ${lib.escapeShellArgs replaceBundledChannels}
        ''
        + extraCommands;
      passthru =
        (gateway.passthru or {})
        // {
          customizations = {
            inherit replaceBundledChannels;
            extraCommands = extraCommands != "";
          };
          uncustomizedGateway = gateway;
          # A later layer that changes the tree (a plugin graft) can extend this
          # copy instead of making another one.
          copyLayerOf = gateway;
        };
      meta = gateway.meta or {};
    }
