# openclaw-session-icons

A searchable library of 72 colour session icons in nine groups (aerospace and
simulation, AI and agents, code, home lab, security, business, finance, creative,
life and interests), opened from a session's menu: **Icon library…**.

A choice is saved like a custom icon from the built-in picker: a self-contained
SVG data URL in the session's `icon` field, through the gateway's own
`sessions.patch`. Any Control UI renders it, with or without this plugin, and
the built-in picker still changes or clears it.

## Pieces

- `dist/control-ui/library.js` — the native Control UI entry: one session-menu
  action and its dialog (search, grouped grid, arrow-key navigation). Plain
  browser module with no imports, served by the gateway as-is. The catalog and
  artwork are at the bottom of the file.
- `dist/control-ui/library.css` — the dialog's styles, on the Control UI's theme
  tokens.
- `index.js` — the backend entry, which registers nothing.

## Enabling it

openclaw-nix builds it as `pkgs.openclawRuntimePlugins.session-icons` (the overlay).
With the NixOS module, set `services.openclaw.instances.<name>.sessionIcons.enable`.
Otherwise a gateway needs four things:

- the plugin in `plugins.load.paths`, as a copy outside the store: the gateway refuses
  plugin files that are hardlinks ("unsafe plugin manifest path"), and store
  optimisation hardlinks store files. `prepareConfig`'s `materializePluginsRoot`
  makes the copy and points the load path at it;
- `session-icons` in `plugins.allow`;
- `plugins.entries."session-icons".enabled = true`;
- native plugin UI turned on, **Settings → Labs → Custom plugin UI**
  (`gateway.controlUi.experimental.customPlugins`). nix-openclaw's typed Home Manager
  options reject that key, so set it through the instance's `configOverlay.transform`
  or another jq filter.

## History

The library started on 2026-10-12 as a Control UI source patch in a consumer
repository, which made that host's gateway build its own. As a native plugin the
gateway stays openclaw-nix's shared build, and it moved here so every install can
use it. Saved values are byte-identical to the patch's, including the first build's
one-colour outlines, which still count as their icon. The artwork is original to
this project and shipped under its MIT license.

## Tests

```bash
node --test tests/*.test.mjs
```
