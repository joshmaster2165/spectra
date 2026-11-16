import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRef, SpectraEvent } from "@spectra/schema";
import { markSubagent, Translator } from "./toolmap.ts";

/**
 * Log Observer: tails Claude Code's session transcripts and turns them
 * into SpectraEvents. Claude Code is never modified — we only read.
 *
 * Claude Code writes one JSONL file per session under
 *   ~/.claude/projects/<project-slug>/<session-id>.jsonl
 * Each line is a record like
 *   { type: "assistant" | "user", sessionId, cwd, message: { content: [...] } }
 * where content blocks include `text`, `thinking`, `tool_use` and `tool_result`.
 * A subagent's records are in a file of their own,
 *   ~/.claude/projects/<project-slug>/<session-id>/subagents/agent-<id>.jsonl
 * with the parent's sessionId and an `agentId`; its kind is in agent-<id>.meta.json.
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
  // The subagent whose record is being read; what the record maps is marked as that subagent's.
  let acting: AgentRef | undefined;
  const translator = new Translator("observer", (e) => opts.emit(markSubagent(e, acting)));
  const agentTypes = new Map<string, string>();
  const startedAt = Date.now();

  /** A subagent's kind ("Explore", "general-purpose"…), from the small file Claude Code writes beside its log. */
  const agentType = (file: string): string | undefined => {
    if (!agentTypes.has(file)) {
      try {
        const type = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8")).agentType;
        if (typeof type === "string" && type) agentTypes.set(file, type.slice(0, 80));
      } catch {
        // Not written yet, or not there: the subagent is shown without a kind, and this is tried again.
      }
    }
    return agentTypes.get(file);
  };

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
        if (line.trim()) handleLine(line, file);
      }
    }
  };

  const handleLine = (line: string, file: string) => {
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

    const type = typeof rec.agentId === "string" && rec.agentId ? agentType(file) : undefined;
    acting = typeof rec.agentId === "string" && rec.agentId ? { id: rec.agentId.slice(0, 80), ...(type ? { type } : {}) } : undefined;
    try {
      read(rec, sessionId, ts);
    } finally {
      acting = undefined;
    }
  };

  const read = (rec: any, sessionId: string, ts: number) => {
    const content: Block[] = Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const block of content) {
      if (block.type === "thinking" || (block.type === "text" && rec.type === "assistant")) {
        translator.thought(sessionId, String(block.thinking ?? block.text ?? ""), ts);
      } else if (block.type === "tool_use") {
        translator.toolUse({ sessionId, cwd: rec.cwd, id: block.id, name: block.name, input: block.input ?? {}, ts, agent: acting });
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
