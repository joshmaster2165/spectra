#!/usr/bin/env node
/**
 * Builds `dist/`: everything the installed `spectra` command needs, with no dependencies to
 * install afterwards.
 *
 *   dist/cli.js             the `spectra` command
 *   dist/hub.js …           one self-contained file per program (hub, mcp, demos, import, verify, navigator)
 *   dist/spectra-hook.mjs   the hook Claude Code runs
 *   dist/web/               the built dashboard
 *   dist/examples/          the proxy history the demos import
 *
 * Run by `npm run build:dist`, and by npm itself before packing or installing from git (`prepare`).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages", "server", "src");
const DIST = path.join(ROOT, "dist");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// 1. The dashboard.
const web = spawnSync("npm", ["run", "build", "--workspace", "@spectra/web"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" });
if (web.status !== 0) process.exit(web.status ?? 1);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 2. The programs. Each is bundled whole, so the hook's MCP server can be copied out by itself.
const entries = { cli: "cli.ts", hub: "index.ts", mcp: "mcp.ts", demo: "demo.ts", "demo-recon": "demo-recon.ts", import: "import.ts", verify: "verify.ts", navigator: "validator.ts" };
// Some dependencies are CommonJS and call require(); an ES module has to be given one.
const requireShim = `import { createRequire as __spectraCreateRequire } from "node:module"; const require = __spectraCreateRequire(import.meta.url);`;
for (const [name, file] of Object.entries(entries)) {
  await build({
    entryPoints: [path.join(SRC, file)],
    outfile: path.join(DIST, `${name}.js`),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    legalComments: "none",
    logLevel: "warning",
    // Optional native speed-ups for the WebSocket library; it works without them.
    external: ["bufferutil", "utf-8-validate"],
    define: { __SPECTRA_BUNDLED__: "true", __SPECTRA_VERSION__: JSON.stringify(version) },
    banner: { js: `${name === "cli" ? "#!/usr/bin/env node\n" : ""}${requireShim}` },
  });
}
fs.chmodSync(path.join(DIST, "cli.js"), 0o755);

// 3. The files that are used as they are.
fs.copyFileSync(path.join(ROOT, "packages", "server", "bin", "spectra-hook.mjs"), path.join(DIST, "spectra-hook.mjs"));
fs.cpSync(path.join(ROOT, "packages", "web", "dist"), path.join(DIST, "web"), { recursive: true });
fs.mkdirSync(path.join(DIST, "examples"));
fs.copyFileSync(path.join(ROOT, "examples", "acme-shop.har"), path.join(DIST, "examples", "acme-shop.har"));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`built dist/ (${(size(DIST) / 1e6).toFixed(1)} MB) for spectra ${version}`);
