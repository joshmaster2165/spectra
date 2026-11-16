import fs from "node:fs";
import path from "node:path";
import { Hub } from "./hub.ts";
import { startObserver } from "./observer.ts";
import { loadScopeConfig } from "./scope.ts";
import { createNotifier } from "./alerts.ts";
import { BUNDLED, configFile, DATA_DIR, SETTINGS_FILE as SETTINGS, WEB_DIST } from "./paths.ts";

const PORT = Number(process.env.SPECTRA_PORT ?? 4317);
const CONFIG = configFile();
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
  installed: BUNDLED,
});
try {
  await hub.listen(PORT);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
  console.error(`[spectra] port ${PORT} is already in use. Is Spectra already running? Open http://127.0.0.1:${PORT}, or start this one on another port with SPECTRA_PORT.`);
  process.exit(1);
}

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
