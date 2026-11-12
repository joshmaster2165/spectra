import fs from "node:fs";
import path from "node:path";

/**
 * The current engagement: which recorded sessions are on the live map.
 *
 * The audit logs hold the events; this file only lists the sessions that
 * belong together, so a restarted hub can rebuild the map from their logs
 * instead of starting empty. Starting a new engagement empties the list —
 * the logs themselves stay on disk and remain replayable.
 */

export interface EngagementInfo {
  /** When this engagement began. */
  started: number;
  /** Sessions in the order they joined. */
  sessions: EngagementSession[];
}

export interface EngagementSession {
  id: string;
  /**
   * How many events the session's log already held when it joined. A session
   * that was running before this engagement began only contributes what it
   * recorded afterwards.
   */
  from: number;
}

export class EngagementStore {
  private data: EngagementInfo = { started: Date.now(), sessions: [] };
  private known = new Set<string>();

  constructor(private file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && Array.isArray(raw.sessions)) {
        const sessions: EngagementSession[] = raw.sessions
          .filter((s: any) => s && typeof s.id === "string")
          .map((s: any) => ({ id: s.id, from: Number.isInteger(s.from) && s.from > 0 ? s.from : 0 }));
        this.data = { started: typeof raw.started === "number" ? raw.started : Date.now(), sessions };
        this.known = new Set(sessions.map((s) => s.id));
      }
    } catch {
      // No engagement yet, or an unreadable file: start a new one.
    }
  }

  get(): EngagementInfo {
    return { started: this.data.started, sessions: [...this.data.sessions] };
  }

  has(sessionId: string) {
    return this.known.has(sessionId);
  }

  /** A session's first recorded event puts it in the engagement, from that point in its log. */
  add(sessionId: string, from: number) {
    if (this.known.has(sessionId)) return;
    this.known.add(sessionId);
    this.data.sessions.push({ id: sessionId, from });
    this.save();
  }

  reset() {
    this.data = { started: Date.now(), sessions: [] };
    this.known.clear();
    this.save();
  }

  private save() {
    // Write-then-rename, so a crash mid-write can't leave a half-written list.
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[spectra] couldn't save the engagement: ${err instanceof Error ? err.message : err}`);
    }
  }
}
