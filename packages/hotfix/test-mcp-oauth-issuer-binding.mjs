// Drive every patched copy of OpenClaw's MCP OAuth provider through the packaged
// @modelcontextprotocol/sdk auth(), over OpenClaw's own store mutations and row
// parser in memory and a fake resource and authorization server; no state, no
// network. A saved client and token set without an issuer is not presented to the
// authorization server: a gateway refresh asks for a login, and a login registers
// again and stores stamped values, which the next refresh uses. A set stamped for
// this server refreshes; one stamped for another server reaches the SDK, which
// discards it. The same unstamped set through the provider with the patch reverted
// is refreshed, so the test fails if the patch stops taking effect.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {pathToFileURL} from "node:url";

const [root] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(path.join(root, ".mcp-oauth-issuer-binding-hotfix.json"), "utf8"));
assert.equal(receipt.id, "openclaw-nix-mcp-oauth-issuer-binding-v1");
const MARKER = `/* ${receipt.id} */`;
const HELPER = "openclawNixMcpOAuthIssuerBound";
// The SDK's issuer binding: its refusal to present client information stamped for
// another authorization server. A literal, so it survives minification.
const BINDING = "is bound to authorization server";
const dist = path.join(root, "dist");
const read = (file) => fs.readFileSync(file, "utf8");
const count = (text, needle) => text.split(needle).length - 1;
const escape = (name) => name.replace(/\$/g, "\\$");

