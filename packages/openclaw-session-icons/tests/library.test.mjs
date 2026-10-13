// Manifest ↔ browser entry consistency, the one session action, and the saved
// icon values. These run inside the Nix build before the `openclaw` peer
// symlink exists, so index.js is checked as source text.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");
const manifest = async () => JSON.parse(await read("../openclaw.plugin.json"));
const browser = async () => import(new URL(`../${(await manifest()).controlUi.entry}`, import.meta.url));

test("manifest id, package entry and browser entry agree", async () => {
  const m = await manifest();
  assert.equal(m.id, "session-icons");
  const pkg = JSON.parse(await read("../package.json"));
  assert.deepEqual(pkg.openclaw.runtimeExtensions, ["./index.js"]);
  // The gateway's own rule: a JS file under dist/control-ui, styles beside it.
  assert.match(m.controlUi.entry, /^dist\/control-ui\/[\w-][\w.-]*\.js$/);
  for (const style of m.controlUi.styles) {
    assert.match(style, /^dist\/control-ui\/[\w-][\w.-]*\.css$/);
    await fs.access(new URL(`../${style}`, import.meta.url));
  }
  const ui = await browser();
  assert.equal(ui.default.id, m.id, "the browser entry must export the manifest's plugin id");
  assert.equal(typeof ui.default.activate, "function");
});

test("the browser entry is one plain module the gateway can serve as-is", async () => {
  const source = await read(`../${(await manifest()).controlUi.entry}`);
  assert.doesNotMatch(source, /^\s*import\s/m, "no imports: the gateway serves only the entry and its styles");
});

test("the backend registers nothing", async () => {
  const source = await read("../index.js");
  assert.match(source, /from "openclaw\/plugin-sdk\/plugin-entry"/);
  assert.match(source, /id: "session-icons"/);
  assert.match(source, /register\(\) \{\}/);
});

test("activation registers one session-menu action and nothing else", async () => {
  const ui = await browser();
  const actions = [];
  const fail = (name) => () => assert.fail(`unexpected host.ui.${name}`);
  const host = {
    connection: {canWrite: true},
    request: () => assert.fail("activation must not call the gateway"),
    ui: {
      registerAction: (action) => {
        actions.push(action);
        return () => {};
      },
      registerReplacement: fail("registerReplacement"),
      registerPage: fail("registerPage"),
      registerPanel: fail("registerPanel"),
      registerNavigation: fail("registerNavigation"),
      registerAccessory: fail("registerAccessory"),
      registerWidget: fail("registerWidget"),
    },
  };
  const dispose = ui.default.activate(host);
  assert.equal(typeof dispose, "function");
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action.placement, "session");
  assert.equal(action.label, "Icon library…");
  assert.deepEqual(action.resolve({sessionKey: "agent:main:main"}), {disabled: false});
  host.connection.canWrite = false;
  assert.deepEqual(action.resolve({sessionKey: "agent:main:main"}), {disabled: true});
});

test("every icon has a unique id and a self-contained SVG within the gateway's limit", async () => {
  const {catalog} = await browser();
  const icons = catalog();
  assert.equal(icons.length, 72);
  assert.equal(new Set(icons.map((icon) => icon.id)).size, icons.length);
  assert.equal(new Set(icons.map((icon) => icon.group)).size, 9);
  for (const icon of icons) {
    for (const value of [icon.value, icon.legacyValue]) {
      assert.ok(value.startsWith("data:image/svg+xml,"), icon.id);
      const source = decodeURIComponent(value.slice("data:image/svg+xml,".length));
      // SESSION_ICON_SVG_MAX_BYTES in the gateway protocol.
      assert.ok(new TextEncoder().encode(source).byteLength <= 16 * 1024, icon.id);
      assert.doesNotMatch(source, /<script|href=|url\(/i, icon.id);
    }
  }
});

test("saved values keep their exact encoding, so icons sessions already have still match", async () => {
  const {catalog} = await browser();
  const aircraft = catalog().find((icon) => icon.id === "aircraft");
  const colour = decodeURIComponent(aircraft.value.slice("data:image/svg+xml,".length));
  assert.ok(colour.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2 5v4l8 5v3l-8-3v4l3 2H7l3-2v-4l-8 3v-3l8-5V7Z" fill="#38bdf8"/>'));
  assert.equal(aircraft.value, `data:image/svg+xml,${encodeURIComponent(colour)}`);
  assert.equal(
    aircraft.legacyValue,
    `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#7a92c2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18m0-17 2 3v4l7 5v2l-7-2v3l3 2H7l3-2v-3l-7 2v-2l7-5V7Z"/></svg>')}`,
  );
});

test("search matches every term against label, group and keywords", async () => {
  const {searchIcons, catalog} = await browser();
  assert.equal(searchIcons("").length, catalog().length);
  assert.deepEqual(searchIcons("flight").map((icon) => icon.id), ["aircraft", "telemetry"]);
  assert.ok(searchIcons("AI agent").some((icon) => icon.id === "agent"));
  assert.ok(searchIcons("  Aerospace   SIMULATION ").length >= 8);
  assert.deepEqual(searchIcons("no-such-icon"), []);
});

test("a choice is the current icon in either encoding, and saves the colour one", async () => {
  const {catalog, isSelected, iconPatch} = await browser();
  const [icon, other] = catalog();
  assert.ok(isSelected(icon.value, icon));
  assert.ok(isSelected(icon.legacyValue, icon));
  assert.ok(!isSelected(other.value, icon));
  assert.ok(!isSelected(null, icon));
  assert.deepEqual(iconPatch({sessionKey: "agent:main:main", agentId: "main"}, icon), {
    key: "agent:main:main",
    agentId: "main",
    icon: icon.value,
  });
  assert.deepEqual(iconPatch({sessionKey: "agent:main:main"}, icon), {key: "agent:main:main", icon: icon.value});
});
