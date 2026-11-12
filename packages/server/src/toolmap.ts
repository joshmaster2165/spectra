import os from "node:os";
import path from "node:path";
import type { AccessKind, EventSource, MapNode, SpectraEvent, Target } from "@spectra/schema";

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

  toolUse(t: ToolUse) {
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
    const targets = extractTargets(t.name, t.input, t.cwd);
    const surface = this.mapSurface(t.sessionId, t.ts, leaf.id, targets);
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
    const reason = opaqueReason(t.name, t.input, targets);
    if (reason) {
      this.emit({ ...base, type: "action.open", action: { toolUseId: t.id, tool: t.name, summary: summarize(t.name, t.input), nodeId: leaf.id, reason } });
    }
  }

  /**
   * Builds the attack-surface tree from hosts the agent contacted:
   * domain → subdomain → normalized endpoint path. Returns the node ids touched.
   */
  private mapSurface(sessionId: string, ts: number, fromId: string, targets: Target[]): string[] {
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
      this.emit({ ...base, type: "node.upsert", node: { id: domainId, label: apex, kind: "category", status: "active", parentId: surfaceId, category: "hosts" } });
      let hostId = domainId;
      if (hostname !== apex) {
        hostId = `host:${hostname}`;
        this.emit({ ...base, type: "node.upsert", node: { id: hostId, label: hostname, kind: "category", status: "active", parentId: domainId, category: "hosts" } });
      }
      touched.push(hostId);
      const route = t.url ? normalizeRoute(t.url) : undefined;
      let targetId = hostId;
      if (route) {
        targetId = `endpoint:${hostname}${route}`;
        this.emit({
          ...base,
          type: "node.upsert",
          node: { id: targetId, label: route, kind: "leaf", status: "active", parentId: hostId, category: "endpoints", meta: { host: hostname, example: t.url } },
        });
        touched.push(targetId);
      }
      this.emit({ ...base, type: "edge.upsert", edge: { id: `${fromId}=>${targetId}`, source: fromId, target: targetId, label: "request" } });
    }
    return touched;
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

  if (tool === "Bash" && typeof input.command === "string") {
    for (const t of scanShell(input.command)) {
      if (t.kind === "host") addHost(t.value, true);
      else addPath(t.value, "exec", true);
    }
    return dedupe(out);
  }

  // Structured fields first, then a shallow scan of any other string values
  // (covers MCP tools such as browser navigation that take a `url`).
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof input[key] === "string") addPath(input[key], access);
  }
  if (typeof input.url === "string") addHost(input.url);
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string" || ["file_path", "notebook_path", "path", "url"].includes(k)) continue;
    if (/^https?:\/\//i.test(v)) addHost(v);
    else if (/(^|_)(path|dir|cwd|file)$/i.test(k) && v.startsWith("/")) addPath(v, access);
  }
  return dedupe(out);
}

