#!/usr/bin/env bash
# CI: generate a laptop flake with init, as a teammate does, and evaluate its whole
# NixOS system against this checkout of openclaw-nix (--override-input), so a change
# that breaks the template or init fails here, not on someone's laptop.
#
#   tests/starter/eval-generated.sh
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
age() { nix shell --inputs-from "$repo" nixpkgs#age -c "$@"; }

age age-keygen -o "$work/key.txt" 2> /dev/null
cat > "$work/hardware-configuration.nix" <<'NIX'
{lib, ...}: {
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };
  fileSystems."/boot" = {
    device = "/dev/disk/by-label/boot";
    fsType = "vfat";
  };
}
NIX
for auth in api-key subscription; do
  out="$work/laptop-$auth"
  echo 'sk-ci-provider' | nix run "$repo#init" -- "$out" --non-interactive \
    --user alice --full-name 'Alice Example' --hostname laptop --time-zone UTC \
    --provider openai --auth "$auth" --state-version 25.11 --openclaw-nix-ref ci \
    --hardware-config "$work/hardware-configuration.nix" \
    --host-age-recipient "$(age age-keygen -y "$work/key.txt")" --age-key-file "$work/key.txt" \
    --provider-key-stdin
  drv=$(cd "$out" && nix eval --raw --no-write-lock-file --override-input openclaw-nix "path:$repo" \
    .#nixosConfigurations.laptop.config.system.build.toplevel.drvPath)
  echo "$auth: $drv"
done
