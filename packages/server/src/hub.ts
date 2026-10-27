import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  applyEvent,
  emptyState,
  HUB_ONLY_EVENTS,
  type GraphState,
  type Scope,
  type ScopeViolation,
  type ServerMessage,
  type SessionInfo,
  type SpectraEvent,
} from "@spectra/schema";
import { Translator } from "./toolmap.ts";
import { inScope, makeScope, severityOf, type ScopeConfig } from "./scope.ts";

const HISTORY_LIMIT = 50_000;
const BODY_LIMIT = 1_000_000;

export interface HubOptions {
  scope: ScopeConfig;
  /** Directory for the per-session audit log; undefined disables persistence. */
  dataDir?: string;
  /** Built dashboard (packages/web/dist) to serve at /, if present. */
  staticDir?: string;
  /** Called for each scope violation (desktop alerts). */
  onViolation?: (v: ScopeViolation) => void;
}

const VERDICTS = ["verified", "rejected", "needs-info"];
/** Directories skipped when listing in-scope files for review coverage. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "vendor", "__pycache__", ".venv", "venv", "target", "coverage"]);
const FILE_LIMIT = 20_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

/**
 * The hub owns the reduced GraphState, enforces nothing on the agent, and
 * fans events out to dashboards. Bound to loopback only.
 *
 *   GET  /state            current GraphState
 *   GET  /sessions         recorded sessions (audit log)
 *   GET  /history?session  every event for one session, for replay
 *   POST /hooks            raw Claude Code hook payload (bin/spectra-hook.mjs)
 *   POST /events           agent/demo annotations (MCP server, demo script)
 *   POST /scope            operator sets the scope { paths, hosts }
 *   POST /review           operator verdict on a finding { findingId, verdict, note }
 *   GET  /files            files under the scope paths, for review coverage
 *   WS   /ws               snapshot on connect, then { kind: "event" } messages
 *   GET  /*                built dashboard, when staticDir is set
 */
export class Hub {
  private state: GraphState = emptyState();
  private history: SpectraEvent[] = [];
  private wss: WebSocketServer;
  private hooks: Translator;
  /** Sessions reporting through hooks; their tool events from the observer are duplicates. */
  private hookSessions = new Set<string>();
  private seenToolCalls = new Set<string>();
  private seenToolResults = new Set<string>();
  private sessionCwds = new Map<string, string>();
  private logs = new Map<string, fs.WriteStream>();
  readonly server: http.Server;

