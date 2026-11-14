import os from "node:os";
import path from "node:path";
import type { AccessKind, EventSource, MapNode, NodeStatus, SpectraEvent, Target } from "@spectra/schema";
import { expand, type Expansion, type ShellContext } from "./shell.ts";

export { expandShell } from "./shell.ts";

/**
 * Turns Claude Code tool activity into SpectraEvents. Shared by the hook
 * ingester and the transcript observer so both produce identical node ids.
 */

const CATEGORY_BY_TOOL: Record<string, string> = {
  Read: "files",
  Edit: "files",
  MultiEdit: "files",
  Write: "files",
  NotebookEdit: "files",
  LS: "files",
  Glob: "searches",
  Grep: "searches",
  Bash: "commands",
  BashOutput: "commands",
  WebFetch: "web",
  WebSearch: "web",
  Task: "agents",
  Agent: "agents",
};

const ACCESS_BY_TOOL: Record<string, AccessKind> = {
  Read: "read",
  LS: "read",
  Glob: "read",
  Grep: "read",
  NotebookRead: "read",
  Edit: "write",
  MultiEdit: "write",
  Write: "write",
  NotebookEdit: "write",
  Bash: "exec",
  WebFetch: "network",
};

/** Shell paths that are almost always tool plumbing, not targets. */
const HEURISTIC_IGNORE = ["/dev/", "/usr/", "/bin/", "/sbin/", "/opt/homebrew/", "/System/", "/private/var/folders/"];

type Input = Record<string, any>;

export interface ToolUse {
  sessionId: string;
  cwd?: string;
  id: string;
  name: string;
  input: Input;
  ts: number;
}

export class Translator {
  private seenSessions = new Set<string>();
  private pending = new Map<string, string[]>(); // toolUseId → nodes to settle on result

  constructor(
    private source: EventSource,
    private emit: (e: SpectraEvent) => void,
    /** Lets the command reader open scripts and wordlists the driver's commands use. */
    private readFile?: ShellContext["readFile"],
    /** Lets the hub withhold a flag it has reason not to raise: a tool the operator called local, a browser already flagged. */
    private suppress?: (t: ToolUse, reading: CallReading) => boolean,
  ) {}

  /** After the map is cleared: sessions still running start again from their root. */
  forget() {
    this.seenSessions.clear();
  }

  session(sessionId: string, cwd: string | undefined, ts: number, title?: string) {
    if (this.seenSessions.has(sessionId)) return;
    this.seenSessions.add(sessionId);
    const base = { ts, sessionId, source: this.source };
    this.emit({ ...base, type: "session.start", cwd, title });
    this.emit({
      ...base,
      type: "node.upsert",
      node: { id: rootId(sessionId), label: cwd ? path.basename(cwd) : sessionId, kind: "root", status: "active" },
    });
  }

  toolUse(t: ToolUse): CallReading {
    this.session(t.sessionId, t.cwd, t.ts);
    const base = { ts: t.ts, sessionId: t.sessionId, source: this.source };
    const category = categoryOf(t.name);
    const categoryId = `${rootId(t.sessionId)}:${category}`;
    this.emit({
      ...base,
      type: "node.upsert",
      node: { id: categoryId, label: category, kind: "category", status: "active", parentId: rootId(t.sessionId), category },
    });
    const leaf = leafFor(t, categoryId, category);
    this.emit({ ...base, type: "node.upsert", node: leaf });
    const reading = readCall(t.name, t.input, t.cwd, this.readFile);
    if (reading.reason && this.suppress?.(t, reading)) reading.reason = undefined;
    const targets = reading.targets;
    // Probes are checked against the scope now and mapped later, once the output shows which answered.
    const surface = this.mapSurface(
      t.sessionId,
      t.ts,
      leaf.id,
      targets.filter((x) => !x.probe),
    );
    this.pending.set(t.id, [leaf.id, ...surface]);
    this.emit({
      ...base,
      type: "tool.call",
      toolUseId: t.id,
      tool: t.name,
      summary: summarize(t.name, t.input),
      nodeId: leaf.id,
      targets,
    });
    // Recorded either way; flagged when the hub can't tell what it touched.
    if (reading.reason) {
      this.emit({ ...base, type: "action.open", action: { toolUseId: t.id, tool: t.name, summary: summarize(t.name, t.input), nodeId: leaf.id, reason: reading.reason } });
    }
    return reading;
  }