// @modelcontextprotocol/sdk/<subpath> as node resolves an ESM import from `from`.
function resolveSdk(from, subpath) {
  for (let dir = path.dirname(from); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, "node_modules", "@modelcontextprotocol", "sdk");
    if (fs.existsSync(path.join(pkg, "package.json"))) {
      const target = JSON.parse(read(path.join(pkg, "package.json"))).exports?.["./*"]?.import;
      assert(typeof target === "string" && target.includes("*"), "SDK subpath exports changed");
      return path.join(pkg, target.replace("*", subpath));
    }
    assert.notEqual(path.dirname(dir), dir, `@modelcontextprotocol/sdk is not resolvable from ${from}`);
  }
}
const importsOf = (source) => [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].map(([, names, from]) => ({
  from, names: names.split(",").map((s) => s.trim().split(/\s+as\s+/)).filter(([name]) => name).map(([name, local]) => ({name, local: local ?? name})),
}));
const importTarget = (file, from) => from.startsWith(".")
  ? path.resolve(path.dirname(file), from)
  : resolveSdk(file, from.replace(/^@modelcontextprotocol\/sdk\//, ""));

// The SDK auth() each copy calls (an import, or bundled in the same file) must carry
// the issuer binding this patch relies on.
function pairedSdk(file, source) {
  const callees = new Set([...source.matchAll(/await\s+([\w$]+)\(\s*[\w$]+\s*,\s*\{\s*serverUrl:/g)].map((m) => m[1]));
  assert.equal(callees.size, 1, `${file}: SDK auth() call sites changed`);
  const [callee] = callees;
  for (const {from, names} of importsOf(source)) {
    if (names.some(({local}) => local === callee)) return importTarget(file, from);
  }
  assert(new RegExp(`function ${escape(callee)}\\(`).test(source), `${file}: ${callee} is neither imported nor defined`);
  return file;
}

// OpenClaw's store: its mutations and the row parser that validates each write.
const sourceName = receipt.patchedFiles.find((name) => /^dist\/mcp-oauth-[^/]+\.mjs$/.test(name));
assert(sourceName, "receipt lacks the MCP OAuth provider chunk");
const sourceFile = path.join(root, sourceName);
async function exported(prefix, name) {
  const hits = fs.readdirSync(dist).filter((f) => f.startsWith(prefix) && f.endsWith(".mjs")).flatMap((f) => {
    const alias = read(path.join(dist, f)).match(new RegExp(`\\b${name} as ([\\w$]+)`))?.[1];
    return alias ? [[f, alias]] : [];
  });
  assert.equal(hits.length, 1, `${name}: one exporting chunk`);
  const fn = (await import(pathToFileURL(path.join(dist, hits[0][0])).href))[hits[0][1]];
  assert.equal(typeof fn, "function", name);
  return fn;
}
const applyMutation = await exported("mcp-oauth-store.mutations-", "applyMcpOAuthMutation");
const parseStore = await exported("mcp-oauth-store.kernel-", "parseMcpOAuthStoreJson");
const stringCoerce = importsOf(read(sourceFile)).find(({names}) => names.some(({local}) => local === "normalizeOptionalString"));
assert(stringCoerce, "normalizeOptionalString import moved");
const normalizeOptionalString = (await import(pathToFileURL(importTarget(sourceFile, stringCoerce.from)).href))[
  stringCoerce.names.find(({local}) => local === "normalizeOptionalString").name];
const sdkAuthFile = pairedSdk(sourceFile, read(sourceFile));
const {auth} = await import(pathToFileURL(sdkAuthFile).href);
assert.equal(typeof auth, "function", "the SDK's auth()");

function memoryStore(rows) {
  const get = (key) => (rows.has(key) ? parseStore(key, rows.get(key)) : {});
  const put = (key, store) => {
    const json = JSON.stringify(store);
    parseStore(key, json);
    rows.set(key, json);
  };
  return {
    get,
    readMcpOAuthStore: async (key) => get(key),
    mutateMcpOAuthStore: async ({storeKey}, mutation, authority) => {
      const result = applyMutation(get(storeKey), structuredClone(mutation));
      await authority?.beforeCommit?.();
      put(storeKey, result.store);
      return result;
    },
  };
}

// The provider's region of a copy (resolveTokenExpiresAt through the factory), in a
// VM context with the in-memory store; `baseline` reverts this patch's two edits.
function providerFactory(name, source, store, {baseline = false} = {}) {
  const start = source.indexOf("function resolveTokenExpiresAt(");
  const factory = source.indexOf("async function createMcpOAuthClientProvider(");
  assert(start >= 0 && factory > start, `${name}: provider region moved`);
  let region;
  for (let at = factory; !region && (at = source.indexOf("}", at + 1)) !== -1 && at - factory < 60000;) {
    try { new vm.Script(source.slice(start, at + 1)); region = source.slice(start, at + 1); } catch {}
  }
  assert(region, `${name}: provider factory end not found`);
  assert(region.includes(MARKER), `${name}: the issuer helper is outside the provider region`);
  if (baseline) {
    let edits = 0;
    region = region.replace(new RegExp(`${HELPER}\\(([\\w$]+)\\.(clientInformation, assertAuthorizationRedirectAllowed|tokens)\\)`, "g"), (match, local, field) => {
      edits += 1;
      return `${local}.${field.split(",")[0]}`;
    });
    assert.equal(edits, 2, `${name}: baseline reversal failed`);
  }
  const nos = region.match(/clientMetadataUrl:\s*([\w$]+)\(/)?.[1];
  const uuid = region.match(/return\s+([\w$]+)\(\)\s*;?\s*\}\s*,\s*async clientInformation\(\)/)?.[1];
  assert(nos && uuid, `${name}: provider helper names not found`);
  return vm.runInNewContext(`${region}\n;createMcpOAuthClientProvider`, {
    URL, AbortSignal, structuredClone,
    readMcpOAuthStore: store.readMcpOAuthStore,
    mutateMcpOAuthStore: store.mutateMcpOAuthStore,
    [nos]: normalizeOptionalString,
    [uuid]: () => crypto.randomUUID(),
  });
}

// A resource server whose metadata names AS, and AS itself.
const SERVER = "https://mcp.issuer-test.example/mcp";
const AS = "https://auth.issuer-test.example";
const OTHER_AS = "https://elsewhere.issuer-test.example";
function network() {
  const requests = [];
  let registered = 0;
  const json = (status, value) => new Response(JSON.stringify(value), {status, headers: {"content-type": "application/json"}});
  const fetchFn = async (input, init = {}) => {
    const url = new URL(String(input?.url ?? input));
    const method = init.method ?? "GET";
    const body = init.body == null ? "" : String(init.body);
    requests.push({method, url: url.href, body, headers: JSON.stringify([...new Headers(init.headers)])});
    if (url.href === "https://mcp.issuer-test.example/.well-known/oauth-protected-resource/mcp") return json(200, {resource: SERVER, authorization_servers: [AS]});
    if (url.href === `${AS}/.well-known/oauth-authorization-server`) {
      return json(200, {
        issuer: AS, authorization_endpoint: `${AS}/authorize`, token_endpoint: `${AS}/token`, registration_endpoint: `${AS}/register`,
        response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === `${AS}/register` && method === "POST") return json(201, {...JSON.parse(body), client_id: `registered-${++registered}`, client_id_issued_at: 1});
    if (url.href === `${AS}/token` && method === "POST") {
      const grant = new URLSearchParams(body).get("grant_type");
      if (grant === "refresh_token") return json(200, {access_token: "refreshed-access", token_type: "Bearer", expires_in: 3600, refresh_token: "rotated-refresh"});
      if (grant === "authorization_code") return json(200, {access_token: "login-access", token_type: "Bearer", expires_in: 3600, refresh_token: "login-refresh"});
    }
    return new Response("not found", {status: 404});
  };
  const posts = (where) => requests.filter((r) => r.method === "POST" && r.url === where);
  const sent = (secret) => requests.some((r) => r.url.includes(secret) || r.body.includes(secret) || r.headers.includes(secret));
  return {fetchFn, requests, posts, sent};
}

const KEY = "issuer-test";
const REDIRECT = "http://127.0.0.1:8989/oauth/callback";
const saved = (prefix, issuer) => {
  const stamp = issuer ? {issuer} : {};
  return {
    clientInformation: {client_id: `${prefix}-client`, redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...stamp},
    tokens: {access_token: `${prefix}-access`, token_type: "Bearer", refresh_token: `${prefix}-refresh`, ...stamp},
    tokenExpiresAt: 1,
    // OpenClaw's own binding of the refresh token holds, so only the SDK's stamp is tested.
    tokensAuthorizationServerUrl: AS,
    discoveryState: {authorizationServerUrl: AS},
  };
};
const sameIssuer = (a, b) => String(a).replace(/\/$/, "") === String(b).replace(/\/$/, "");
const lease = {assertOwned: async () => {}, signal: new AbortController().signal};
const open = (create, redirect) => create({
  identity: {storeKey: KEY, serverName: KEY, serverUrl: SERVER}, config: {}, lease, storeContext: {},
  ...(redirect ? {allowAuthorizationRedirect: true} : {}),
});
const scenario = (initial) => {
  const rows = new Map();
  if (initial) rows.set(KEY, JSON.stringify(initial));
  return {store: memoryStore(rows), net: network()};
};
const warnings = [];
const quietly = async (run) => {
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try { return await run(); } finally { console.warn = warn; }
};

for (const name of receipt.patchedFiles) {
  const file = path.join(root, name);
  const source = read(file);
  assert.equal(count(source, MARKER), 1, `${name}: marker`);
  assert.equal(count(source, `${HELPER}(`), 3, `${name}: helper and its two uses`);
  const sdk = pairedSdk(file, source);
  assert(read(sdk).includes(BINDING), `${name}: its SDK auth() (${path.relative(root, sdk)}) lacks the issuer binding`);

  // Unstamped, gateway refresh: nothing reaches the authorization server.
  {
    const {store, net} = scenario(saved("unstamped"));
    const provider = await open(providerFactory(name, source, store), false);
    assert.equal(await provider.tokens(), undefined, `${name}: unstamped tokens were returned`);
    await assert.rejects(auth(provider, {serverUrl: SERVER, fetchFn: net.fetchFn}),
      new RegExp(`requires OAuth authorization\\. Run openclaw mcp login ${KEY}`), `${name}: refresh did not ask for a login`);
    assert(!net.sent("unstamped-refresh") && !net.sent("unstamped-client"), `${name}: unstamped credentials were sent`);
    assert.equal(net.requests.filter((r) => r.method === "POST").length, 0, `${name}: a refresh registered or posted`);
    assert.equal(store.get(KEY).clientInformation.client_id, "unstamped-client");
  }
  // The same without the patch: the SDK refreshes with the unstamped set.
  {
    const {store, net} = scenario(saved("unstamped"));
    const provider = await open(providerFactory(name, source, store, {baseline: true}), false);
    assert.equal(await quietly(() => auth(provider, {serverUrl: SERVER, fetchFn: net.fetchFn})), "AUTHORIZED", `${name}: baseline did not refresh`);
    assert(net.posts(`${AS}/token`).some((r) => r.body.includes("unstamped-refresh")), `${name}: baseline did not send the unstamped refresh token`);
  }
  // Unstamped, login: a new registration and authorization, stored stamped; the
  // next gateway refresh uses them.
  {
    const {store, net} = scenario(saved("unstamped"));
    assert.equal(await auth(await open(providerFactory(name, source, store), true), {serverUrl: SERVER, fetchFn: net.fetchFn}), "REDIRECT");
    assert.equal(net.posts(`${AS}/register`).length, 1, `${name}: login did not register again`);
    assert(!net.sent("unstamped-refresh") && !net.sent("unstamped-client"), `${name}: login sent unstamped credentials`);
    let current = store.get(KEY);
    assert.equal(current.clientInformation.client_id, "registered-1");
    assert(sameIssuer(current.clientInformation.issuer, AS), `${name}: registered client stored without its issuer`);
    assert.equal(new URL(current.lastAuthorizationUrl).searchParams.get("client_id"), "registered-1");
    assert.equal(await auth(await open(providerFactory(name, source, store), true), {serverUrl: SERVER, authorizationCode: "code-1", fetchFn: net.fetchFn}), "AUTHORIZED");
    assert(net.posts(`${AS}/token`).some((r) => r.body.includes("grant_type=authorization_code") && r.body.includes("registered-1")));
    current = store.get(KEY);
    assert.equal(current.tokens.access_token, "login-access");
    assert(sameIssuer(current.tokens.issuer, AS), `${name}: login tokens stored without their issuer`);
    const before = net.posts(`${AS}/register`).length;
    assert.equal(await auth(await open(providerFactory(name, source, store), false), {serverUrl: SERVER, fetchFn: net.fetchFn}), "AUTHORIZED", `${name}: refresh after login failed`);
    assert(net.posts(`${AS}/token`).some((r) => r.body.includes("login-refresh") && r.body.includes("registered-1")), `${name}: refresh after login did not use the stamped set`);
    assert.equal(net.posts(`${AS}/register`).length, before, `${name}: refresh after login registered again`);
    assert(sameIssuer(store.get(KEY).tokens.issuer, AS) && store.get(KEY).tokens.access_token === "refreshed-access");
  }
  // Stamped for this authorization server: refreshed.
  {
    const {store, net} = scenario(saved("bound", AS));
    const provider = await open(providerFactory(name, source, store), false);
    assert.equal(await auth(provider, {serverUrl: SERVER, fetchFn: net.fetchFn}), "AUTHORIZED", `${name}: a stamped set was not refreshed`);
    assert(net.posts(`${AS}/token`).some((r) => r.body.includes("bound-refresh") && r.body.includes("bound-client")));
    assert.equal(net.posts(`${AS}/register`).length, 0);
    assert(sameIssuer(store.get(KEY).tokens.issuer, AS));
  }
  // Stamped for another authorization server: passed through, discarded by the SDK.
  {
    const {store, net} = scenario(saved("elsewhere", OTHER_AS));
    const provider = await open(providerFactory(name, source, store), true);
    assert.equal((await provider.clientInformation())?.issuer, OTHER_AS, `${name}: a stamped client was hidden`);
    assert.equal((await provider.tokens())?.issuer, OTHER_AS, `${name}: stamped tokens were hidden`);
    assert.equal(await auth(provider, {serverUrl: SERVER, fetchFn: net.fetchFn}), "REDIRECT");
    assert(!net.sent("elsewhere-refresh") && !net.sent("elsewhere-client"), `${name}: credentials stamped for ${OTHER_AS} were sent to ${AS}`);
    assert.equal(net.posts(`${AS}/register`).length, 1);
  }
}
assert(warnings.some((w) => w.includes("no 'issuer' property")), "the SDK did not flag the baseline's unstamped tokens");
console.log(`MCP OAuth issuer binding: unstamped credentials refused, stamped ones used, mismatches discarded by the SDK in ${receipt.patchedFiles.join(", ")}`);
