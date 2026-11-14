import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  applyEvent,
  emptyState,
  isUnsettled,
  HUB_ONLY_EVENTS,
  VALIDATOR_ONLY_EVENTS,
  type GraphState,
  type HttpEntry,
  type ImportSummary,
  type MapNode,
  type NodeStatus,
  type Scope,
  type ScopeViolation,
  type ServerMessage,
  type SessionInfo,
  type SpectraEvent,
  type TriageState,
} from "@spectra/schema";
import { BROWSER_REASON, browserRole, surfaceIds, Translator, type CallReading, type ToolUse } from "./toolmap.ts";
import { notRequested, PAGE_NOISE, readNetworkLog, readResults, resultFile } from "./results.ts";
import { expand } from "./shell.ts";
import { importEntries } from "./har.ts";
import { DEFAULT_MODEL, Navigator, type NavigatorStatus } from "./navigator.ts";
import { SettingsStore } from "./settings.ts";
import { EngagementStore } from "./engagement.ts";
import { inferEntries, listsPaths, mineUrls } from "./infer.ts";
import { Interpreter, redact, type Interpretation, type InterpreterStatus } from "./interpreter.ts";
import { inScope, makeScope, severityOf, type ScopeConfig } from "./scope.ts";
import { AuditLog } from "./audit.ts";

const HISTORY_LIMIT = 50_000;
const BODY_LIMIT = 1_000_000;
/** Entries per /import request; clients send larger histories in chunks. */
const IMPORT_LIMIT = 5_000;

export interface HubOptions {
  scope: ScopeConfig;
  /** Directory for the per-session audit log; undefined disables persistence. */
  dataDir?: string;
  /** Built dashboard (packages/web/dist) to serve at /, if present. */
  staticDir?: string;
  /** Called for each scope violation (desktop alerts). */
  onViolation?: (v: ScopeViolation) => void;
  /** Where dashboard settings (the Navigator's key, model, on/off) are kept; undefined keeps them in memory. */
  settingsFile?: string;
  /** Whether the transcript observer is running, for the setup checklist. */
  observer?: boolean;
  /** false starts a new engagement instead of restoring the last one. */
  resume?: boolean;
}

const VERDICTS = ["verified", "rejected", "needs-info"];
const TRIAGE_STATES: TriageState[] = ["queued", "testing", "tested", "skipped"];
const NODE_KINDS: string[] = ["root", "category", "leaf"];

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
  ".woff2": "font/woff2",
};