  /**
   * Addresses a finished call is now known to have reached — probes its output
   * confirmed — mapped as the driver's own traffic.
   */
  mapConfirmed(sessionId: string, ts: number, fromId: string, hits: { url: string; status?: number }[]): number {
    const targets: Target[] = [];
    const codes = new Map<string, number>();
    for (const h of hits) {
      const host = hostOf(h.url);
      if (!host) continue;
      const url = namesOnly(h.url);
      targets.push({ kind: "host", value: host, access: "network", heuristic: true, url });
      if (h.status) codes.set(url, h.status);
    }
    return this.mapSurface(sessionId, ts, fromId, dedupe(targets), "complete", (url) => (codes.has(url) ? { "status codes": String(codes.get(url)) } : undefined)).length;
  }

  /**
   * Builds the attack-surface tree from hosts the agent contacted:
   * domain → subdomain → normalized endpoint path. Returns the node ids touched.
   */
  private mapSurface(
    sessionId: string,
    ts: number,
    fromId: string,
    targets: Target[],
    status: NodeStatus = "active",
    extra?: (url: string) => Record<string, unknown> | undefined,
  ): string[] {
    const base = { ts, sessionId, source: this.source };
    const touched: string[] = [];
    for (const t of targets) {
      if (t.kind !== "host") continue;
      const hostname = t.value.replace(/^ssh:\/\//, "");
      const surfaceId = `${rootId(sessionId)}:hosts`;
      this.emit({
        ...base,
        type: "node.upsert",
        node: { id: surfaceId, label: "hosts", kind: "category", status: "active", parentId: rootId(sessionId), category: "hosts" },
      });
      const apex = apexOf(hostname);
      const domainId = `domain:${apex}`;
      this.emit({ ...base, type: "node.upsert", node: { id: domainId, label: apex, kind: "category", status, parentId: surfaceId, category: "hosts" } });
      let hostId = domainId;
      if (hostname !== apex) {
        hostId = `host:${hostname}`;
        this.emit({ ...base, type: "node.upsert", node: { id: hostId, label: hostname, kind: "category", status, parentId: domainId, category: "hosts" } });
      }
      touched.push(hostId);
      const route = t.url ? normalizeRoute(t.url) : undefined;
      let targetId = hostId;
      if (route) {
        targetId = `endpoint:${hostname}${route}`;
        this.emit({
          ...base,
          type: "node.upsert",
          node: {
            id: targetId,
            label: route,
            kind: "leaf",
            status,
            parentId: hostId,
            category: "endpoints",
            meta: { host: hostname, example: (t.url ?? "").split("?")[0], ...(t.url ? extra?.(t.url) : undefined) },
          },
        });
        touched.push(targetId);
        // Parameter names the driver sent; values are never kept.
        for (const name of paramNames(t.url)) {
          const paramId = `param:${hostname}${route}?${name}`;
          this.emit({ ...base, type: "node.upsert", node: { id: paramId, label: name, kind: "leaf", status, parentId: targetId, category: "params" } });
          touched.push(paramId);
        }
      }
      this.emit({ ...base, type: "edge.upsert", edge: { id: `${fromId}=>${targetId}`, source: fromId, target: targetId, label: "request" } });
    }
    return touched;
  }

  /** Notes the status a target already on the map answered with ("404": requested, and not there). */
  noteStatus(sessionId: string, ts: number, url: string, status: number) {
    const host = hostOf(url);
    const route = normalizeRoute(url);
    if (host && route) this.emit({ ts, sessionId, source: this.source, type: "node.upsert", node: { id: `endpoint:${host}${route}`, meta: { "status codes": String(status) } } as unknown as MapNode });
  }

  /** A call that was denied or blocked before it ran: it gets a result, and nothing it named is marked as reached. */
  toolSkipped(sessionId: string, toolUseId: string, ts: number) {
    this.pending.delete(toolUseId);
    this.emit({ ts, sessionId, source: this.source, type: "tool.result", toolUseId, ok: false, ran: false });
  }

  /** True while a call has been seen but not its result. */
  isPending(toolUseId: string) {
    return this.pending.has(toolUseId);
  }

  toolResult(sessionId: string, toolUseId: string, ok: boolean, ts: number) {
    const base = { ts, sessionId, source: this.source };
    const nodeIds = this.pending.get(toolUseId) ?? [];
    this.pending.delete(toolUseId);
    this.emit({ ...base, type: "tool.result", toolUseId, ok });
    for (const id of nodeIds) {
      this.emit({ ...base, type: "node.upsert", node: { id, status: ok ? "complete" : "unexplored" } as MapNode });
    }
  }

  thought(sessionId: string, text: string, ts: number, reason?: string) {
    if (!text.trim()) return;
    this.emit({ ts, sessionId, source: this.source, type: "thought", text: truncate(text.trim(), 400), reason });
  }

  end(sessionId: string, ts: number, reason?: string) {
    this.emit({ ts, sessionId, source: this.source, type: "session.end", reason });
  }
}

export const rootId = (sessionId: string) => `root:${sessionId}`;

/** The map ids a URL stands for: its endpoint (or its host, for a bare origin), and the host and domain above it. */
export function surfaceIds(url: string): { target: string; host: string; domain: string } | undefined {
  const hostname = hostOf(url);
  if (!hostname) return;
  const domain = `domain:${apexOf(hostname)}`;
  const host = hostname === apexOf(hostname) ? domain : `host:${hostname}`;
  const route = normalizeRoute(url);
  return { target: route ? `endpoint:${hostname}${route}` : host, host, domain };
}

function categoryOf(name: string) {
  return CATEGORY_BY_TOOL[name] ?? (name.startsWith("mcp__") ? "mcp" : "other");
}

function primaryKey(input: Input): string | undefined {
  return input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.query ?? input.command ?? input.description ?? input.path;
}

function leafFor(t: ToolUse, parentId: string, category: string): MapNode {
  const key = primaryKey(t.input) ?? t.id;
  return {
    id: `${category}:${key}`,
    label: category === "files" ? path.basename(key) : truncate(key, 48),
    kind: "leaf",
    status: "active",
    parentId,
    category,
    meta: { tool: t.name, key },
  };
}

function summarize(name: string, input: Input): string {
  return truncate(`${name} ${primaryKey(input) ?? ""}`.trim(), 160);
}

/* ── Target extraction ─────────────────────────────────── */

export function extractTargets(tool: string, input: Input, cwd?: string): Target[] {
  const access: AccessKind = ACCESS_BY_TOOL[tool] ?? (tool.startsWith("mcp__") ? "network" : "read");
  const out: Target[] = [];
  const addPath = (p: string, acc: AccessKind, heuristic = false) => {
    const abs = resolvePath(p, cwd);
    if (abs) out.push({ kind: "path", value: abs, access: acc, heuristic: heuristic || undefined });
  };
  const addHost = (url: string, heuristic = false) => {
    const host = hostOf(url);
    if (host) out.push({ kind: "host", value: host, access: "network", heuristic: heuristic || undefined, url: /^https?:/i.test(url) ? url : undefined });
  };

  if (tool === "Bash" && typeof input.command === "string") return readCall(tool, input, cwd).targets;

  // An MCP tool can name its target many ways: a URL anywhere in its input, a host
  // and a path in separate fields, or a whole HTTP request as text. Read them all.
  if (tool.startsWith("mcp__")) {
    for (const url of addressesIn(input)) addHost(url);
    const named = Object.keys(input).some((k) => HOST_KEY.test(k) && typeof input[k] === "string");
    for (const [k, v] of Object.entries(input)) {
      // With a host beside it, "path" is a route on that host, not a file here.
      if (typeof v === "string" && v.startsWith("/") && /(^|_)(file_?path|notebook_path|dir|cwd|file)$/i.test(k)) addPath(v, access);
      else if (typeof v === "string" && v.startsWith("/") && k === "path" && !named) addPath(v, access);
    }
    return dedupe(out);
  }

  // Structured fields first, then a shallow scan of any other string values.
  for (const key of ["file_path", "notebook_path", "path"]) {
    // Claude Code's own record of a background command's output isn't a project file.
    if (typeof input[key] === "string" && !/\/tasks\/[\w-]+\.output$/.test(input[key])) addPath(input[key], access);
  }
  if (typeof input.url === "string") addHost(input.url);
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string" || ["file_path", "notebook_path", "path", "url"].includes(k)) continue;
    if (/^https?:\/\//i.test(v)) addHost(v);
    else if (/(^|_)(path|dir|cwd|file)$/i.test(k) && v.startsWith("/")) addPath(v, access);
  }
  return dedupe(out);
}

const HOST_KEY = /^(host|hostname|domain|target|server|authority|base_?url|origin)$/i;
const ROUTE_KEY = /^(path|endpoint|uri|route|url_?path|request_?path|resource)$/i;
const BARE_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$|^\d{1,3}(?:\.\d{1,3}){3}$|^localhost$/i;

/** Every address a structured tool input names, at any depth. */
function addressesIn(input: unknown, depth = 0, out: string[] = []): string[] {
  if (out.length >= 40 || depth > 4 || input === null || typeof input !== "object") return out;
  const obj = input as Record<string, unknown>;
  const strings = Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === "string");
  const secure = Object.entries(obj).some(([k, v]) => (/^(https|tls|ssl|secure|use_?https)$/i.test(k) && v === true) || (/^(scheme|protocol)$/i.test(k) && /^https/i.test(String(v))) || (/^port$/i.test(k) && String(v) === "443"));
  const port = Object.entries(obj).find(([k]) => /^port$/i.test(k))?.[1];
  for (const [, v] of strings) {
    // URLs written anywhere in a string.
    for (const m of v.slice(0, 20_000).matchAll(/\bhttps?:\/\/[^\s'"`<>()\\,;{}$|]+/gi)) if (out.length < 40) out.push(m[0].replace(/[.:!?*]+$/, ""));
    // A whole request as text: the request line and the Host header.
    const host = v.match(/(?:^|\n|\\n)Host:\s*([A-Za-z0-9.-]+(?::\d+)?)/i)?.[1];
    const line = v.match(/^\s*(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s\\]*)\s+HTTP\/[\d.]+/);
    if (host && line) out.push(`${secure || /:443$/.test(host) ? "https" : "http"}://${host}${line[1]}`);
  }
  // A host in one field and, perhaps, a route in another.
  const host = strings.find(([k, v]) => HOST_KEY.test(k) && BARE_HOST.test(v.replace(/:\d+$/, "")))?.[1];
  if (host) {
    const route = strings.find(([k, v]) => ROUTE_KEY.test(k) && v.startsWith("/"))?.[1] ?? "";
    const withPort = /:\d+$/.test(host) || !port || !/^\d+$/.test(String(port)) ? host : `${host}:${port}`;
    out.push(`${secure ? "https" : "http"}://${withPort}${route}`);
  }
  for (const v of Object.values(obj)) if (v && typeof v === "object") addressesIn(v, depth + 1, out);
  return out;
}

/** What one tool call asks for, as far as the hub can read it. */
export interface CallReading {
  targets: Target[];
  /** Why the hub can't vouch for everything the call touched; undefined when it read it fully. */
  reason?: string;
  /** Addresses the call sweeps through (a wordlist loop, a fuzzer): mapped only once the output shows which answered. */
  probes?: string[];
  /** Every address the call is known to request, swept or not: what its result lines are matched against. */
  known?: string[];
  /** The command as expanded, with the source of scripts it runs: what its output is read against. */
  material?: string;
  /** Set for a browser tool: whether the call works a page or reads the browser's own record of requests. */
  browser?: BrowserRole;
}

export type BrowserRole = "page" | "log" | "passive";

/** Why a page worked in a browser is listed as unread, once per session, until its requests are read. */
export const BROWSER_REASON = "Works a page in a browser; what the page requests is read when the driver lists the browser's network requests";

const BROWSER_SERVER = /^mcp__[\w.-]*(playwright|puppeteer|chrome|chromium|browser|devtools|selenium|webdriver|firefox)[\w.-]*__/i;
const BROWSER_VERB = /^(browser_|page_|navigate|goto|open_url|new_page|click|type|fill|press|select|submit|evaluate|drag|upload)/i;
const NETWORK_LOG = /network|(^|_)requests?$|(^|_)har$/i;
const PASSIVE_VERB = /snapshot|screenshot|console|tabs?_?(list|context)|(^|_)(list|get|read|find|wait|resize|close|install|hover|scroll|zoom|emulate|performance)/i;

/** What a browser tool call does, or undefined for a tool that isn't a browser's. */
export function browserRole(tool: string): BrowserRole | undefined {
  if (!tool.startsWith("mcp__")) return;
  const verb = tool.split("__").slice(2).join("__");
  if (!BROWSER_SERVER.test(tool) && !/^browser_/i.test(verb)) return;
  if (NETWORK_LOG.test(verb)) return "log";
  if (PASSIVE_VERB.test(verb) && !/navigate|click|type|fill|press|select|submit|evaluate|drag|upload/i.test(verb)) return "passive";
  return BROWSER_VERB.test(verb) || BROWSER_SERVER.test(tool) ? "page" : undefined;
}

export function readCall(tool: string, input: Input, cwd?: string, readFile?: ShellContext["readFile"]): CallReading {
  if (tool !== "Bash" || typeof input.command !== "string") {
    const targets = extractTargets(tool, input, cwd);
    const browser = browserRole(tool);
    // A page loads far more than the address it was sent to, so working one is never fully read from the call alone.
    // Looking at the page, or at the browser's own request log, reaches nothing new.
    const reason = browser === "page" ? BROWSER_REASON : browser ? undefined : opaqueReason(tool, input, targets);
    return { targets, reason, browser };
  }
  const exp = expand(input.command, { cwd, readFile });
  const out: Target[] = [];
  const probes = new Set<string>(exp.probes);
  for (const f of scanShell(input.command, exp)) {
    if (f.kind === "path") {
      const abs = resolvePath(f.value, cwd);
      if (abs) out.push({ kind: "path", value: abs, access: "exec", heuristic: true });
      continue;
    }
    const host = hostOf(f.value);
    if (!host) continue;
    if (f.bulk) probes.add(f.value);
    else out.push({ kind: "host", value: host, access: "network", heuristic: true, url: /^https?:/i.test(f.value) ? namesOnly(f.value) : undefined });
  }
  // Every host a sweep touches is still held to the scope, whether or not it answers.
  const probeHosts = new Set<string>();
  for (const u of probes) {
    const h = hostOf(u);
    if (h) probeHosts.add(h);
  }
  for (const h of [...probeHosts].slice(0, 200)) out.push({ kind: "host", value: h, access: "network", heuristic: true, probe: true });
  const targets = dedupe(out);
  const reason = opaqueReason(tool, input, targets, exp) ?? (probes.size ? `Sweeps ${probes.size} addresses; the ones that answer are mapped from its output` : undefined);
  return {
    targets,
    reason,
    probes: probes.size ? [...probes] : undefined,
    known: reason ? [...new Set([...probes, ...targets.filter((t) => t.url).map((t) => (t.url as string).split("?")[0])])] : undefined,
    material: reason ? [exp.text, ...exp.code].join("\n").slice(0, 80_000) : undefined,
  };
}

function scanShell(rawCmd: string, exp: Expansion = expand(rawCmd)): { kind: "path" | "host"; value: string; bulk?: boolean }[] {
  const found: { kind: "path" | "host"; value: string; bulk?: boolean }[] = [];
  // A value still holding a shell variable, command substitution or brace list
  // wasn't resolved — skip it rather than map "/$p" or "/{a,b}" as a real target.
  const unresolved = (s: string) => /[$`{}]/.test(s);
  for (const { url, bulk } of exp.urls) {
    // `?` and `*` are legitimate in a query string, so check only the URL path.
    const beforeQuery = url.split("?")[0];
    if (unresolved(url) || /[*]/.test(beforeQuery)) continue;
    // A fuzzer's placeholder (ffuf, wfuzz) isn't a path: keep the part of the URL before it.
    const fuzz = url.search(/\bFUZZ\b|\bFUZ\dZ\b/);
    const query = url.indexOf("?");
    if (fuzz < 0) found.push({ kind: "host", value: url, bulk });
    // Fuzzing a parameter's value: the endpoint itself is real.
    else if (query >= 0 && fuzz > query) found.push({ kind: "host", value: url.slice(0, query) });
    else if (url.slice(0, fuzz).replace(/^https?:\/\//i, "").includes("/")) found.push({ kind: "host", value: url.slice(0, url.lastIndexOf("/", fuzz) + 1) });
  }
  // Addresses written in the source of a script the command runs (a base URL, usually).
  let literals = 0;
  for (const code of exp.code) {
    // Not from comments: a link in a comment is documentation, not a place the script goes.
    const src = code.replace(/^\s*(#|\/\/).*$/gm, "");
    for (const m of src.matchAll(/\bhttps?:\/\/[^\s'"`<>()\\,;{}$]+/gi)) {
      if (literals++ < 30) found.push({ kind: "host", value: m[0] });
    }
  }
  // A request written out by hand and piped to nc or openssl: the request line and the Host header name the address.
  const rawHost = rawCmd.match(/(?:\\[rn]|\b)Host:\s*([A-Za-z0-9.-]+)/i)?.[1];
  if (rawHost) {
    const scheme = /\bopenssl\s+s_client\b|--ssl\b|:443\b|\s443\b/.test(rawCmd) ? "https" : "http";
    for (const m of rawCmd.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s'"\\]*)\s+HTTP\/[\d.]+/g)) {
      found.push({ kind: "host", value: `${scheme}://${rawHost}${m[1]}` });
    }
  }
  for (const m of exp.shell.matchAll(/\b(?:ssh|scp|rsync|sftp)\b[^|;&]*?\b[\w.-]+@([\w.-]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+)/gi)) {
    found.push({ kind: "host", value: `ssh://${m[1]}` });
  }
  // Routes of the URLs above: a "path" equal to one is a URL fragment (often from
  // a curl -w/-o format string), not a file — don't map it or flag it out of scope.
  const urlRoutes = new Set<string>();
  for (const f of found) {
    if (f.kind !== "host") continue;
    try {
      urlRoutes.add(new URL(f.value).pathname.replace(/\/+$/, "") || "/");
    } catch {
      /* not a parseable URL (ssh://host) */
    }
  }
  // File paths are read from the command as written: a wordlist entry such as
  // "/admin/config" is a route to try, not a file on this machine.
  const noUrls = rawCmd.replace(/\\\n/g, " ").replace(/\bhttps?:\/\/[^\s'"`]+/gi, " ");
  for (const m of noUrls.matchAll(/(?:^|[\s='"(:])((?:~|\/)[^\s'"`|;&<>()]*)/g)) {
    const p = m[1];
    if (p.split("/").filter(Boolean).length < 2) continue;
    if (unresolved(p) || /[*?]/.test(p)) continue;
    if (urlRoutes.has(p.replace(/\/+$/, ""))) continue;
    if (HEURISTIC_IGNORE.some((pre) => p.startsWith(pre))) continue;
    found.push({ kind: "path", value: p });
  }
  return found;
}

const PARAM_NAME = /^[\w.\-[\]]{1,64}$/;

/**
 * A URL with its query values dropped and the parameter names kept. Values can
 * be secrets — more so now that variables are filled in from files — and the
 * map only ever needs the names.
 */
function namesOnly(url: string): string {
  const at = url.indexOf("?");
  if (at < 0) return url;
  const names = paramNames(url);
  return names.length ? `${url.slice(0, at)}?${names.map((n) => `${n}=`).join("&")}` : url.slice(0, at);
}

/** Names of the query parameters in a URL. */
function paramNames(url?: string): string[] {
  const query = url?.split("#")[0].split("?")[1];
  if (!query) return [];
  const names = new Set<string>();
  for (const pair of query.split("&")) {
    const name = pair.split("=")[0];
    if (PARAM_NAME.test(name)) names.add(name);
  }
  return [...names].slice(0, 20);
}

/* ── Did the hub understand this action? ───────────────── */

/** Programs that only read, print or reshape local data: nothing to map. */
const INERT = new Set(
  (
    "cd echo printf cat head tail wc sort uniq cut tr sed awk gawk grep egrep fgrep rg jq yq ls pwd mkdir touch cp mv rm rmdir ln test [ [[ true false sleep date read export set unset local " +
    "declare tee column less more file stat find which type basename dirname diff comm paste rev seq xxd base64 md5 md5sum shasum sha1sum sha256sum git tree du df ps kill wait chmod " +
    "clear history alias tput nl fold strings hexdump od zcat gunzip gzip tar unzip zip sum bc expr tac shuf fmt realpath readlink mktemp return exit break continue : pbcopy pbpaste open " +
    // Build, package and test tools: they work on the project, not the target.
    "npm pnpm yarn pip pip3 brew cargo make cmake tsc eslint prettier pytest jest vitest rustc gcc g++ clang javac mvn gradle"
  ).split(" "),
);
/** HTTP clients whose target is written in the command, so the URL scan reads them. */
const HTTP_CLIENTS = new Set(["curl", "wget", "http", "https", "xh"]);
/** Tools whose discoveries are in their output, or whose targets come from a list. */
const DISCOVERY = new Set(
  (
    "ffuf gobuster dirsearch feroxbuster wfuzz dirb httpx httpx-toolkit nuclei nmap masscan naabu amass subfinder assetfinder findomain dnsx puredns massdns katana gau waybackurls hakrawler gospider " +
    "sqlmap nikto whatweb wpscan arjun paramspider dalfox kxss gf unfurl anew dig host nslookup whois ping traceroute nc ncat netcat telnet ssh openssl testssl testssl.sh sslscan wafw00f"
  ).split(" "),
);
/** Signs that a piece of code can make a request or start another program. */
const REACHES_OUT =
  /\b(urllib|urlopen|requests|httpx|aiohttp|http\.client|httplib|socket|websockets?|pycurl|subprocess|os\.system|popen|fetch|axios|XMLHttpRequest|node:https?|require\(\s*["'](?:https?|net|tls|dgram|child_process)["']|child_process|execSync|spawn|Net::HTTP|open-uri|HTTParty|Faraday|LWP|HTTP::Tiny|IO::Socket|file_get_contents|fsockopen|curl_init|curl|wget|nc)\b|https?:\/\/|`/i;
/**
 * True for code that can only request the URLs written in it: each one a
 * complete quoted string, with nothing in the code that could build another —
 * no string joining or formatting, no path fragments, no input from arguments,
 * files or other programs.
 */
function requestsOnlyLiterals(src: string): boolean {
  const code = src.replace(/^\s*(#|\/\/).*$/gm, "");
  const urls = code.match(/https?:\/\//gi)?.length ?? 0;
  const whole = code.match(/(?<![A-Za-z])(["'])https?:\/\/[^"'\s{}$%\\]+\1(?!\s*[+%.]\s*(?:["'\w(]))/g)?.length ?? 0;
  if (!urls || urls !== whole) return false;
  // Anything that could assemble or fetch a different address.
  return !/\bf["']|\$\{|\.format\(|urljoin|\.join\(|["']\s*\+|\+\s*["']|["']\/[\w.~-]|%\s*[(\w"']|\b(?:socket|subprocess|popen|os\.system|child_process|execSync|spawn|sys\.argv|process\.argv|input\(|open\(|stdin|readFile|http\.client|HTTPConnection|curl|wget|nc)\b|`/.test(code);
}

const SCRIPT_RUNNERS = new Set("python python2 python3 node deno bun ruby perl php bash sh zsh fish go java npx uvx uv pipx tsx ts-node pwsh osascript".split(" "));
/** Words before the program that aren't the program. */
const WRAPPERS = new Set("sudo time nohup command exec env nice stdbuf unbuffer builtin".split(" "));
const KEYWORDS = new Set("do done then else elif fi if while until in esac case { } ! function select".split(" "));
/** Claude Code's own bookkeeping tools: nothing reaches the target through them. */
const LOCAL_TOOLS = /^(Read|Edit|MultiEdit|Write|NotebookEdit|NotebookRead|LS|Glob|Grep|BashOutput|KillBash|KillShell|WebSearch|Agent|Skill|SlashCommand|ToolSearch|AskUserQuestion|(Task|Todo|Cron|Schedule|EnterPlan|ExitPlan|EnterWorktree|ExitWorktree|ListMcp|ReadMcp|SendMessage|ListAgents|Monitor)\w*)$/;

/** The program each simple command in a shell line runs, in order. */
export function programsOf(cmd: string): string[] {
  const bare = cmd
    .replace(/\\\n/g, " ")
    .replace(/'[^']*'/g, " Q ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " Q ");
  const out: string[] = [];
  for (const segment of bare.split(/\n|;|&&|\|\||\||&|\$\(|`|\(|\)/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (w === "for" || w === "select") break; // `for x in a b c`: a list, not a program
      if (KEYWORDS.has(w) || WRAPPERS.has(w) || /^[A-Za-z_]\w*=/.test(w) || /^-/.test(w)) i++;
      else if (w === "timeout" || w === "xargs" || w === "watch") {
        i++;
        while (i < words.length && /^(-|\d)/.test(words[i])) i++; // their own flags and durations
      } else break;
    }
    const w = words[i];
    if (!w || w === "for" || w === "select" || w === "Q" || /^[<>0-9]/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * Why the hub can't vouch for what a tool call touched — or undefined when it
 * read the call fully or there was nothing to read. A flagged action stays
 * open in the dashboard until the interpreter or the operator resolves it.
 */
export function opaqueReason(tool: string, input: Input, targets: Target[], exp?: Expansion): string | undefined {
  const hosts = targets.filter((t) => t.kind === "host").length;
  if (tool !== "Bash") {
    if (LOCAL_TOOLS.test(tool) || tool.startsWith("mcp__spectra")) return;
    if (hosts) return;
    return tool.startsWith("mcp__") ? "A tool call with no target Spectra can read" : tool === "WebFetch" ? "A fetch with no readable address" : `Spectra doesn't know the ${tool} tool`;
  }
  if (typeof input.command !== "string" || !input.command.trim()) return;
  // What the shell itself runs: loops unrolled, readable scripts inlined, other programs' input left out.
  const e = exp ?? expand(input.command);
  const cmd = e.shell;
  if (input.run_in_background === true) return "Runs in the background; read when the driver checks its output";
  // A URL still built from a variable or a subcommand after expansion.
  const noSingles = cmd.replace(/'[^']*'/g, " ");
  if (/\bhttps?:\/\/[^\s'"`|;&<>)]*[$`]/i.test(noSingles)) return "A URL is built from a value Spectra couldn't resolve";
  for (const raw of programsOf(cmd)) {
    const prog = raw.replace(/^.*\//, "");
    if (raw.startsWith("./") || raw.startsWith("../") || /\.(sh|py|rb|pl|js|mjs|ts|php)$/.test(raw)) return `Runs a script (${prog}), so its targets aren't in the command`;
    if (/[$`]/.test(raw)) return "Runs a program named by a variable";
    if (INERT.has(prog)) continue;
    if (HTTP_CLIENTS.has(prog)) {
      if (!hosts) return `${prog} was given a target Spectra couldn't resolve`;
      if (prog === "wget" && /\s-(i|-input-file)\b/.test(cmd)) return "wget reads its targets from a file";
      if (prog === "curl" && /\s(-K|--config)\b/.test(cmd)) return "curl reads its targets from a config file";
      continue;
    }
    // A request typed out by hand and piped to nc or openssl is read from its request line and Host header.
    if (/^(nc|ncat|netcat|telnet|openssl)$/.test(prog) && hosts && /\sHTTP\/[\d.]+/.test(input.command)) continue;
    if (DISCOVERY.has(prog)) return `${prog}'s results are in its output`;
    if (SCRIPT_RUNNERS.has(prog)) {
      // Version checks and the JSON pretty-printer are plain local use.
      if (/\s(--version|-V|-v)\s*$/.test(cmd) || /\s-m\s+json\.tool\b/.test(cmd)) continue;
      // Code the hub can read in full that has no way to reach anything is local data handling —
      // the `python3 -c "import json…"` at the end of a pipe.
      const sources = e ? [...e.code, ...e.inline] : [];
      if (e && sources.length && !e.missing && !sources.some((src) => REACHES_OUT.test(src))) continue;
      // Code whose every address is written out in full: the URL scan has already read all it can request.
      if (e && sources.length && !e.missing && hosts && sources.every((src) => !REACHES_OUT.test(src) || requestsOnlyLiterals(src))) continue;
      return `Runs code through ${prog}, so its targets aren't in the command`;
    }
    return `Spectra doesn't know the ${prog} command`;
  }
  return;
}

function resolvePath(p: string, cwd?: string): string | undefined {
  if (!p) return;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  if (path.isAbsolute(p)) return path.normalize(p);
  return cwd ? path.resolve(cwd, p) : undefined;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "") || undefined;
  } catch {
    return;
  }
}

/** Registrable domain, roughly: example.com, example.co.uk; IPs and single labels as-is. */
export function apexOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const sld = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const take = tld.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * "/api/users/42/orders?x=1" → "/api/users/:id/orders"; undefined for the bare host.
 * Long token-like segments (reset links, signed URLs) collapse to ":token" so
 * secrets in paths stay out of the map.
 */
export function normalizeRoute(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 6)
    .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? ":id" : isToken(seg) ? ":token" : seg));
  return segments.length ? "/" + segments.join("/") : undefined;
}

/** 20+ URL-safe characters mixing letters and digits; slugs (two or more hyphens) aren't tokens. */
function isToken(seg: string) {
  return /^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg) && /[A-Za-z]/.test(seg) && (seg.match(/-/g)?.length ?? 0) < 2;
}

function dedupe(ts: Target[]): Target[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    // Keep each distinct endpoint on a host: the route (from the url) is part of
    // the identity, so one command hitting several paths maps all of them.
    const route = t.kind === "host" && t.url ? `${normalizeRoute(t.url) ?? ""}?${paramNames(t.url).sort().join(",")}` : "";
    const k = `${t.kind}:${t.value}:${t.access}:${route}:${t.probe ? "probe" : ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