  constructor(private opts: HubOptions) {
    this.hooks = new Translator("hook", (e) => this.publish(e));
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ws",
      // A web page on another origin must not be able to read the agent's activity.
      verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
    });
    this.wss.on("connection", (ws) => send(ws, { kind: "snapshot", state: this.state }));
    if (opts.dataDir) fs.mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    if (opts.scope.paths?.length) this.setScope(makeScope(opts.scope, "config"));
  }

  listen(port: number, host = "127.0.0.1") {
    return new Promise<void>((resolve) => this.server.listen(port, host, () => resolve()));
  }

  /** Entry point for every event, trusted or not. */
  publish(event: SpectraEvent) {
    if (!this.accept(event)) return;
    if (event.type === "finding.upsert" && !this.state.findings[event.finding.id]) {
      event = { ...event, finding: { ...event.finding, sessionId: event.sessionId } };
    }
    this.commit(event);
    if (event.type === "tool.call") this.linkFixes(event);

    if (event.type === "session.start" && event.cwd) {
      this.sessionCwds.set(event.sessionId, event.cwd);
      if (this.state.scope?.origin !== "config") this.extendSessionScope(event.cwd);
    }
    if (event.type === "tool.call" && event.targets?.length && this.state.scope) {
      for (const target of event.targets) {
        if (inScope(target, this.state.scope)) continue;
        this.commit({
          ts: event.ts,
          sessionId: event.sessionId,
          source: "hub",
          type: "scope.violation",
          violation: {
            id: crypto.randomUUID(),
            ts: event.ts,
            sessionId: event.sessionId,
            toolUseId: event.toolUseId,
            tool: event.tool,
            nodeId: event.nodeId,
            target,
            severity: severityOf(target),
            summary: event.summary,
          },
        });
        this.opts.onViolation?.(this.state.violations[this.state.violations.length - 1]);
      }
    }
  }

  /** A write to a file named in a finding's location is a candidate fix. */
  private linkFixes(e: Extract<SpectraEvent, { type: "tool.call" }>) {
    const writes = (e.targets ?? []).filter((t) => t.kind === "path" && t.access === "write");
    if (!writes.length) return;
    for (const f of Object.values(this.state.findings)) {
      const file = f.location?.file;
      if (!file) continue;
      for (const t of writes) {
        const matches = path.isAbsolute(file) ? t.value === path.normalize(file) : t.value.endsWith(path.sep + path.normalize(file));
        if (!matches) continue;
        this.commit({
          ts: e.ts,
          sessionId: e.sessionId,
          source: "hub",
          type: "finding.edit",
          findingId: f.id,
          edit: { toolUseId: e.toolUseId, tool: e.tool, path: t.value, ts: e.ts },
        });
      }
    }
  }

  review(findingId: string, verdict: string, note?: string): boolean {
    const f = this.state.findings[findingId];
    if (!f || !VERDICTS.includes(verdict)) return false;
    this.commit({
      ts: Date.now(),
      sessionId: f.sessionId ?? "hub",
      source: "operator",
      type: "finding.review",
      findingId,
      review: { verdict: verdict as "verified", note: note?.slice(0, 2000) || undefined, ts: Date.now() },
    });
    return true;
  }

  /** Files under each scope path, for the coverage view. */
  private listScopeFiles() {
    return (this.state.scope?.paths ?? []).map((root) => {
      const files: string[] = [];
      let truncated = false;
      const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          if (files.length >= FILE_LIMIT) return void (truncated = true);
          if (ent.isSymbolicLink()) continue;
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) walk(full);
          } else if (ent.isFile()) {
            files.push(full);
          }
        }
      };
      walk(root);
      return { root, files, truncated };
    });
  }

  ingestHook(p: any) {
    const sessionId: string | undefined = p?.session_id;
    if (!sessionId) return;
    this.hookSessions.add(sessionId);
    const ts = Date.now();
    const toolUseId: string = p.tool_use_id ?? fallbackToolId(p);
    switch (p.hook_event_name) {
      case "SessionStart":
        this.hooks.session(sessionId, p.cwd, ts);
        break;
      case "UserPromptSubmit":
        this.hooks.session(sessionId, p.cwd, ts);
        this.hooks.thought(sessionId, String(p.prompt ?? ""), ts, "operator prompt");
        break;
      case "PreToolUse":
        this.hooks.toolUse({ sessionId, cwd: p.cwd, id: toolUseId, name: p.tool_name, input: p.tool_input ?? {}, ts });
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        this.hooks.toolResult(sessionId, toolUseId, p.hook_event_name === "PostToolUse" && p.ok !== false, ts);
        break;
      case "SessionEnd":
        this.hooks.end(sessionId, ts, p.reason);
        break;
    }
  }

  setScope(scope: Scope) {
    this.commit({ ts: Date.now(), sessionId: "hub", source: "hub", type: "scope.set", scope });
  }

  /** Dedupe and drop events that would double-count the same tool call. */
  private accept(e: SpectraEvent): boolean {
    if (e.source === "observer" && this.hookSessions.has(e.sessionId) && e.type !== "thought") return false;
    if (e.type === "tool.call") {
      if (this.seenToolCalls.has(e.toolUseId)) return false;
      this.seenToolCalls.add(e.toolUseId);
    }
    if (e.type === "tool.result") {
      if (this.seenToolResults.has(e.toolUseId)) return false;
      this.seenToolResults.add(e.toolUseId);
    }
    return true;
  }

  private commit(event: SpectraEvent) {
    this.state = applyEvent(this.state, event);
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    this.persist(event);
    const msg: ServerMessage = { kind: "event", event };
    for (const client of this.wss.clients) send(client, msg);
  }

  private extendSessionScope(cwd: string) {
    const current = this.state.scope;
    if (current?.paths.includes(path.resolve(cwd))) return;
    this.setScope(makeScope({ paths: [...(current?.paths ?? []), cwd], hosts: this.opts.scope.hosts }, "session"));
  }

  /* ── Audit log ───────────────────────────────────────── */

  private persist(event: SpectraEvent) {
    if (!this.opts.dataDir) return;
    if (event.type === "scope.set") {
      // Scope is global; record the change in every open session log.
      for (const log of this.logs.values()) log.write(JSON.stringify(event) + "\n");
      return;
    }
    if (event.sessionId === "hub") return;
    let log = this.logs.get(event.sessionId);
    if (!log) {
      log = fs.createWriteStream(this.logPath(event.sessionId), { flags: "a", mode: 0o600 });
      this.logs.set(event.sessionId, log);
      if (this.state.scope) {
        log.write(JSON.stringify({ ts: event.ts, sessionId: "hub", source: "hub", type: "scope.set", scope: this.state.scope }) + "\n");
      }
    }
    log.write(JSON.stringify(event) + "\n");
  }

  private logPath(sessionId: string) {
    return path.join(this.opts.dataDir!, `${sessionId.replace(/[^\w.-]/g, "_")}.jsonl`);
  }

  private listSessions(): SessionInfo[] {
    if (!this.opts.dataDir) return [];
    return fs
      .readdirSync(this.opts.dataDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const stat = fs.statSync(path.join(this.opts.dataDir!, f));
        return { id: f.slice(0, -6), events: 0, bytes: stat.size, updated: stat.mtimeMs };
      })
      .sort((a, b) => b.updated - a.updated);
  }

  private readSession(id: string): SpectraEvent[] {
    if (!this.opts.dataDir) return this.history.filter((e) => e.sessionId === id || e.sessionId === "hub");
    try {
      return fs
        .readFileSync(this.logPath(id), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse) {
    const root = this.opts.staticDir;
    if (!root) return void res.writeHead(404).end("dashboard not built: run npm run build");
    // Resolve inside root only; unknown paths fall back to the SPA entry point.
    let file = path.join(root, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\]|\.\.)+/, ""));
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  /* ── HTTP ────────────────────────────────────────────── */

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!isLocalOrigin(req.headers.origin)) return void res.writeHead(403).end("origin not allowed");
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET") {
      if (url.pathname === "/state") return json(this.state);
      if (url.pathname === "/sessions") return json(this.listSessions());
      if (url.pathname === "/files") return json(this.listScopeFiles());
      if (url.pathname === "/history") {
        const id = url.searchParams.get("session");
        return json(id ? this.readSession(id) : this.history);
      }
      return this.serveStatic(url.pathname, res);
    }

    if (req.method === "POST") {
      readBody(req)
        .then((body) => {
          if (url.pathname === "/hooks") {
            this.ingestHook(body);
          } else if (url.pathname === "/events") {
            for (const e of Array.isArray(body) ? body : [body]) {
              if (HUB_ONLY_EVENTS.includes(e?.type)) continue;
              // External callers can only speak as the agent (mcp) or the demo.
              const source = e.source === "demo" ? "demo" : "mcp";
              const event = { ts: Date.now(), ...e, source } as SpectraEvent;
              if (event.type === "finding.upsert") event.finding = { ...event.finding, reportedBy: source };
              this.publish(event);
            }
          } else if (url.pathname === "/scope") {
            this.setScope(makeScope({ paths: body.paths, hosts: body.hosts }, "config"));
          } else if (url.pathname === "/review") {
            if (!this.review(body.findingId, body.verdict, body.note)) return void res.writeHead(400).end("unknown finding or verdict");
          } else {
            return void res.writeHead(404).end();
          }
          res.writeHead(202).end();
        })
        .catch((err) => res.writeHead(400).end(String(err)));
      return;
    }

    res.writeHead(405).end();
  }
}

function isLocalOrigin(origin?: string) {
  if (!origin) return true; // CLI tools (curl, hook script, MCP server) send no Origin
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > BODY_LIMIT) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Hooks without tool_use_id: Pre and Post for the same call hash identically. */
function fallbackToolId(p: any) {
  return "h_" + crypto.createHash("sha1").update(`${p.session_id}|${p.tool_name}|${JSON.stringify(p.tool_input ?? {})}`).digest("hex").slice(0, 16);
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