/**
 * The hub owns the reduced GraphState, enforces nothing on the agent, and
 * fans events out to dashboards. Bound to loopback only.
 *
 *   GET  /state            current GraphState
 *   GET  /sessions         recorded sessions (audit log)
 *   GET  /history?session  every event for one session, for replay
 *   GET  /verify?session   check that session's hash-chained audit log
 *   POST /hooks            raw Claude Code hook payload (bin/spectra-hook.mjs)
 *   POST /events           agent/demo annotations (MCP server, demo script)
 *   POST /validator        Navigator leads and finding verdicts (validator process)
 *   POST /import           proxy history { entries: HttpEntry[], label?, includeStatic? } → ImportSummary
 *   GET  /settings         Navigator settings and status (never the key itself)
 *   POST /settings         { navigator: { apiKey?, model?, enabled? } }
 *   POST /navigator/test   one tiny request to check the saved key and model
 *   GET  /health           what's connected, for the setup checklist
 *   POST /triage           operator's mark on a target { nodeId, state, note }
 *   POST /scope            operator sets the scope { paths, hosts }
 *   POST /engagement/new   operator clears the live map and starts a new engagement
 *   POST /actions/resolve  operator settles an action the hub couldn't read { toolUseId | all, note }
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
  private audit?: AuditLog;
  /** The sessions on the live map; restored from their audit logs when the hub starts. */
  private engagement?: EngagementStore;
  /** What the last restore brought back, for the startup line and the setup checklist. */
  restored: { events: number; sessions: number } | null = null;
  /** The event that put the current scope in force; repeated at the start of each session's log. */
  private scopeEvent?: SpectraEvent;
  private settings: SettingsStore;
  /** The Navigator, when it's turned on in Settings and has a key. */
  private navigator?: Navigator;
  /** The Interpreter, when it's turned on in Settings and has a key. */
  private interpreter?: Interpreter;
  /**
   * The full input and output of actions still waiting to be read. Held in
   * memory only — never written to the audit log or sent to a dashboard.
   */
  private actionData = new Map<string, ActionData>();
  /** While a call's result is awaited: the nodes it put on the map, and what the nodes it touched looked like before. */
  private callTouch = new Map<string, { fresh: string[]; prior: [string, NodeStatus][] }>();
  /** Shell commands awaiting their result, to check afterwards which of their addresses were really requested. */
  private callCommands = new Map<string, { command: string; cwd?: string }>();
  /** The call whose events are being published right now. */
  private currentCall?: string;
  /** Background task id → the call that started it, so output read later is credited to it. */
  private bgTasks = new Map<string, string>();
  /** Tool-use id → the command's node, to link a command to what its output revealed. */
  private callNodes = new Map<string, string>();
  /** When each channel last delivered something, for the setup checklist. */
  private seen: { hook?: number; mcp?: number; validator?: number; import?: number } = {};
  private startedAt = Date.now();
  readonly server: http.Server;

  constructor(private opts: HubOptions) {
    this.hooks = new Translator(
      "hook",
      (e) => this.publish(e),
      (file) => this.readProjectFile(file),
      (t, reading) => this.withholdFlag(t, reading),
    );
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      path: "/ws",
      // A web page on another origin must not be able to read the agent's activity.
      verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
    });
    this.wss.on("connection", (ws) => send(ws, { kind: "snapshot", state: this.state }));
    if (opts.dataDir) {
      this.audit = new AuditLog(opts.dataDir);
      this.engagement = new EngagementStore(path.join(opts.dataDir, "_engagement.json"));
      if (opts.resume === false) this.engagement.reset();
      else this.restore();
    }
    this.settings = new SettingsStore(opts.settingsFile);
    this.configureNavigator();
    this.configureInterpreter();
    this.applyConfiguredScope();
  }

  /** The scope from the config file and environment, applied at startup and for a new engagement. */
  private applyConfiguredScope() {
    const cfg = this.opts.scope;
    const restored = this.state.scope;
    let next: Scope | undefined;
    if (cfg.paths?.length) next = makeScope(cfg, "config");
    // A restored engagement keeps its scope; hosts in the config are added to it.
    else if (restored) next = makeScope({ paths: restored.paths, hosts: [...restored.hosts, ...(cfg.hosts ?? [])] }, restored.origin);
    // Hosts without paths: authorize the hosts now; each session's directory joins as it starts.
    else if (cfg.hosts?.length) next = makeScope({ hosts: cfg.hosts }, "session");
    if (next && JSON.stringify(next) !== JSON.stringify(restored)) this.setScope(next);
  }

  /**
   * Rebuild the live map from the audit logs of the engagement's sessions.
   * Events are merged across sessions by time, keeping each log's own order.
   */
  private restore() {
    if (!this.audit || !this.engagement) return;
    const logs = this.engagement
      .get()
      .sessions.map((s) => this.audit!.read(s.id).slice(s.from))
      .filter((l) => l.length);
    const at = logs.map(() => 0);
    let events = 0;
    for (;;) {
      let pick = -1;
      for (let i = 0; i < logs.length; i++) {
        if (at[i] >= logs[i].length) continue;
        if (pick < 0 || logs[i][at[i]].ts < logs[pick][at[pick]].ts) pick = i;
      }
      if (pick < 0) break;
      const e = logs[pick][at[pick]++];
      // Each log repeats the scope in force, so most scope lines change nothing.
      if (e.type === "scope.set" && JSON.stringify(e.scope) === JSON.stringify(this.state.scope)) continue;
      try {
        this.state = applyEvent(this.state, e);
      } catch {
        continue; // a line that isn't a usable event
      }
      this.history.push(e);
      if (e.type === "scope.set") this.scopeEvent = e;
      if (e.source === "hook") this.hookSessions.add(e.sessionId);
      if (e.type === "tool.call") this.seenToolCalls.add(e.toolUseId);
      if (e.type === "tool.result") this.seenToolResults.add(e.toolUseId);
      if (e.type === "session.start" && e.cwd) this.sessionCwds.set(e.sessionId, e.cwd);
      events++;
    }
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    if (events) this.restored = { events, sessions: logs.length };
  }

  /** Clear the live map and start over. Recorded sessions stay on disk and replayable. */
  newEngagement() {
    this.state = emptyState();
    this.history = [];
    this.hookSessions.clear();
    this.seenToolCalls.clear();
    this.seenToolResults.clear();
    this.sessionCwds.clear();
    this.actionData.clear();
    this.callNodes.clear();
    this.callTouch.clear();
    this.callCommands.clear();
    this.bgTasks.clear();
    this.configureInterpreter(); // drops anything queued for the old map
    this.restored = null;
    this.scopeEvent = undefined;
    // Sessions still running introduce themselves again on their next event.
    this.hooks.forget();
    this.engagement?.reset();
    for (const client of this.wss.clients) send(client, { kind: "snapshot", state: this.state });
    this.applyConfiguredScope();
  }

  /** Flush the audit logs before the process exits. */
  async close() {
    this.navigator?.stop();
    this.interpreter?.stop();
    await this.audit?.close();
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
    // A bare status change when a call finishes isn't a new reach; a full node is.
    if (event.type === "node.upsert" && event.source === "hook" && event.node.kind) this.trackTouch(event.node.id);
    this.commit(event);
    if (event.type === "tool.call") {
      this.linkFixes(event);
      if (event.nodeId) remember(this.callNodes, event.toolUseId, event.nodeId, 2000);
    }

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

  /** Notes which pending call first put a node on the map, so a call that turns out never to have run can be undone. */
  private trackTouch(nodeId: string) {
    // A node another call reaches is no longer one call's alone.
    for (const [id, t] of this.callTouch) {
      if (id === this.currentCall) continue;
      const i = t.fresh.indexOf(nodeId);
      if (i >= 0) t.fresh.splice(i, 1);
    }
    const t = this.currentCall ? this.callTouch.get(this.currentCall) : undefined;
    if (!t) return;
    const prev = this.state.nodes[nodeId];
    if (!prev) t.fresh.push(nodeId);
    else if (!t.fresh.includes(nodeId) && !t.prior.some(([id]) => id === nodeId)) t.prior.push([nodeId, prev.status]);
  }

  /**
   * A file the driver's commands name — a script it runs, a wordlist it loops
   * over, a results file it wrote — read so the hub can tell what was requested.
   * Only inside the scope's directories, only small text files; the contents are
   * used to read the command and are not stored.
   */
  private readProjectFile(file: string): string | undefined {
    if (process.env.SPECTRA_READ_FILES === "0") return;
    try {
      const real = fs.realpathSync(file);
      // Files that exist to hold secrets are never opened, whatever the command does with them.
      if (SECRET_FILE.test(path.basename(real))) return;
      const inside = (this.state.scope?.paths ?? []).some((root) => {
        const r = fs.realpathSync(root);
        return real === r || real.startsWith(r + path.sep);
      });
      if (!inside) return;
      const stat = fs.statSync(real);
      if (!stat.isFile() || stat.size > 512_000) return;
      const text = fs.readFileSync(real, "utf8");
      return text.slice(0, 2000).includes("\u0000") ? undefined : text;
    } catch {
      return; // missing, unreadable, or the scope directory is gone
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

  /** Proxy history onto the map, scope-filtered; joins the live session's record when there is one. */
  importTraffic(raw: unknown[], opts: { label?: unknown; includeStatic?: unknown }): ImportSummary {
    const entries: HttpEntry[] = [];
    for (const e of raw.slice(0, IMPORT_LIMIT) as any[]) {
      if (typeof e?.url !== "string" || e.url.length > 4096 || !/^https?:\/\//i.test(e.url)) continue;
      entries.push({
        method: typeof e.method === "string" ? e.method.toUpperCase().slice(0, 12) : "GET",
        url: e.url.split(/[?#]/)[0], // never keep query values, whatever the client sent
        status: Number.isInteger(e.status) ? e.status : undefined,
        mime: typeof e.mime === "string" ? e.mime.slice(0, 100) : undefined,
        params: Array.isArray(e.params) ? e.params.filter((p: unknown) => typeof p === "string").slice(0, 40).map((p: string) => p.slice(0, 80)) : undefined,
      });
    }
    const label = typeof opts.label === "string" && opts.label.trim() ? opts.label.trim().slice(0, 80) : "proxy history";
    const sessionId = this.state.sessionId ?? `import-${Date.now().toString(36)}`;
    const { events, summary } = importEntries(this.state, entries, { sessionId, label, includeStatic: opts.includeStatic === true });
    for (const e of events) this.publish(e);
    return summary;
  }

  /* ── Settings and the in-hub Navigator ───────────────── */

  /** (Re)starts the Navigator from the current settings: it runs only when enabled and a key is available. */
  private configureNavigator() {
    this.navigator?.stop();
    this.navigator = undefined;
    const s = this.settings.get().navigator;
    if (!s.enabled || !(s.apiKey || process.env.ANTHROPIC_API_KEY)) return;
    this.navigator = new Navigator({
      getState: () => this.state,
      apiKey: s.apiKey,
      model: s.model ?? process.env.SPECTRA_VALIDATOR_MODEL,
      idleMs: Number(process.env.SPECTRA_VALIDATOR_IDLE_MS ?? 2500),
      log: (msg) => console.log(`[navigator] ${msg}`),
      post: (events) => {
        for (const e of events) this.publish({ ts: Date.now(), ...e, source: "validator" } as SpectraEvent);
      },
    });
    this.navigator.notify(); // assess what's already on the map
  }

  /** Settings as the dashboard may see them: the key itself never leaves the hub. */
  private settingsView() {
    const s = this.settings.get().navigator;
    const key = s.apiKey ?? process.env.ANTHROPIC_API_KEY;
    const model = s.model ?? process.env.SPECTRA_VALIDATOR_MODEL ?? DEFAULT_MODEL;
    const status: NavigatorStatus = this.navigator?.status() ?? { state: "off", model, runs: 0 };
    return {
      navigator: {
        enabled: !!s.enabled,
        model,
        hasKey: !!key,
        keySource: s.apiKey ? "settings" : key ? "environment" : null,
        keyHint: key ? `…${key.slice(-4)}` : null,
        status,
      },
      interpreter: {
        mode: this.settings.get().interpreter.mode ?? "off",
        status: this.interpreter?.status() ?? ({ state: "off", model, read: 0, queued: 0 } satisfies InterpreterStatus),
        /** Unread actions whose output the hub still holds, so turning the Interpreter on can read them. */
        waiting: [...this.actionData].filter(([id, d]) => d.output && this.isOpen(id)).length,
      },
      /** MCP tools and servers the operator has said never touch the target. */
      localTools: this.settings.get().localTools,
    };
  }

  /**
   * Flags the hub has reason not to raise: a tool the operator called local, and
   * a browser whose traffic is already listed as unread for this session — one
   * open item covers every page worked until the network log is read.
   */
  private withholdFlag(t: ToolUse, reading: CallReading): boolean {
    if (t.name.startsWith("mcp__") && this.isLocalTool(t.name)) return true;
    return reading.browser === "page" && !!this.openBrowserAction(t.sessionId);
  }

  private openBrowserAction(sessionId: string) {
    return Object.values(this.state.actions).find((a) => a.sessionId === sessionId && a.reason === BROWSER_REASON && isUnsettled(a));
  }

  private isLocalTool(tool: string) {
    return this.settings.get().localTools.some((t) => t === tool || (t.endsWith("__") && tool.startsWith(t)));
  }

  /**
   * The operator says a tool (or a whole MCP server, with a name ending in "__")
   * never touches the target: its calls stop being listed as unread, and the
   * ones already listed are settled.
   */
  private setLocalTool(name: unknown, local: unknown) {
    if (typeof name !== "string" || !this.settings.setLocalTool(name, local !== false)) return;
    if (local === false) return;
    for (const a of Object.values(this.state.actions)) {
      if (!isUnsettled(a) || !this.isLocalTool(a.tool)) continue;
      this.commit({ ts: Date.now(), sessionId: a.sessionId, source: "operator", type: "action.resolve", toolUseId: a.toolUseId, resolution: "dismissed", note: `Marked ${name.endsWith("__") ? "this server's tools" : "this tool"} as not touching the target` });
      this.actionData.delete(a.toolUseId);
    }
  }

  private updateSettings(patch: { apiKey?: unknown; model?: unknown; enabled?: unknown }, interpreterMode?: unknown) {
    const next: { apiKey?: string; model?: string; enabled?: boolean } = {};
    // "" clears a saved key or model; anything else must look like one.
    if (typeof patch.apiKey === "string" && patch.apiKey.length <= 400 && !/\s/.test(patch.apiKey)) next.apiKey = patch.apiKey;
    if (typeof patch.model === "string" && /^[\w.:-]{0,80}$/.test(patch.model)) next.model = patch.model;
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    const mode = interpreterMode === "unread" || interpreterMode === "all" ? interpreterMode : interpreterMode === "off" ? null : undefined;
    this.settings.update(next, mode);
    // Only restart what changed: a restarted Navigator reassesses the whole map.
    if (Object.keys(next).length) this.configureNavigator();
    if ("apiKey" in next || "model" in next || mode !== undefined) this.configureInterpreter();
    return this.settingsView();
  }

  /** One tiny request with the saved key and model, so a bad key shows up in Settings, not mid-engagement. */
  private async testNavigator(): Promise<{ ok: boolean; error?: string }> {
    const s = this.settings.get().navigator;
    if (!(s.apiKey || process.env.ANTHROPIC_API_KEY)) return { ok: false, error: "Add an API key first." };
    const probe = new Navigator({ getState: () => this.state, post: () => {}, apiKey: s.apiKey, model: s.model ?? process.env.SPECTRA_VALIDATOR_MODEL });
    const result = await probe.test();
    probe.stop();
    return result;
  }

  /** What's connected, for the setup checklist. */
  private health() {
    const scope = this.state.scope;
    return {
      hub: { startedAt: this.startedAt, events: this.history.length },
      scope: scope ? { set: true, origin: scope.origin, paths: scope.paths.length, hosts: scope.hosts.length } : { set: false },
      hooks: { lastSeen: this.seen.hook ?? null, sessions: this.hookSessions.size },
      observer: { enabled: !!this.opts.observer },
      mcp: { lastSeen: this.seen.mcp ?? null },
      proxy: { lastImport: this.seen.import ?? null },
      navigator: { ...this.settingsView().navigator, externalLastSeen: this.seen.validator ?? null },
      interpreter: this.settingsView().interpreter,
      // Every tool call is recorded; these are the ones the hub couldn't read, and how many are still open.
      actions: {
        total: this.state.counts.toolCalls,
        unread: Object.keys(this.state.actions).length,
        open: Object.values(this.state.actions).filter(isUnsettled).length,
      },
      // Shown in the dashboard: abbreviate the home directory.
      audit: { enabled: !!this.audit, dir: this.opts.dataDir?.replace(os.homedir(), "~") ?? null },
      engagement: this.engagement ? { started: this.engagement.get().started, sessions: this.engagement.get().sessions.length, restored: this.restored } : null,
    };
  }

  /** The operator's triage mark on a target; `state: null` clears it. */
  triage(nodeId: unknown, state: unknown, note?: unknown): boolean {
    if (typeof nodeId !== "string" || !this.state.nodes[nodeId]) return false;
    if (state !== null && !TRIAGE_STATES.includes(state as TriageState)) return false;
    this.commit({
      ts: Date.now(),
      sessionId: this.state.sessionId ?? "operator",
      source: "operator",
      type: "target.triage",
      nodeId,
      triage: state === null ? null : { state: state as TriageState, note: typeof note === "string" && note.trim() ? note.trim().slice(0, 2000) : undefined, ts: Date.now() },
    });
    return true;
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
    this.seen.hook = Date.now();
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
      case "PreToolUse": {
        if (this.seenToolCalls.has(toolUseId)) break;
        remember(this.callTouch, toolUseId, { fresh: [], prior: [] }, 400);
        this.currentCall = toolUseId;
        let reading: CallReading;
        try {
          reading = this.hooks.toolUse({ sessionId, cwd: p.cwd, id: toolUseId, name: p.tool_name, input: p.tool_input ?? {}, ts });
        } finally {
          this.currentCall = undefined;
        }
        const command = typeof p.tool_input?.command === "string" ? p.tool_input.command : undefined;
        if (command && p.tool_name === "Bash") remember(this.callCommands, toolUseId, { command, cwd: p.cwd }, 400);
        // Flagged as unread: keep the whole call for whoever reads it.
        if (this.isOpen(toolUseId)) {
          remember(this.actionData, toolUseId, { sessionId, tool: String(p.tool_name), input: describeInput(p.tool_input, reading.material), probes: reading.probes, known: reading.known, material: reading.material, command, cwd: p.cwd }, 300);
        }
        break;
      }
      case "PostToolUse":
      case "PostToolUseFailure": {
        this.hooks.toolResult(sessionId, toolUseId, p.hook_event_name === "PostToolUse" && p.ok !== false, ts);
        // An error message repeats the address it failed on; that isn't the output revealing a target.
        const unrequested = typeof p.output === "string" && p.output ? this.dropUnrequested(sessionId, toolUseId, p.output.slice(0, OUTPUT_LIMIT), ts) : undefined;
        this.callTouch.delete(toolUseId);
        this.callCommands.delete(toolUseId);
        if (typeof p.task === "string" && p.task) remember(this.bgTasks, p.task, toolUseId, 200);
        const output = typeof p.output === "string" ? p.output : "";
        // A browser's own list of the requests its pages made: read as traffic, not as text to interpret.
        if (browserRole(String(p.tool_name)) === "log") {
          if (output.trim()) this.readBrowserLog(sessionId, toolUseId, output.slice(0, OUTPUT_LIMIT), ts);
          break;
        }
        // Nothing printed: still worth a look when the call is unread, since its results may be in a file it wrote.
        if (!output.trim() && !(this.isOpen(toolUseId) && this.actionData.get(toolUseId)?.command)) break;
        // Output of a background command, read by the driver later: it belongs to the call that started it.
        const origin = this.backgroundOrigin(p);
        if (origin) this.readOutput(sessionId, origin, "Bash", undefined, output.replace(/^\s*\d+\t/gm, "").slice(0, OUTPUT_LIMIT));
        // A background launch returns only a notice, and a file read is file contents, not results.
        else if (p.tool_input?.run_in_background !== true && p.tool_name !== "Read") this.readOutput(sessionId, toolUseId, String(p.tool_name), p.tool_input, output.slice(0, OUTPUT_LIMIT), unrequested);
        break;
      }
      case "PostToolBatch":
        // Every call in a finished batch has its result by now; one without was denied before it ran.
        for (const c of Array.isArray(p.batch) ? p.batch : []) {
          if (typeof c?.id !== "string" || !this.hooks.isPending(c.id) || this.seenToolResults.has(c.id)) continue;
          const note = typeof c.note === "string" ? c.note.replace(/\s+/g, " ").trim().slice(0, 200) : "";
          // An interrupted call did start; only its result is missing.
          if (/\binterrupt|\bcancell?ed\b/i.test(note)) this.hooks.toolResult(sessionId, c.id, false, ts);
          else this.skipped(sessionId, c.id, note, ts);
          this.callTouch.delete(c.id);
        }
        break;
      case "SessionEnd":
        this.hooks.end(sessionId, ts, p.reason);
        break;
    }
  }

  /**
   * The browser's record of what its pages requested. In-scope requests go on
   * the map as the driver's traffic, and the session's unread browser item is
   * settled. Requests to other hosts (analytics, CDNs a page pulls in) are
   * counted and left out: the page asked for them, the driver didn't aim at them.
   */
  private readBrowserLog(sessionId: string, toolUseId: string, output: string, ts: number) {
    const requests = readNetworkLog(output);
    if (!requests.length) return;
    const scope = this.state.scope;
    const mine = requests.filter((r) => {
      try {
        const u = new URL(r.url);
        return !!scope && inScope({ kind: "host", value: u.hostname.toLowerCase(), access: "network" }, scope) && !PAGE_NOISE.test(u.pathname) && r.status !== 404;
      } catch {
        return false;
      }
    });
    const pending = this.openBrowserAction(sessionId);
    const from = pending?.nodeId && this.state.nodes[pending.nodeId] ? pending.nodeId : this.callNodes.get(toolUseId);
    const before = Object.keys(this.state.nodes).length;
    if (mine.length && from && this.state.nodes[from]) this.hooks.mapConfirmed(sessionId, ts, from, mine.map((r) => ({ url: r.url, status: r.status })));
    if (!pending) return;
    const others = requests.length - mine.length;
    this.commit({
      ts,
      sessionId,
      source: "hub",
      type: "action.resolve",
      toolUseId: pending.toolUseId,
      resolution: mine.length ? "interpreted" : "nothing",
      note: `Read ${requests.length} requests from the browser's network log: ${mine.length} to in-scope pages and APIs${others ? `, ${others} left out (other hosts, images, styles, not found)` : ""}`,
      added: Object.keys(this.state.nodes).length - before,
    });
    this.actionData.delete(pending.toolUseId);
  }

  /** The call a later read of background output belongs to, if this is one. */
  private backgroundOrigin(p: any): string | undefined {
    const input = p.tool_input ?? {};
    const id = p.tool_name === "Read" ? /\/tasks\/([\w-]+)\.output$/.exec(String(input.file_path ?? ""))?.[1] : /^(BashOutput|TaskOutput)$/.test(String(p.tool_name)) ? (input.bash_id ?? input.task_id ?? input.shell_id) : undefined;
    return typeof id === "string" ? this.bgTasks.get(id) : undefined;
  }

  /**
   * A call that was denied or blocked before it ran. Whatever it would have
   * touched comes off the map again, and nothing is left waiting to be read.
   */
  private skipped(sessionId: string, toolUseId: string, note: string, ts: number) {
    const touch = this.callTouch.get(toolUseId);
    this.hooks.toolSkipped(sessionId, toolUseId, ts);
    const base = { ts, sessionId, source: "hub" as const };
    for (const [id, status] of touch?.prior ?? []) {
      if (this.state.nodes[id]) this.commit({ ...base, type: "node.upsert", node: { id, status } as MapNode });
    }
    const gone = (touch?.fresh ?? []).filter((id) => /^(endpoint|host|domain|param):/.test(id) && this.state.nodes[id]);
    if (gone.length) this.commit({ ...base, type: "node.remove", nodeIds: gone, reason: "The call that named these never ran" });
    const leaf = this.callNodes.get(toolUseId);
    if (leaf && this.state.nodes[leaf]) this.commit({ ...base, type: "node.upsert", node: { id: leaf, status: "unexplored", meta: { "did not run": note || "denied before it ran" } } as unknown as MapNode });
    if (this.isOpen(toolUseId)) {
      this.commit({ ...base, type: "action.resolve", toolUseId, resolution: "nothing", note: `Never ran${note ? `: ${note}` : ""}` });
      this.actionData.delete(toolUseId);
    }
  }

  /**
   * A command ran, but its output says some of what it named was never
   * requested: the program wasn't found, the shell rejected the word, the host
   * couldn't be reached. Targets only this call put on the map come off again.
   */
  private dropUnrequested(sessionId: string, toolUseId: string, output: string, ts: number): Set<string> {
    const none = new Set<string>();
    const call = this.callCommands.get(toolUseId);
    const touch = this.callTouch.get(toolUseId);
    if (!call || !touch) return none;
    const exp = expand(call.command, { cwd: call.cwd, readFile: (f) => this.readProjectFile(f) });
    const { urls, why, missing } = notRequested(exp, output);
    // Flagged only because the program was unknown — and it turns out not to exist here, so it ran nothing.
    const action = this.state.actions[toolUseId];
    const unknown = action && isUnsettled(action) ? action.reason.match(/^Spectra doesn't know the (\S+) command$/)?.[1] : undefined;
    if (unknown && missing.includes(unknown)) {
      this.commit({ ts, sessionId, source: "hub", type: "action.resolve", toolUseId, resolution: "nothing", note: `${unknown} isn't installed here, so it ran nothing` });
      this.actionData.delete(toolUseId);
    }
    if (!urls.size) return none;
    // An endpoint the same command also requested successfully stays.
    const kept = new Set<string>();
    for (const u of exp.urls) if (!urls.has(u.url)) kept.add(surfaceIds(u.url)?.target ?? "");
    const dropped = new Set<string>();
    for (const u of urls) {
      const ids = surfaceIds(u);
      if (ids && !kept.has(ids.target)) dropped.add(ids.target);
    }
    const base = { ts, sessionId, source: "hub" as const };
    for (const [id, status] of touch.prior) {
      if (dropped.has(id) && this.state.nodes[id]) this.commit({ ...base, type: "node.upsert", node: { id, status } as MapNode });
    }
    const fresh = new Set(touch.fresh);
    const gone = touch.fresh.filter((id) => this.state.nodes[id] && (dropped.has(id) || (id.startsWith("param:") && dropped.has(`endpoint:${id.slice(6).split("?")[0]}`))));
    // A host or domain this call introduced, with nothing left under it.
    const goneSet = new Set(gone);
    for (const prefix of ["host:", "domain:"]) {
      for (const id of touch.fresh) {
        if (!id.startsWith(prefix) || goneSet.has(id) || !this.state.nodes[id] || !fresh.has(id)) continue;
        const hasChild = Object.values(this.state.nodes).some((n) => n.parentId === id && !goneSet.has(n.id));
        if (!hasChild) {
          gone.push(id);
          goneSet.add(id);
        }
      }
    }
    if (gone.length) this.commit({ ...base, type: "node.remove", nodeIds: gone, reason: "The command failed before requesting these" });
    const leaf = this.callNodes.get(toolUseId);
    if (leaf && this.state.nodes[leaf] && why) this.commit({ ...base, type: "node.upsert", node: { id: leaf, meta: { "not requested": why } } as unknown as MapNode });
    return urls;
  }

  /* ── Reading what the hub couldn't ───────────────────── */

  /** Unread and not settled; a read that gave up counts, so it can be retried or dismissed. */
  private isOpen(toolUseId: string) {
    const a = this.state.actions[toolUseId];
    return !!a && isUnsettled(a);
  }

  /**
   * A tool call's output arrived. In-scope URLs printed in it go on the map
   * straight away (a local scan). If the call is one the hub couldn't read,
   * its output is kept for the Interpreter.
   */
  private readOutput(sessionId: string, toolUseId: string, tool: string, input: unknown, output: string, unrequested?: Set<string>) {
    const fromNodeId = this.callNodes.get(toolUseId) ?? this.state.actions[toolUseId]?.nodeId;
    const mined = mineUrls(output).filter((e) => !unrequested?.has(e.url));
    const { events } = inferEntries(this.state, mined, { sessionId, source: "hub", fromNodeId });
    for (const e of events) this.publish(e);

    const mode = this.settings.get().interpreter.mode;
    // "All output": a call the hub did read, whose output lists places the map may not have.
    if (mode === "all" && this.interpreter && !this.state.actions[toolUseId] && tool !== "BashOutput" && listsPaths(output)) {
      const summary = [...this.state.timeline].reverse().find((e) => e.type === "tool.call" && e.toolUseId === toolUseId);
      this.commit({
        ts: Date.now(),
        sessionId,
        source: "hub",
        type: "action.open",
        action: { toolUseId, tool, summary: summary?.type === "tool.call" ? summary.summary : tool, nodeId: fromNodeId, reason: "Its output lists paths Spectra can't place on its own" },
      });
      remember(this.actionData, toolUseId, { sessionId, tool, input: describeInput(input) }, 300);
    }
    if (!this.isOpen(toolUseId)) return;
    const data = this.actionData.get(toolUseId) ?? { sessionId, tool, input: describeInput(input) };
    if (output.trim()) data.output = output;
    remember(this.actionData, toolUseId, data, 300);
    // Result lines the hub can read itself settle the action without the Interpreter.
    if (this.readResultLines(sessionId, toolUseId, data, output, fromNodeId)) return;
    if (output.trim()) this.interpreter?.enqueue({ toolUseId, tool: data.tool, input: data.input, output: output.slice(0, 20_000) });
  }

  /**
   * Reads the result lines of an unread action's output (or of the file it
   * wrote them to). Addresses the command is known to have requested go on the
   * map as the driver's own traffic; others are added as read from the output.
   * Returns true when every result line was understood and the action is settled.
   */
  private readResultLines(sessionId: string, toolUseId: string, data: ActionData, output: string, fromNodeId?: string): boolean {
    const ctx = { probes: data.known ?? data.probes, material: data.material ?? data.input };
    let reading = readResults(output, ctx);
    if (!reading.lines && data.command) {
      const file = resultFile(data.command);
      const text = file && this.readProjectFile(path.resolve(data.cwd ?? this.sessionCwds.get(sessionId) ?? "/", file));
      if (text) reading = readResults(text.slice(0, OUTPUT_LIMIT), ctx);
    }
    if (!reading.lines) return false;
    const before = Object.keys(this.state.nodes).length;
    const requested = reading.hits.filter((h) => h.requested);
    if (requested.length && fromNodeId && this.state.nodes[fromNodeId]) this.hooks.mapConfirmed(sessionId, Date.now(), fromNodeId, requested);
    // A target mapped when the command was read, which the output says wasn't there, keeps its place and says so.
    for (const g of reading.gone) this.hooks.noteStatus(sessionId, Date.now(), g.url, g.status);
    const found = reading.hits.filter((h) => !h.requested).map((h) => ({ url: h.url, status: h.status, method: h.method, evidence: maskEvidence(h.evidence) }));
    const { events, outOfScope } = inferEntries(this.state, found, { sessionId, source: "hub", fromNodeId, readBy: "result lines" });
    for (const e of events) this.publish(e);
    const added = Object.keys(this.state.nodes).length - before;
    data.added = (data.added ?? 0) + added;
    // Left open when part of the output couldn't be placed, or the output was cut short.
    if (reading.ambiguous || reading.unplaced || /…\[\d+ characters left out\]…/.test(output)) return false;
    // What a sweep didn't print (filtered out, or never answered) is said, not folded into "not found".
    const unshown = data.probes?.length ? Math.max(0, data.probes.length - reading.hits.filter((h) => h.requested).length - reading.dead) : 0;
    const swept = data.probes?.length ? `Swept ${data.probes.length} addresses: ` : `Read ${reading.lines} result lines: `;
    this.commit({
      ts: Date.now(),
      sessionId,
      source: "hub",
      type: "action.resolve",
      toolUseId,
      resolution: reading.hits.length ? "interpreted" : "nothing",
      note: `${swept}${reading.hits.length} answered${reading.dead ? `, ${reading.dead} not found` : ""}${unshown ? `, ${unshown} not shown in the output` : ""}`,
      added,
      ignored: outOfScope,
    });
    this.actionData.delete(toolUseId);
    return true;
  }

  /** The Interpreter read an action: put what's evidenced and in scope on the map, and settle the action. */
  private applyInterpretation(r: Interpretation) {
    const action = this.state.actions[r.toolUseId];
    if (!action || !isUnsettled(action)) return;
    const data = this.actionData.get(r.toolUseId);
    const sessionId = data?.sessionId ?? action.sessionId;
    const inferred = inferEntries(this.state, r.targets, { sessionId, source: "interpreter", fromNodeId: action.nodeId });
    const { events, outOfScope } = inferred;
    // What the hub's own reading of the result lines already put on the map counts too.
    const added = inferred.added + (data?.added ?? 0);
    for (const e of events) this.publish(e);
    this.commit({
      ts: Date.now(),
      sessionId,
      source: "interpreter",
      type: "action.resolve",
      toolUseId: r.toolUseId,
      resolution: added ? "interpreted" : "nothing",
      note: r.summary || undefined,
      added,
      ignored: r.rejected + outOfScope,
    });
    this.actionData.delete(r.toolUseId);
  }

  /** The operator settles an unread action (or all of them) by hand. */
  resolveActions(toolUseId: unknown, all: unknown, note: unknown): number {
    const ids = all === true ? Object.keys(this.state.actions).filter((id) => this.isOpen(id)) : typeof toolUseId === "string" && this.isOpen(toolUseId) ? [toolUseId] : [];
    for (const id of ids) {
      this.commit({
        ts: Date.now(),
        sessionId: this.state.actions[id].sessionId,
        source: "operator",
        type: "action.resolve",
        toolUseId: id,
        resolution: "dismissed",
        note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : undefined,
      });
      this.actionData.delete(id);
    }
    return ids.length;
  }

  /** (Re)starts the Interpreter from the current settings: it runs only when a mode is chosen and a key is available. */
  private configureInterpreter() {
    this.interpreter?.stop();
    this.interpreter = undefined;
    const s = this.settings.get();
    if (!s.interpreter.mode || !(s.navigator.apiKey || process.env.ANTHROPIC_API_KEY)) return;
    this.interpreter = new Interpreter({
      apiKey: s.navigator.apiKey,
      model: s.navigator.model ?? process.env.SPECTRA_VALIDATOR_MODEL,
      log: (msg) => console.log(`[interpreter] ${msg}`),
      onResult: (r) => this.applyInterpretation(r),
      onGiveUp: (toolUseId, why) => {
        const action = this.state.actions[toolUseId];
        if (!action || action.resolution) return;
        // Its output stays in hand, so it's read again if the Interpreter is restarted.
        this.commit({ ts: Date.now(), sessionId: action.sessionId, source: "interpreter", type: "action.resolve", toolUseId, resolution: "failed", note: why });
      },
    });
    // Anything already waiting with its output in hand.
    for (const [toolUseId, d] of this.actionData) {
      if (d.output && this.isOpen(toolUseId)) this.interpreter.enqueue({ toolUseId, tool: d.tool, input: d.input, output: d.output });
    }
  }

  setScope(scope: Scope, source: "hub" | "operator" = "hub") {
    this.commit({ ts: Date.now(), sessionId: "hub", source, type: "scope.set", scope });
  }

  /** Dedupe and drop events that would double-count the same tool call. */
  private accept(e: SpectraEvent): boolean {
    // A malformed node from a script or annotation would break every view that draws it.
    if (e.type === "node.upsert") {
      const n = e.node as Partial<typeof e.node> | undefined;
      if (!n || typeof n.id !== "string" || !n.id) return false;
      // An update to a node already on the map (a status change when a call finishes) may be partial.
      const known = !!this.state.nodes[n.id];
      if (n.kind !== undefined ? !NODE_KINDS.includes(n.kind as string) : !known) return false;
      if (n.label !== undefined ? typeof n.label !== "string" : !known) return false;
    }
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
    // The Navigator reassesses when the map changes — but not in response to its own advice.
    if (event.source !== "validator") this.navigator?.notify();
  }

  private extendSessionScope(cwd: string) {
    const current = this.state.scope;
    if (current?.paths.includes(path.resolve(cwd))) return;
    // Hosts the operator added in Settings stay; a new session only adds its directory.
    this.setScope(makeScope({ paths: [...(current?.paths ?? []), cwd], hosts: current?.hosts ?? this.opts.scope.hosts }, "session"));
  }

  /* ── Audit log ───────────────────────────────────────── */

  private persist(event: SpectraEvent) {
    if (!this.audit) return;
    if (event.type === "scope.set") {
      this.scopeEvent = event;
      // Scope is global; record the change in the open log of every session on the map.
      for (const id of this.audit.openSessions()) if (!this.engagement || this.engagement.has(id)) this.audit.append(id, event);
      return;
    }
    if (event.sessionId === "hub") return;
    const joining = !!this.engagement && !this.engagement.has(event.sessionId);
    if (joining) this.engagement!.add(event.sessionId, this.audit.length(event.sessionId));
    if ((joining || !this.audit.isOpen(event.sessionId)) && this.state.scope) {
      // Each log starts with the scope in force, so replay and verification stand alone. It is the
      // event that set it, as it happened, so a restart restores who set the scope and when.
      this.audit.append(event.sessionId, this.scopeEvent ?? { ts: event.ts, sessionId: "hub", source: "hub", type: "scope.set", scope: this.state.scope });
    }
    this.audit.append(event.sessionId, event);
  }

  private listSessions(): SessionInfo[] {
    return this.audit?.list() ?? [];
  }

  private readSession(id: string): SpectraEvent[] {
    if (!this.audit) return this.history.filter((e) => e.sessionId === id || e.sessionId === "hub");
    return this.audit.read(id);
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
      if (url.pathname === "/settings") return json(this.settingsView());
      if (url.pathname === "/health") return json(this.health());
      if (url.pathname === "/verify") {
        const id = url.searchParams.get("session");
        if (!id || !this.audit) return json({ ok: false, events: 0, reason: this.audit ? "no session given" : "audit log disabled" });
        return json(this.audit.verify(id));
      }
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
              // Agent/demo annotations can't speak as the hub or the Navigator.
              if (HUB_ONLY_EVENTS.includes(e?.type) || VALIDATOR_ONLY_EVENTS.includes(e?.type)) continue;
              // External callers can only speak as the agent (mcp) or the demo.
              const source = e.source === "demo" ? "demo" : "mcp";
              if (source === "mcp") this.seen.mcp = Date.now();
              const event = { ts: Date.now(), ...e, source } as SpectraEvent;
              // The MCP server's default session ("mcp") joins the live session, so the agent's
              // findings land in that session's record, replay and report.
              if (source === "mcp" && event.sessionId === "mcp" && this.state.sessionId) event.sessionId = this.state.sessionId;
              if (event.type === "finding.upsert") event.finding = { ...event.finding, reportedBy: source };
              this.publish(event);
            }
          } else if (url.pathname === "/validator") {
            // Only the Navigator speaks here, and only in leads and finding verdicts.
            for (const e of Array.isArray(body) ? body : [body]) {
              if (!VALIDATOR_ONLY_EVENTS.includes(e?.type)) continue;
              this.seen.validator = Date.now();
              this.publish({ ts: Date.now(), ...e, source: "validator" } as SpectraEvent);
            }
          } else if (url.pathname === "/import") {
            if (!Array.isArray(body?.entries)) return void res.writeHead(400).end("expected { entries: [...] }");
            this.seen.import = Date.now();
            return json(this.importTraffic(body.entries, body));
          } else if (url.pathname === "/scope") {
            // A field left out keeps its current value, so `{ hosts }` alone doesn't clear the paths.
            const current = this.state.scope;
            const paths = Array.isArray(body?.paths) ? body.paths : current?.paths;
            const hosts = Array.isArray(body?.hosts) ? body.hosts : current?.hosts;
            const origin = Array.isArray(body?.paths) ? "config" : (current?.origin ?? "session");
            this.setScope(makeScope({ paths, hosts }, origin), "operator");
          } else if (url.pathname === "/settings") {
            if (body?.localTool) this.setLocalTool(body.localTool.name, body.localTool.local);
            return json(this.updateSettings(body?.navigator ?? {}, body?.interpreter?.mode));
          } else if (url.pathname === "/navigator/test") {
            return void this.testNavigator().then(json);
          } else if (url.pathname === "/actions/resolve") {
            return json({ resolved: this.resolveActions(body?.toolUseId, body?.all, body?.note) });
          } else if (url.pathname === "/engagement/new") {
            this.newEngagement();
          } else if (url.pathname === "/triage") {
            if (!this.triage(body?.nodeId, body?.state ?? null, body?.note)) return void res.writeHead(400).end("unknown target or state");
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

/** A bounded map: the oldest entry makes room for a new one. */
function remember<V>(map: Map<string, V>, key: string, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value as string);
}

/** A tool call's input as text for a reader: the command for Bash, compact JSON otherwise. */
function describeInput(input: unknown, material?: string): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const text = typeof i.command === "string" ? i.command : JSON.stringify(i);
  // With scripts and loops expanded, when that says more than the command line does.
  if (material && material.trim() !== text.trim()) return `${text.slice(0, 1200)}\n# as expanded, with the scripts it runs:\n${material.slice(0, 2800)}`;
  return text.slice(0, 4000);
}

/** What the hub keeps, in memory only, about an action waiting to be read. */
interface ActionData {
  sessionId: string;
  tool: string;
  input: string;
  output?: string;
  /** Addresses the command is known to sweep. */
  probes?: string[];
  /** Every address the command is known to request. */
  known?: string[];
  /** Targets the hub's own reading of the output has already added. */
  added?: number;
  /** The command as expanded, with the source of scripts it runs. */
  material?: string;
  command?: string;
  cwd?: string;
}

/** A result line kept as evidence: secrets masked as for the Interpreter, and query values dropped. */
const maskEvidence = (line: string) => redact(line).replace(/([?&][\w.[\]-]+)=[^&\s"']*/g, "$1=");

/** Names of files that hold credentials: environment files, key material, tool credential stores. */
const SECRET_FILE = /^\.env|\.env$|^\.envrc$|^\.netrc$|^\.npmrc$|^\.pgpass$|^\.git-credentials$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|jks|keystore)$|secret|credential|passwd|password|token/i;

/** How much of a command's output the hub reads. */
const OUTPUT_LIMIT = 200_000;

/** Hooks without tool_use_id: Pre and Post for the same call hash identically. */
function fallbackToolId(p: any) {
  return "h_" + crypto.createHash("sha1").update(`${p.session_id}|${p.tool_name}|${JSON.stringify(p.tool_input ?? {})}`).digest("hex").slice(0, 16);
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
