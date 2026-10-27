import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuditVerification, SessionInfo, SpectraEvent } from "@spectra/schema";

/**
 * Hash-chained, append-only audit log: one JSONL file per session.
 *
 * Each line is the event's JSON with three fields appended:
 *   _seq   1, 2, 3, …
 *   _prev  _hash of the previous line (64 zeros for the first)
 *   _hash  sha256(`${_seq}|${_prev}|${eventJson}`)
 *
 * Editing, deleting or reordering any line breaks the chain from that point.
 * Someone able to rewrite the whole file could recompute every hash, so the
 * head hash is surfaced in the dashboard and reports: record it elsewhere and
 * a later rewrite no longer matches.
 */

export const GENESIS = "0".repeat(64);
const CHAIN_FIELDS = ["_seq", "_prev", "_hash"];

export function chainHash(seq: number, prev: string, eventJson: string): string {
  return crypto.createHash("sha256").update(`${seq}|${prev}|${eventJson}`).digest("hex");
}

interface Writer {
  stream: fs.WriteStream;
  seq: number;
  prev: string;
}

export class AuditLog {
  private writers = new Map<string, Writer>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  file(sessionId: string) {
    return path.join(this.dir, `${sessionId.replace(/[^\w.-]/g, "_")}.jsonl`);
  }

  isOpen(sessionId: string) {
    return this.writers.has(sessionId);
  }

  openSessions() {
    return [...this.writers.keys()];
  }

  append(sessionId: string, event: SpectraEvent) {
    const w = this.writer(sessionId);
    const json = JSON.stringify(event);
    const seq = w.seq + 1;
    const hash = chainHash(seq, w.prev, json);
    // Chain fields go last so stripping them restores the exact event JSON.
    w.stream.write(`${json.slice(0, -1)},"_seq":${seq},"_prev":"${w.prev}","_hash":"${hash}"}\n`);
    w.seq = seq;
    w.prev = hash;
  }

  read(sessionId: string): SpectraEvent[] {
    try {
      return fs
        .readFileSync(this.file(sessionId), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => stripChain(JSON.parse(l)));
    } catch {
      return [];
    }
  }

  list(): SessionInfo[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = fs.statSync(path.join(this.dir, f));
        return { id: f.slice(0, -6), events: 0, bytes: stat.size, updated: stat.mtimeMs };
      })
      .sort((a, b) => b.updated - a.updated);
  }

  verify(sessionId: string): AuditVerification {
    return verifyFile(this.file(sessionId));
  }

  /** Continue an existing chain after a restart, or start a new one. */
  private writer(sessionId: string): Writer {
    let w = this.writers.get(sessionId);
    if (w) return w;
    const file = this.file(sessionId);
    const tail = lastLine(file);
    let seq = 0;
    let prev = GENESIS;
    if (tail) {
      const rec = JSON.parse(tail);
      seq = rec._seq ?? 0;
      prev = rec._hash ?? GENESIS;
    }
    w = { stream: fs.createWriteStream(file, { flags: "a", mode: 0o600 }), seq, prev };
    this.writers.set(sessionId, w);
    return w;
  }
}

export function verifyFile(file: string): AuditVerification {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, events: 0, reason: "log file not found" };
  }
  const lines = text.split("\n").filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    const fail = (reason: string): AuditVerification => ({ ok: false, events: i, head: i ? prev : undefined, badLine: i + 1, reason });
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return fail("line is not valid JSON");
    }
    if (typeof rec._hash !== "string") return fail("line has no hash (written before hash chaining, or edited)");
    if (rec._seq !== i + 1) return fail(`sequence number is ${rec._seq}, expected ${i + 1} (line removed or reordered)`);
    if (rec._prev !== prev) return fail("previous-hash link is broken (line removed, inserted or reordered)");
    const json = JSON.stringify(stripChain(rec));
    if (chainHash(i + 1, prev, json) !== rec._hash) return fail("hash mismatch (line contents were changed)");
    prev = rec._hash;
  }
  return { ok: true, events: lines.length, head: lines.length ? prev : undefined };
}

function stripChain<T extends Record<string, unknown>>(rec: T): any {
  const out: Record<string, unknown> = { ...rec };
  for (const k of CHAIN_FIELDS) delete out[k];
  return out;
}

function lastLine(file: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8").split("\n").filter(Boolean).pop();
  } finally {
    fs.closeSync(fd);
  }
}
