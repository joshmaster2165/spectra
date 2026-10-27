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

function scanShell(cmd: string): { kind: "path" | "host"; value: string }[] {
  const found: { kind: "path" | "host"; value: string }[] = [];
  for (const m of cmd.matchAll(/\bhttps?:\/\/[^\s'"`|;&<>)]+/gi)) found.push({ kind: "host", value: m[0] });
  for (const m of cmd.matchAll(/\b(?:ssh|scp|rsync|sftp)\b[^|;&]*?\b[\w.-]+@([\w.-]+\.[a-z]{2,}|\d+\.\d+\.\d+\.\d+)/gi)) {
    found.push({ kind: "host", value: `ssh://${m[1]}` });
  }
  const noUrls = cmd.replace(/\bhttps?:\/\/[^\s'"`]+/gi, " ");
  for (const m of noUrls.matchAll(/(?:^|[\s='"(:])((?:~|\/)[^\s'"`|;&<>()]*)/g)) {
    const p = m[1];
    if (p.split("/").filter(Boolean).length < 2) continue;
    if (HEURISTIC_IGNORE.some((pre) => p.startsWith(pre))) continue;
    found.push({ kind: "path", value: p });
  }
  return found;
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
function apexOf(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const sld = labels[labels.length - 2];
  const tld = labels[labels.length - 1];
  const take = tld.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** "/api/users/42/orders?x=1" → "/api/users/:id/orders"; undefined for the bare host. */
function normalizeRoute(url: string): string | undefined {
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
    .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? ":id" : seg));
  return segments.length ? "/" + segments.join("/") : undefined;
}

function dedupe(ts: Target[]): Target[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = `${t.kind}:${t.value}:${t.access}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
