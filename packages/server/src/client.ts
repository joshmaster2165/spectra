/**
 * What the command-line clients (the demos and the importer) share: where the hub is, and what to
 * say when it isn't there.
 */
import { BUNDLED } from "./paths.ts";

export const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";

/** The command that starts the hub, as this user would type it. */
const START = !BUNDLED ? "npm start" : process.env.npm_command === "exec" ? "npx github:joshmaster2165/spectra" : "spectra start";

export const HUB_DOWN = `Can't reach the hub at ${HUB}. Start it with ${START}.`;

/** Stops with a plain message, not a stack trace, when no hub is listening. */
export async function requireHub(): Promise<void> {
  try {
    const res = await fetch(`${HUB}/state`);
    await res.body?.cancel();
  } catch {
    console.error(HUB_DOWN);
    process.exit(1);
  }
}
