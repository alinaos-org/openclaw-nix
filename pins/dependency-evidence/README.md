# Dependency evidence for fast-track releases

When a release omits its dependency-evidence asset, generate the npm package-lock
report from the exact OpenClaw revision pinned in `releases.nix` using upstream's
`scripts/npm-package-locks-report.mts`. Commit the evidence zip here as
`openclaw-<version>-dependency-evidence.zip`, then run
`scripts/generate-plugin-locks.sh <version>` to regenerate the plugin locks.

The generator records the SHA-256 of the zip bytes in each lock that uses it.
For the current release, CI accepts those override records only when their
`assetNixHash` matches the SRI SHA-256 of that release's committed zip.

## 2026.11.9

v2026.11.9 shipped through upstream's fast-track path, and its release has no
dependency-evidence asset (11.8 has one). `openclaw-2026.11.9-dependency-evidence.zip`
was generated on 2026-11-24 like this:

- From a clean `git clone --depth 1 --branch v2026.11.9` of openclaw/openclaw, whose
  HEAD is `0032b1d7ffd0a59afdf7d2223d8df3250df9057e`, the `rev` in `releases.nix`.
- With that tree's own `scripts/npm-package-locks-report.mts`, on Node 24.22.2 and npm
  11.19.1 against registry.npmjs.org (`--jobs 4`).
- The report's helper dependencies were taken from the 2026.11.7 gateway's
  node_modules, plus `@pnpm/parse-overrides` 1001.0.4 and its four dependencies at the
  versions in 11.9's pnpm-lock.yaml.

The zip contains only `npm-package-locks.json`/`.md` and a manifest with
`releaseTag` and `releaseSha`. A `generatedBy` field records the above. Files are
stamped 1980-01-01 and zipped in sorted order with `zip -X`, as upstream does.

It was compared with upstream's 2026.11.8 evidence. Both have the same 52 packages,
with the same entry fields, and the same codex (37) and acpx (223) package trees. The
only version differences are the seven `@openai/codex*` packages, at 0.170.0 in 11.8 and
0.172.0 in 11.9, which is the Codex app-server bump in 11.9's release notes.

SRI SHA-256: `sha256-4ViHZcElpbDuBSHG5lN/9wzDAjRQ4oHH5y3pru5GyAI=`.
