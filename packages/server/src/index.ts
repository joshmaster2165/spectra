import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hub } from "./hub.ts";
import { startObserver } from "./observer.ts";
import { loadScopeConfig } from "./scope.ts";
import { createNotifier } from "./alerts.ts";

const PORT = Number(process.env.SPECTRA_PORT ?? 4317);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG = process.env.SPECTRA_CONFIG ?? path.join(REPO_ROOT, "spectra.config.json");
const DATA_DIR = process.env.SPECTRA_DATA_DIR ?? path.join(os.homedir(), ".spectra", "sessions");
const WEB_DIST = path.join(REPO_ROOT, "packages", "web", "dist");
const SETTINGS = process.env.SPECTRA_SETTINGS ?? path.join(os.homedir(), ".spectra", "settings.json");
const OBSERVER = process.env.SPECTRA_OBSERVER !== "0";

const scope = loadScopeConfig(CONFIG);
const hub = new Hub({
  scope,
  dataDir: process.env.SPECTRA_PERSIST === "0" ? undefined : DATA_DIR,
  staticDir: fs.existsSync(path.join(WEB_DIST, "index.html")) ? WEB_DIST : undefined,
  onViolation: process.env.SPECTRA_NOTIFY === "0" ? undefined : createNotifier(),
  settingsFile: SETTINGS,
  observer: OBSERVER,
  resume: process.env.SPECTRA_RESUME !== "0",
});
await hub.listen(PORT);

console.log(`[spectra] hub on http://127.0.0.1:${PORT}`);
if (fs.existsSync(WEB_DIST)) console.log(`[spectra] dashboard on http://127.0.0.1:${PORT}`);
console.log(`[spectra] scope: ${scope.paths?.length ? scope.paths.join(", ") : "each session's working directory"}`);
if (process.env.SPECTRA_PERSIST !== "0") console.log(`[spectra] audit log: ${DATA_DIR}`);
if (hub.restored) console.log(`[spectra] restored the engagement: ${hub.restored.events} events from ${hub.restored.sessions} session${hub.restored.sessions === 1 ? "" : "s"}`);

// Flush the audit logs before exiting, so the last events survive a restart.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const done = () => process.exit(0);
    setTimeout(done, 1500).unref();
    void hub.close().then(done, done);
  });
}

if (OBSERVER) {
  startObserver({
    dir: process.env.SPECTRA_PROJECTS_DIR,
    replay: process.env.SPECTRA_REPLAY === "1",
    emit: (e) => hub.publish(e),
  });
  console.log("[spectra] observing Claude Code transcripts");
}
