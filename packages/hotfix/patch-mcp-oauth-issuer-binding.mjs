// MCP OAuth: @modelcontextprotocol/sdk (1.31.0 on) stamps the client information and
// tokens it hands to saveClientInformation()/saveTokens() with `issuer`, the
// authorization server it used, and discards a stamped value read back for another
// server (CVE-2026-104850, GHSA-6qxp-vccf-f47h). A value without a stamp, saved by an
// earlier SDK, is still used as-is and bound to the first authorization server that
// answers, so a resource server that advertises a different one gets the saved
// client (and its secret, if any) and refresh token. OpenClaw's provider hands its
// stored values to the SDK unchanged, stamp or not.
//
// Treat a stored client or token set without an issuer as absent. During a login
// (redirect allowed) the SDK then registers again and asks for authorization, and
// the new values carry the stamp: OpenClaw's store persists them verbatim. Outside a
// login an unstamped client fails with the provider's own "requires OAuth
// authorization. Run openclaw mcp login" error instead of a background
// re-registration. Stamped values pass through for the SDK to check. A fresh access
// token is still sent to its own MCP server until it expires: only the refresh,
// registration and code exchange reach the authorization server, and they all go
// through these two methods.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const [root, version] = process.argv.slice(2);
// Qualified from this release on; anchors below fail if upstream moves the code.
const atLeast = (version, minimum) => { const a = String(version).split(".").map(Number), b = minimum.split(".").map(Number); for (let i = 0; i < b.length; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) > b[i]; return true; };
assert(root && atLeast(version, "2026.10.5"), "MCP OAuth issuer binding hotfix is qualified from 2026.10.5");
const dist = path.join(root, "dist");

const MARKER = "/* openclaw-nix-mcp-oauth-issuer-binding-v1 */";
const HELPER = "openclawNixMcpOAuthIssuerBound";
const helper = [
  `function ${HELPER}(saved, unbound) { ${MARKER}`,
  "\tif (saved == null || typeof saved.issuer === \"string\" && saved.issuer.length > 0) return saved;",
  "\tunbound?.();",
  "}",
].join("\n");
const FACTORY = "async function createMcpOAuthClientProvider(";
// The source form and the minified worker copies. clientInformation() reads the
// store, asks for a redirect when the tokens' own issuer binding fails, then takes
// store.clientInformation; tokens() returns store.tokens when that binding holds.
const clientRead = /(async clientInformation\(\)\s*\{\s*(?:const|let)\s+([\w$]+)\s*=\s*await readStore\(\);\s*[\w$]+\.login\?\.assertCurrent\(\)[;,]\s*(?:if\s*\(\s*!canReuseStoredTokens\(\2\)\s*\)\s*|canReuseStoredTokens\(\2\)\s*\|\|\s*)assertAuthorizationRedirectAllowed\(\);\s*(?:const|let)\s+[\w$]+\s*=\s*)\2\.clientInformation;/g;
const tokensRead = /(async tokens\(\)\s*\{[^]{0,400}?(?:const|let)\s+([\w$]+)\s*=\s*await readStore\(\);\s*(?:[\w$]+\.login\?\.assertCurrent\(\);\s*return\s*|return\s*[\w$]+\.login\?\.assertCurrent\(\)\s*,\s*)canReuseStoredTokens\(\2\)\s*\?\s*)\2\.tokens(\s*:\s*void 0)/g;
const count = (text, needle) => text.split(needle).length - 1;

function* scripts(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") yield* scripts(file);
    else if (entry.isFile() && /\.m?js$/.test(entry.name)) yield file;
  }
}

const patchedFiles = [];
for (const file of scripts(dist)) {
  const text = fs.readFileSync(file, "utf8");
  const definitions = count(text, FACTORY);
  if (definitions === 0) continue;
  const name = path.relative(root, file);
  assert.equal(definitions, 1, `createMcpOAuthClientProvider repeated in ${name}`);
  assert.equal(count(text, MARKER), 0, `${name} is already patched`);
  assert.equal(count(text, `function ${HELPER}(`), 0, `${HELPER} already defined in ${name}`);
  let clients = 0, tokens = 0;
  let patched = text.replace(clientRead, (match, head, store) => {
    clients += 1;
    return `${head}${HELPER}(${store}.clientInformation, assertAuthorizationRedirectAllowed);`;
  });
  patched = patched.replace(tokensRead, (match, head, store, tail) => {
    tokens += 1;
    return `${head}${HELPER}(${store}.tokens)${tail}`;
  });
  assert.equal(clients, 1, `MCP OAuth clientInformation() anchor changed in ${name}`);
  assert.equal(tokens, 1, `MCP OAuth tokens() anchor changed in ${name}`);
  // A declaration before the factory's: same scope, and not after an `export`.
  const at = patched.indexOf(FACTORY);
  assert(!/export\s*$/.test(patched.slice(Math.max(0, at - 16), at)), `createMcpOAuthClientProvider is exported inline in ${name}`);
  fs.writeFileSync(file, `${patched.slice(0, at)}${helper}\n${patched.slice(at)}`);
  patchedFiles.push(name);
}
assert(patchedFiles.some((name) => /^dist\/mcp-oauth-[^/]+\.mjs$/.test(name)), "MCP OAuth provider chunk not patched");

fs.writeFileSync(path.join(root, ".mcp-oauth-issuer-binding-hotfix.json"), JSON.stringify({
  id: "openclaw-nix-mcp-oauth-issuer-binding-v1", upstreamVersion: version, patchedFiles,
}, null, 2) + "\n");
console.log(`MCP OAuth: unstamped clients and tokens read as absent in ${patchedFiles.join(", ")}`);
