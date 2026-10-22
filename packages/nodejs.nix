# The Node the gateway is built, tested and run on: nixpkgs' Node 24, raised to
# the release OpenClaw requires while nixpkgs is behind it.
#
# 2026.10.6 refuses to start on Node older than 24.22.1 (src/infra/runtime-guard.ts):
# the October 2026 security release, which rejects TLS chains containing blocked
# public keys. nixpkgs has 24.22.1 on staging only (NixOS/nixpkgs#576777), and its
# 24.22.0 and 24.22.1 bumps changed the version and source hash and nothing else,
# so this is nixpkgs' own build of the newer source. 24.22.1 also exposes a brotli
# constant from brotli 1.2.1's fix for the same CVE (CVE-2026-111497), so it links
# brotli 1.2.1, which staging has too (NixOS/nixpkgs#577208, again the version and
# hash only); nixpkgs' Node links the system brotli, 1.2.0 here. Once this flake's
# nixpkgs has a Node 24 at the floor, this is nixpkgs' nodejs_24, unchanged.
#
# Only the OpenClaw build uses it (overlay.nix passes it to packages/gateway, whose
# hotfix and copy layers run their tests on it too): the rest of a consumer's system
# keeps its nodejs_24 and brotli.
{
  lib,
  path,
  callPackage,
  fetchurl,
  fetchFromGitHub,
  brotli,
  nodejs_24,
  nodejs-slim_24,
}: let
  floor = {
    version = "24.22.1";
    # https://nodejs.org/dist/v24.22.1/SHASUMS256.txt, node-v24.22.1.tar.xz
    sha256 = "4f5379796280cdaeb0c2f358fd04b6a16cc4fb7dfa83b5a8c91a9d963b435231";
  };
  floorBrotli =
    if lib.versionAtLeast brotli.version "1.2.1"
    then brotli
    else
      brotli.overrideAttrs (_: {
        version = "1.2.1";
        src = fetchFromGitHub {
          owner = "google";
          repo = "brotli";
          tag = "v1.2.1";
          hash = "sha256-llY72cYffDv0ugsH0p89xIPEbElV4L8u7U/Fe8hT3gI=";
        };
      });
in
  if lib.versionAtLeast nodejs-slim_24.version floor.version
  then nodejs_24
  else
    callPackage "${path}/pkgs/development/web/nodejs/symlink.nix" {
      # nixpkgs' v24.nix builds with `callPackage ./nodejs.nix`: hand that call the
      # newer brotli.
      nodejs-slim =
        (nodejs-slim_24.override {
          callPackage = fn: args: callPackage fn (args // {brotli = floorBrotli;});
        }).overrideAttrs (_: {
          inherit (floor) version;
          src = fetchurl {
            url = "https://nodejs.org/dist/v${floor.version}/node-v${floor.version}.tar.xz";
            inherit (floor) sha256;
          };
        });
    }
