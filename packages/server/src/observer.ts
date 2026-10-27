import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpectraEvent } from "@spectra/schema";
import { Translator } from "./toolmap.ts";

/**
 * Log Observer: tails Claude Code's session transcripts and turns them
 * into SpectraEvents. Claude Code is never modified — we only read.
 *
 * Claude Code writes one JSONL file per session under
 *   ~/.claude/projects/<project-slug>/<session-id>.jsonl
 * Each line is a record like
 *   { type: "assistant" | "user", sessionId, cwd, message: { content: [...] } }
 * where content blocks include `text`, `thinking`, `tool_use` and `tool_result`.
 * The format is not a public API, so all parsing is defensive. Hooks are the
 * preferred source for tool calls; the observer still supplies reasoning text,
 * which hooks don't carry.
 */

export interface ObserverOptions {
  dir?: string;
  pollMs?: number;
  /** Replay existing files from the start instead of tailing new lines only. */
  replay?: boolean;
  emit: (e: SpectraEvent) => void;
}

type Block = { type: string; [k: string]: any };

export function startObserver(opts: ObserverOptions) {
  const dir = opts.dir ?? path.join(os.homedir(), ".claude", "projects");
  const offsets = new Map<string, number>();
  const translator = new Translator("observer", opts.emit);
  const startedAt = Date.now();

  const scan = () => {
    for (const file of listJsonl(dir)) {
      let size: number, mtime: number;
      try {
        ({ size, mtimeMs: mtime } = fs.statSync(file));
      } catch {
        continue;
      }
      if (!offsets.has(file)) {
        // Skip stale sessions; tail from the end unless replaying.
        if (!opts.replay && mtime < startedAt - 60_000) {
          offsets.set(file, size);
          continue;
        }
        offsets.set(file, opts.replay ? 0 : size);
      }
      const from = offsets.get(file)!;
      if (size <= from) continue;
      const chunk = readRange(file, from, size);
      // Only consume complete lines; keep a partial trailing line for next tick.
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl < 0) continue;
      offsets.set(file, from + Buffer.byteLength(chunk.slice(0, lastNl + 1)));
      for (const line of chunk.slice(0, lastNl).split("\n")) {
        if (line.trim()) handleLine(line);
      }
    }
  };

  const handleLine = (line: string) => {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    // Metadata records (summaries, snapshots) carry no session; skip them.
    if (!rec.sessionId) return;
    const sessionId: string = rec.sessionId;
    const ts = Date.parse(rec.timestamp) || Date.now();
    translator.session(sessionId, rec.cwd, ts);

    const content: Block[] = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const block of content) {
      if (block.type === "thinking" || (block.type === "text" && rec.type === "assistant")) {
        translator.thought(sessionId, String(block.thinking ?? block.text ?? ""), ts);
      } else if (block.type === "tool_use") {
        translator.toolUse({ sessionId, cwd: rec.cwd, id: block.id, name: block.name, input: block.input ?? {}, ts });
      } else if (block.type === "tool_result") {
        translator.toolResult(sessionId, block.tool_use_id, !block.is_error, ts);
      }
    }
  };

  scan();
  const timer = setInterval(scan, opts.pollMs ?? 400);
  return () => clearInterval(timer);
}

function listJsonl(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readRange(file: string, start: number, end: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
