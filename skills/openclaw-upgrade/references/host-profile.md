# Host profile

A host profile is a directory the host installs with this skill:

```nix
skill = openclaw-nix.lib.mkUpgradeSkill {
  inherit pkgs;
  hostProfile = ./openclaw-upgrade-host;
};
```

Its files are added to the skill's directory. It may add files but never replace one of
the skill's own; the build fails if it tries. It must provide `references/host.md`, and
usually `scripts/host.env`. Install the result where agents load skills (an OpenClaw
skill root, `~/.claude/skills/openclaw-upgrade/`), as regular files, synced with
`rsync --checksum`.

## references/host.md

One file an agent can act on without the conversation that wrote it. Sections:

- **Authority**: who approves activation, gateway restarts, pushes and cloud changes,
  and which agents must never restart which gateway.
- **Repository**: where the host's configuration lives, how to make a worktree, how the
  `openclaw-nix` input is updated, and what may not be edited (a canonical checkout, for
  example).
- **Instances**: one row per gateway: name, unit, state directory and config file, the
  package attribute it runs, follows or frozen, keep-old on activation or not, its CLI
  wrapper, and the agent and expected model of its canary.
- **Build**: the candidate's attributes, memory limits, and anything else heavy that
  runs on the host.
- **Checks**: the contracts to build for a release, including the one asserting the
  compile is openclaw-nix's own, and how to batch them.
- **Activation**: the command, what it restarts, how to watch it finish, and how to
  restart a keep-old instance.
- **Verification**: the version check, the canaries and the native UI check, with exact
  commands; secrets go through the environment, never argv.
- **Hazards and history**: incidents, timings and standing decisions particular to the
  host, with dates.

## scripts/host.env

Bash, sourced by the generic scripts. Plain `KEY="words"` values are also read by
`check-plugin-sdk-imports.py`.

| Key | Used by | Default |
|---|---|---|
| `OPENCLAW_UPGRADE_STATE_DIR_PATTERN` | qualify-candidate.sh: an instance's state dir (`printf` pattern) | `$HOME/.openclaw-%s` |
| `OPENCLAW_UPGRADE_CONFIG_NAME` | qualify-candidate.sh: the config file in it | `openclaw.json` |
| `OPENCLAW_UPGRADE_BACKUP_ROOT` | qualify-candidate.sh, scratch-patch-chain.sh: output root | `$HOME/openclaw-backups` |
| `OPENCLAW_UPGRADE_SCRATCH_ROOT` | qualify-candidate.sh, scratch-patch-chain.sh: working copies (put it where snapshots do not pin them) | the backup root |
| `OPENCLAW_UPGRADE_INSTALLED_BIN` | qualify-candidate.sh `QUAL_ARCHIVE=1`: the installed binary | none |
| `OPENCLAW_UPGRADE_HOTFIX_ATTR` | scratch-patch-chain.sh: the host's hotfixed package | `.#gateway-hotfixed` |
| `OPENCLAW_UPGRADE_PLUGIN_DIRS` | check-plugin-sdk-imports.py: repo dirs with plugins | the whole repo |
| `OPENCLAW_UPGRADE_PLUGIN_INPUTS` | check-plugin-sdk-imports.py: plugin flake inputs | none |

Host-only scripts (version checks, canaries) go in the profile's `scripts/` too, next to
the generic ones.
