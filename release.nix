# The OpenClaw release this package set builds. Every package the overlay
# exports (gateway, CLI, runtime plugins) derives from `current`, and
# `checkSingleRelease` fails a closure that carries any other OpenClaw version.
#
# scripts/new-release.py <version> adds the release to releases.nix and moves
# `current`; the previous release stays in `accepted` so a consumer can keep a
# recovery instance one release behind.
{
  current = "2026.10.4";
  accepted = ["2026.10.1" "2026.10.2" "2026.10.3" "2026.10.4"];
}
