// Build-time repair for esbuild 0.28.2: retain ownership until its service exits.
// stop() otherwise kills an unreferenced child and immediately returns, allowing
// the asset command to exit before that child is reaped. Do not relax the caller's
// managed-process-group guard.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "package.json"));
const entry = require.resolve("esbuild");
const source = fs.readFileSync(entry, "utf8");
const anchor = "  stopService = () => {\n    stdin.destroy();";
if (source.split(anchor).length !== 2) {
  throw new Error("esbuild service shutdown shape changed; requalify ownership fix");
}
fs.writeFileSync(entry, source.replace(anchor,
  "  stopService = () => {\n    child.ref(); // Join the signaled service before the owner exits.\n    stdin.destroy();"));
