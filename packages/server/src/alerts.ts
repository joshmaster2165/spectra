import { execFile } from "node:child_process";
import type { ScopeViolation } from "@spectra/schema";

const MIN_INTERVAL_MS = 5_000;

/**
 * Desktop notification for scope violations, so the operator hears about them
 * without watching the dashboard. macOS (osascript) and Linux (notify-send).
 * Bursts are collapsed: at most one notification every 5 s.
 */
export function createNotifier() {
  let last = 0;
  let suppressed = 0;

  return (v: ScopeViolation) => {
    const now = Date.now();
    if (now - last < MIN_INTERVAL_MS) {
      suppressed++;
      return;
    }
    last = now;
    const more = suppressed ? ` (+${suppressed} more)` : "";
    suppressed = 0;
    const title = `Spectra: out-of-scope ${v.target.access}`;
    const body = `${v.target.value}${more}`;
    notify(title, body);
  };
}

function notify(title: string, body: string) {
  const done = () => {}; // best effort; never throw into the hub
  if (process.platform === "darwin") {
    // Text is passed as argv, never interpolated into the script.
    execFile(
      "osascript",
      ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body],
      done,
    );
  } else if (process.platform === "linux") {
    execFile("notify-send", ["--urgency=critical", title, body], done);
  }
}
