# openclaw-nix's init (`nix run github:alinaos-org/openclaw-nix#init -- <dir>`): one
# person's laptop flake from the starter template (init.py). nix, nixos-version and
# nixos-generate-config come from the machine it runs on.
{
  lib,
  runCommand,
  makeWrapper,
  python3,
  sops,
  age,
  ssh-to-age,
  git,
  mkpasswd,
  template,
}:
runCommand "openclaw-nix-init" {
  nativeBuildInputs = [makeWrapper];
  meta.mainProgram = "openclaw-nix-init";
} ''
  install -Dm644 ${./init.py} $out/libexec/openclaw-nix-init.py
  makeWrapper ${python3}/bin/python3 $out/bin/openclaw-nix-init \
    --add-flags "-I $out/libexec/openclaw-nix-init.py" \
    --prefix PATH : ${lib.makeBinPath [sops age ssh-to-age git mkpasswd]} \
    --set-default OPENCLAW_NIX_TEMPLATE ${template}
''
