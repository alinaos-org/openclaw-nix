# @HOSTNAME@

@FULL_NAME@'s NixOS laptop with OpenClaw, from
[openclaw-nix](https://github.com/alinaos-org/openclaw-nix)'s starter.

| File | What it is |
| --- | --- |
| `host.nix` | The machine and its user. Add your desktop and packages here. |
| `openclaw.nix` | The gateway (`openclaw-gateway-main`, a user unit) and its secrets. |
| `openclaw/main.json` | What the agents do: models, agents, channels. Secrets only as `${VAR}`. |
| `secrets/openclaw.yaml` | The secrets, encrypted for this machine and you (`.sops.yaml`). |
| `hardware-configuration.nix` | This machine's disks and drivers. |

## First switch

```sh
git add -A                 # flakes only see tracked files
sudo nixos-rebuild switch --flake .#@HOSTNAME@
openclaw-doctor            # what is missing, and how to fix it
```

If you sign in with a subscription instead of an API key, do it once after the
first switch, as yourself:

```sh
oc-main models auth login --provider openai --device-code
```

## Secrets

`sops secrets/openclaw.yaml` opens the secrets decrypted in your editor and encrypts
them again on save. Never commit a decrypted copy. The gateway reads them from
`/run/secrets/rendered/openclaw.env`, which only you can read.

## Updates

`nix flake update openclaw-nix` moves you to openclaw-nix's latest release (the
gateway comes from its cache), then rebuild and run `openclaw-doctor`. Each release
says in its notes what changed.