function scanShell(rawCmd: string): { kind: "path" | "host"; value: string }[] {
  const cmd = expandShell(rawCmd);
  const found: { kind: "path" | "host"; value: string }[] = [];
  // A value still holding a shell variable, command substitution or brace list
  // wasn't resolved — skip it rather than map "/$p" or "/{a,b}" as a real target.
  const unresolved = (s: string) => /[$`{}]/.test(s);
  for (const m of cmd.matchAll(/\bhttps?:\/\/[^\s'"`|;&<>)]+/gi)) {
    // `?` and `*` are legitimate in a query string, so check only the URL path.
    const beforeQuery = m[0].split("?")[0];
    if (unresolved(m[0]) || /[*]/.test(beforeQuery)) continue;
    // A fuzzer's placeholder (ffuf, wfuzz) isn't a path: keep the part of the URL before it.
    const fuzz = m[0].search(/\bFUZZ\b|\bFUZ\dZ\b/);
    const query = m[0].indexOf("?");
    if (fuzz < 0) found.push({ kind: "host", value: m[0] });
    // Fuzzing a parameter's value: the endpoint itself is real.
    else if (query >= 0 && fuzz > query) found.push({ kind: "host", value: m[0].slice(0, query) });
    else if (m[0].slice(0, fuzz).replace(/^https?:\/\//i, "").includes("/")) found.push({ kind: "host", value: m[0].slice(0, m[0].lastIndexOf("/", fuzz) + 1) });
  }
  for (const m of cmd.matchAll(/\b(?:ssh|scp|rsync|sftp)\b[^|;&]*?\b[\w.-]+@([\w.-]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+)/gi)) {
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
  const noUrls = cmd.replace(/\bhttps?:\/\/[^\s'"`]+/gi, " ");
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

/**
 * Recon leans on looped one-liners — `for p in a b c; do curl "$B/$p"; done`.
 * The hook sees one unexpanded command, so expand the simple, safe cases here:
 * scalar `VAR=value` assignments and `for VAR in items; do … done` loops. The
 * aim is to recover the real URLs a loop would hit, not to be a shell; anything
 * left with a `$` is dropped by scanShell rather than mapped as a literal.
 */
export function expandShell(cmd: string): string {
  if (cmd.length > 4000 || !/[$]/.test(cmd)) return cmd;
  const strip = (v: string) => (/^["'].*["']$/.test(v) ? v.slice(1, -1) : v);
  // Simple scalar assignments: BASE=http://host, dir=/x/y. No spaces, no `$`.
  const vars = new Map<string, string>();
  for (const m of cmd.matchAll(/(?:^|[\s;&|(]|&&|\|\|)([A-Za-z_]\w*)=("[^"$`]*"|'[^'$`]*'|[^\s;&|$`"']+)/g)) {
    vars.set(m[1], strip(m[2]));
  }
  const subst = (text: string, name: string, value: string) =>
    text.replace(new RegExp("\\$\\{" + name + "\\}|\\$" + name + "(?![A-Za-z0-9_])", "g"), value);

  // Expand for-loops first, substituting the loop variable per item.
  let out = cmd.replace(
    /\bfor\s+([A-Za-z_]\w*)\s+in\s+([^\n;]+?)\s*;\s*do\s+([\s\S]*?)\s*;?\s*done/gi,
    (whole, name: string, itemsRaw: string, body: string) => {
      const items = itemsRaw
        .trim()
        .split(/\s+/)
        .filter((it) => it && !/[$`(){}*?]/.test(it));
      if (!items.length) return whole;
      return items.map((it) => subst(body, name, strip(it))).join("\n");
    },
  );
  // Then substitute scalar variables (a base URL used inside the loop body).
  for (const [name, value] of vars) out = subst(out, name, value);
  return out;
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
export function opaqueReason(tool: string, input: Input, targets: Target[]): string | undefined {
  const hosts = targets.filter((t) => t.kind === "host").length;
  if (tool !== "Bash") {
    if (LOCAL_TOOLS.test(tool) || tool.startsWith("mcp__spectra")) return;
    if (hosts) return;
    return tool.startsWith("mcp__") ? "A tool call with no target Spectra can read" : tool === "WebFetch" ? "A fetch with no readable address" : `Spectra doesn't know the ${tool} tool`;
  }
  if (typeof input.command !== "string" || !input.command.trim()) return;
  const cmd = expandShell(input.command);
  if (input.run_in_background === true) return "Runs in the background, so its output never reaches Spectra";
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
    if (DISCOVERY.has(prog)) return `${prog}'s results are in its output`;
    if (SCRIPT_RUNNERS.has(prog)) {
      // Version checks and the JSON pretty-printer are plain local use.
      if (/\s(--version|-V|-v)\s*$/.test(cmd) || /\s-m\s+json\.tool\b/.test(cmd)) continue;
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
    const route = t.kind === "host" && t.url ? (normalizeRoute(t.url) ?? "") : "";
    const k = `${t.kind}:${t.value}:${t.access}:${route}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
