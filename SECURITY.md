# Security policy

## Reporting a vulnerability

Report it privately: on GitHub, **Security → Report a vulnerability** for
`alinaos-org/openclaw-nix`. Please do not open a public issue, pull request or
discussion for it.

Include the affected tag or commit, the output (the gateway build, the hotfix layer, a
module, the config overlay, a plugin, the release pipeline or the cache), and how to
reproduce it. You will get an acknowledgement within five working days, and updates
as it is investigated. A fix ships as a new `<OpenClaw release>-r<N>` tag with a GitHub
security advisory, and a CVE where one applies; we aim for 30 days for a high or
critical issue. You are credited unless you ask not to be.

## Scope

openclaw-nix's own work:

- the gateway build, its hotfix layer (`packages/hotfix`, see its
  [register](packages/hotfix/register.nix)) and the customize layer;
- the state fence;
- the Control UI config overlay (engine, policy, prepare step, fold);
- the NixOS and Home Manager modules, including their service hardening and
  credential handling;
- the plugins in `packages/`;
- CI, the release workflows, the release evidence and the `alinaos-openclaw-nix` cache.

Reported elsewhere:

- **OpenClaw itself:** [OpenClaw's security policy](https://github.com/openclaw/openclaw/security).
  If the issue is in code the hotfix layer patches, tell us too.
- **nix-openclaw** (the base recipe and Home Manager module):
  [its repository](https://github.com/openclaw/nix-openclaw).
- **A third-party dependency:** its own project. Each release's `vulnerabilities.md`
  lists the known matches in the gateway as built; tell us if one is exploitable
  through the gateway, so we can patch or pin around it.

## Supported versions

The latest release tag. Fixes land on `main` and in the next tag; there are no backport
branches (README, "Versions and support"). The previous OpenClaw release stays
buildable for recovery but receives no fixes.
