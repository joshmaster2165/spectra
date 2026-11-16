/**
 * Where Spectra's own files are. It runs in two layouts:
 *
 *   source   — a checkout of the repository, run through tsx (`npm start`).
 *   bundled  — the built `dist/` folder of the installed `spectra` command.
 *
 * The build sets `__SPECTRA_BUNDLED__`; nothing else tells the two apart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __SPECTRA_BUNDLED__: boolean | undefined;
declare const __SPECTRA_VERSION__: string | undefined;

export const BUNDLED = typeof __SPECTRA_BUNDLED__ !== "undefined";
export const VERSION = typeof __SPECTRA_VERSION__ !== "undefined" ? __SPECTRA_VERSION__ : "dev";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository root in a checkout; the `dist/` folder when installed. */
const ROOT = BUNDLED ? HERE : path.resolve(HERE, "../../..");

/** Spectra's own folder for settings, audit logs and the copies `spectra init` installs. */
export const HOME = process.env.SPECTRA_HOME ? path.resolve(process.env.SPECTRA_HOME) : path.join(os.homedir(), ".spectra");
export const DATA_DIR = process.env.SPECTRA_DATA_DIR ?? path.join(HOME, "sessions");
export const SETTINGS_FILE = process.env.SPECTRA_SETTINGS ?? path.join(HOME, "settings.json");

/** The built dashboard. */
export const WEB_DIST = BUNDLED ? path.join(ROOT, "web") : path.join(ROOT, "packages", "web", "dist");
/** The proxy history the demos import. */
export const EXAMPLE_HAR = path.join(ROOT, "examples", "acme-shop.har");

/**
 * The scope config file. `SPECTRA_CONFIG` wins. A checkout uses the one at the repository root;
 * the installed command looks in the folder it was started from, then in Spectra's own folder.
 */
export function configFile(): string {
  if (process.env.SPECTRA_CONFIG) return process.env.SPECTRA_CONFIG;
  if (!BUNDLED) return path.join(ROOT, "spectra.config.json");
  const local = path.join(process.cwd(), "spectra.config.json");
  return fs.existsSync(local) ? local : path.join(HOME, "spectra.config.json");
}

/** The hook script Claude Code runs. Dependency-free, so it can be copied anywhere. */
export const HOOK_SCRIPT = BUNDLED ? path.join(ROOT, "spectra-hook.mjs") : path.join(ROOT, "packages", "server", "bin", "spectra-hook.mjs");

/** The file behind each `spectra` subcommand, in this layout. */
export function entry(name: "hub" | "mcp" | "demo" | "demo-recon" | "verify" | "import" | "navigator"): string {
  if (BUNDLED) return path.join(ROOT, `${name}.js`);
  const source = { hub: "index", navigator: "validator" } as Record<string, string>;
  return path.join(HERE, `${source[name] ?? name}.ts`);
}
