import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { startObserver } from "./observer.ts";
import { loadScopeConfig } from "./scope.ts";

const PORT = Number(process.env.SPECTRA_PORT ?? 4317);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG = process.env.SPECTRA_CONFIG ?? path.join(REPO_ROOT, "spectra.config.json");
const DATA_DIR = process.env.SPECTRA_DATA_DIR ?? path.join(os.homedir(), ".spectra", "sessions");
const WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");

const scope = loadScopeConfig(CONFIG);
const hub = new Hub({
  scope,
  dataDir: process.env.SPECTRA_PERSIST === "0" ? undefined : DATA_DIR,
  staticDir: fs.existsSync(path.join(WEB_DIST, "index.html")) ? WEB_DIST : undefined,
});
await hub.listen(PORT);

console.log(`[spectra] hub on http://127.0.0.1:${PORT}`);
if (fs.existsSync(WEB_DIST)) console.log(`[spectra] dashboard on http://127.0.0.1:${PORT}`);
console.log(`[spectra] scope: ${scope.paths?.length ? scope.paths.join(", ") : "each session's working directory"}`);
if (process.env.SPECTRA_PERSIST !== "0") console.log(`[spectra] audit log: ${DATA_DIR}`);

if (process.env.SPECTRA_OBSERVER !== "0") {
  startObserver({
    dir: process.env.SPECTRA_PROJECTS_DIR,
    replay: process.env.SPECTRA_REPLAY === "1",
    emit: (e) => hub.publish(e),
  });
  console.log("[spectra] observing Claude Code transcripts");
}
