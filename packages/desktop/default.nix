# OpenClaw's Linux desktop companion, from the .deb upstream attaches to each
# stable release. It follows release.nix `current` like the gateway does, so a
# host that bumps openclaw-nix moves the app in the same change; the hash is the
# release's desktopDebHash in releases.nix (scripts/new-release.py fills it).
#
# `cli` is the openclaw the app runs for local commands (OPENCLAW_DESKTOP_CLI);
# override it with the host's own wrapper if it has one.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  dpkg,
  wrapGAppsHook3,
  cairo,
  dbus,
  gdk-pixbuf,
  glib,
  gst_all_1,
  gtk3,
  libayatana-appindicator,
  libsoup_3,
  webkitgtk_4_1,
  desktop-file-utils,
  xdg-utils,
  openclaw,
  cli ? openclaw,
}: let
  version = (import ../../release.nix).current;
  release = (import ../../releases.nix).${version};
  system = stdenv.hostPlatform.system;
  hash =
    release.desktopDebHash.${system}
    or (throw "openclaw-nix: releases.nix ${version} has no desktopDebHash.${system}; run scripts/new-release.py --desktop-only ${version}");
in
  stdenv.mkDerivation {
    pname = "openclaw-desktop";
    inherit version;

    src = fetchurl {
      url = "https://github.com/openclaw/openclaw/releases/download/v${version}/OpenClaw-${version}-amd64.deb";
      inherit hash;
    };

    nativeBuildInputs = [autoPatchelfHook dpkg wrapGAppsHook3];

    buildInputs = [
      cairo
      dbus
      gdk-pixbuf
      glib
      gst_all_1.gst-libav
      gst_all_1.gst-plugins-bad
      gst_all_1.gst-plugins-base
      gst_all_1.gst-plugins-good
      gst_all_1.gstreamer
      gtk3
      libayatana-appindicator
      libsoup_3
      webkitgtk_4_1
    ];

    dontBuild = true;

    unpackPhase = ''
      runHook preUnpack
      dpkg-deb -x "$src" source
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -a source/usr/. "$out/"
      substituteInPlace "$out/share/applications/OpenClaw.desktop" \
        --replace-fail 'Exec=openclaw-desktop' 'Exec=openclaw-desktop %U'
      runHook postInstall
    '';

    preFixup = ''
      gappsWrapperArgs+=(
        --set OPENCLAW_DESKTOP_CLI ${cli}/bin/openclaw
        --set WEBKIT_DISABLE_DMABUF_RENDERER 1
        --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [libayatana-appindicator]}
        --prefix PATH : ${lib.makeBinPath [desktop-file-utils xdg-utils]}
      )
    '';

    meta = {
      description = "Official OpenClaw Linux desktop companion";
      homepage = "https://docs.openclaw.ai/platforms/linux";
      license = lib.licenses.mit;
      mainProgram = "openclaw-desktop";
      platforms = ["x86_64-linux"];
    };
  }
