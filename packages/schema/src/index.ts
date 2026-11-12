/**
 * Spectra event schema — the single contract between producers
 * (hooks, log observer, MCP server, demo) and consumers (dashboard).
 *
 * Every message on the wire is a SpectraEvent. The hub keeps a reduced
 * GraphState and sends it as a `snapshot` to clients when they connect,
 * then streams individual events. The same reducer drives replay.
 */

export type NodeKind = "root" | "category" | "leaf";

/** dim grey → pulsing orange → highlight glow */
export type NodeStatus = "unexplored" | "active" | "complete";

export type Importance = 1 | 2 | 3 | 4 | 5;

/**
 * Where an event came from. hook/observer are ground truth (what Claude Code
 * actually did); mcp/demo are claims made by the agent or a script; proxy is
 * traffic imported from proxy history (what crossed the wire, not what the
 * agent did); validator is the Navigator's advice.
 */
export type EventSource = "hook" | "observer" | "mcp" | "demo" | "hub" | "operator" | "validator" | "proxy";

export interface MapNode {
  id: string;
  label: string;
  kind: NodeKind;
  status: NodeStatus;
  /** Grouping key, e.g. "files", "routes", "params", "commands" */
  category?: string;
  parentId?: string;
  importance?: Importance;
  /** Set by the hub when a tool call touching this node left the scope. */
  outOfScope?: boolean;
  meta?: Record<string, unknown>;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

/** One step in the Chain Builder narrative. */
export interface ChainStep {
  id: string;
  chainId: string;
  title: string;
  detail?: string;
  /** Map nodes this step refers to */
  nodeIds?: string[];
  /** Step ids this step follows from (directed arrows) */
  after?: string[];
  confirmed?: boolean;
}

/* ── Scope ─────────────────────────────────────────────── */

/** read < network/exec/write in how much a boundary crossing matters. */
export type AccessKind = "read" | "write" | "exec" | "network";

export interface Target {
  kind: "path" | "host";
  /** Absolute path or lowercase hostname */
  value: string;
  access: AccessKind;
  /** Extracted by pattern-matching a shell command rather than a structured field. */
  heuristic?: boolean;
  /** Full URL for host targets, when known; drives the endpoint map. */
  url?: string;
}

export interface Scope {
  /** Absolute directories the agent may touch. */
  paths: string[];
  /** Hostnames the agent may contact (subdomains included). */
  hosts: string[];
  /** "config" = set by the operator; "session" = defaulted to the session's cwd. */
  origin: "config" | "session";
}

export type ViolationSeverity = "medium" | "high";

export interface ScopeViolation {
  id: string;
  ts: number;
  sessionId: string;
  toolUseId: string;
  tool: string;
  nodeId?: string;
  target: Target;
  severity: ViolationSeverity;
  summary: string;
}

/* ── Audit log ─────────────────────────────────────────── */

/** Result of checking a session's hash-chained audit log. */
export interface AuditVerification {
  ok: boolean;
  events: number;
  /** Hash of the last line; record it elsewhere to detect a rewritten log. */
  head?: string;
  /** First line that failed, 1-based. */
  badLine?: number;
  reason?: string;
}

/* ── Findings ──────────────────────────────────────────── */

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "suspected" | "confirmed" | "dismissed" | "fixed";

/** The operator's verdict, kept separate from the agent's own status claim. */
export interface Review {
  verdict: "verified" | "rejected" | "needs-info";
  note?: string;
  ts: number;
}

/** An edit the agent made to a file named in a finding's location. */
export interface FixEdit {
  toolUseId: string;
  tool: string;
  path: string;
  ts: number;
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  /** 0–1, the agent's own estimate */
  confidence: number;
  status: FindingStatus;
  description?: string;
  location?: { file: string; line?: number };
  /** Map nodes that support this finding */
  nodeIds?: string[];
  /** Chain steps that led here, in order */
  stepIds?: string[];
  /** Who reported it — agent-reported findings are claims to verify. */
  reportedBy?: EventSource;
  /** Session the finding was reported in. */
  sessionId?: string;
  review?: Review;
  /** The Navigator's independent read on this finding, separate from the operator's review. */
  assessment?: FindingAssessment;
  /** Edits to the finding's file, linked by the hub. */
  edits?: FixEdit[];
}

/** How the agent touched one file, from observed tool calls. */
export interface FileTouch {
  reads: number;
  writes: number;
  lastTs: number;
}

/* ── Navigator (the validator in the second seat) ──────── */

/** What the Navigator makes of a lead: chase it, keep it in view, or leave it. */
export type Recommendation = "pursue" | "watch" | "skip";

/**
 * The Navigator's independent read on a map area — a scored lead. A second AI,
 * reading the same map the operator sees, points at where the promise is. It is
 * advice, never authority: the driver acts, the operator decides.
 */
export interface Assessment {
  id: string;
  /** The map node (or cluster root) this lead points at. */
  nodeId?: string;
  title: string;
  /** One or two lines: why this is (or isn't) worth the driver's time. */
  rationale?: string;
  /** Suspected bug class, e.g. "idor", "authz", "injection", "ssrf". */
  bugClass?: string;
  /** 0–1 promise score. */
  confidence: number;
  recommendation: Recommendation;
  ts: number;
}

/** The Navigator's verdict on a driver-reported finding. */
export interface FindingAssessment {
  verdict: "corroborated" | "unconvinced" | "needs-evidence";
  /** 0–1 confidence in the verdict. */
  confidence: number;
  rationale?: string;
  ts: number;
}

/* ── Triage (the operator's recon worklist) ────────────── */

/** Where a target stands in the operator's own testing plan. */
export type TriageState = "queued" | "testing" | "tested" | "skipped";

export const TRIAGE_LABEL: Record<TriageState, string> = { queued: "To test", testing: "Testing", tested: "Tested", skipped: "Skip" };

/** The operator's mark on a target; the agent and the Navigator can't set it. */
export interface Triage {
  state: TriageState;
  note?: string;
  ts: number;
}

/* ── Surface tags ──────────────────────────────────────── */

export const SURFACE_TAGS = ["api", "graphql", "auth", "admin", "internal", "exposed", "docs", "files", "payments", "webhook", "object-id"] as const;
export type SurfaceTag = (typeof SURFACE_TAGS)[number];

const TAG_RULES: { tag: SurfaceTag; host?: RegExp; route?: RegExp }[] = [
  { tag: "api", host: /^(api|rest|gateway)\./, route: /(^|\/)(api|rest|v\d+)(\/|$)/ },
  { tag: "graphql", route: /graphi?ql/ },
  {
    tag: "auth",
    host: /^(auth|sso|login|id|accounts?|identity|oauth)\./,
    route: /(^|[/._-])(login|logout|signin|signup|register|oauth|authorize|token|sso|saml|password|reset|session|mfa|2fa|otp|userinfo|openid-configuration|jwks)($|[/._-])/,
  },
  { tag: "admin", host: /^(admin|manage|console|backoffice|staff)\./, route: /(^|\/)(admin|manage|management|console|backoffice|dashboard|staff)(\/|$)/ },
  {
    tag: "internal",
    host: /^(staging|stage|dev|test|qa|internal|debug|uat|sandbox)\./,
    route: /(^|\/)(internal|debug|actuator|metrics|health|healthz|server-status|trace|seed|phpinfo)(\/|$)/,
  },
  { tag: "exposed", route: /(^|\/)\.(git|svn|hg|env|htpasswd|ds_store)(\/|$)|(^|\/)(backup|backups|dump)(\/|$)|\.(sql|bak|old|zip|tar|gz)$/ },
  { tag: "docs", host: /^(docs|developers?|swagger)\./, route: /swagger|openapi|api-docs|redoc|playground/ },
  { tag: "files", route: /(^|\/)(uploads?|import|export|downloads?|files?|attachments?|avatar|media|documents?)(\/|$)/ },
  { tag: "payments", host: /^(pay|payments?|billing|checkout)\./, route: /payment|checkout|billing|invoice|refund|coupon|cart|order|intent|subscription|wallet/ },
  { tag: "webhook", route: /webhook|callback/ },
  { tag: "object-id", route: /:(id|token)(\/|$)/ },
];

/**
 * What kind of surface a route on a host looks like, from its name alone.
 * Heuristic labels for sorting and filtering recon — not findings.
 */
export function surfaceTags(route: string, host = ""): SurfaceTag[] {
  const r = route.toLowerCase();
  const h = host.toLowerCase();
  return TAG_RULES.filter((t) => (t.host && h && t.host.test(h)) || (t.route && r && t.route.test(r))).map((t) => t.tag);
}

/* ── Proxy import ──────────────────────────────────────── */

/**
 * One request from proxy history, reduced to what the map needs. Only
 * parameter *names* are kept: values (tokens, passwords, personal data) never
 * leave the importer, and the URL is sent without its query string.
 */
export interface HttpEntry {
  method: string;
  url: string;
  status?: number;
  mime?: string;
  params?: string[];
}

/** What an import added to the map and what it left out. */
export interface ImportSummary {
  requests: number;
  imported: number;
  endpoints: number;
  newEndpoints: number;
  params: number;
  skippedStatic: number;
  skippedOutOfScope: number;
  /** Most frequent out-of-scope hosts, for the operator to check. */
  outOfScopeHosts: string[];
  hint?: string;
}

const MAX_PARAMS = 40;

/** Reads a HAR 1.2 file (Burp, Caido, ZAP, browser devtools) into compact entries. */
export function parseHar(har: unknown): HttpEntry[] {
  const entries = (har as { log?: { entries?: unknown } } | null)?.log?.entries;
  if (!Array.isArray(entries)) throw new Error("Not a HAR file: expected log.entries");
  const out: HttpEntry[] = [];
  for (const e of entries as any[]) {
    const req = e?.request;
    if (typeof req?.url !== "string" || !/^https?:\/\//i.test(req.url)) continue;
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      continue;
    }
    const names = new Set<string>(url.searchParams.keys());
    for (const q of req.queryString ?? []) if (q?.name) names.add(String(q.name));
    for (const p of req.postData?.params ?? []) if (p?.name) names.add(String(p.name));
    if (typeof req.postData?.text === "string") bodyParamNames(req.postData.text, String(req.postData.mimeType ?? ""), names);
    url.search = url.hash = url.username = url.password = "";
    const status = e.response?.status;
    const mime = e.response?.content?.mimeType;
    out.push({
      method: String(req.method ?? "GET").toUpperCase(),
      url: url.toString(),
      status: typeof status === "number" && status > 0 ? status : undefined,
      mime: typeof mime === "string" && mime ? mime.split(";")[0].trim().toLowerCase() : undefined,
      params: names.size ? [...names].slice(0, MAX_PARAMS) : undefined,
    });
  }
  return out;
}

/** Top-level field names from a JSON or form-encoded request body. */
function bodyParamNames(text: string, mime: string, names: Set<string>) {
  if (!text) return;
  if (mime.includes("json") || /^\s*\{/.test(text)) {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) names.add(k);
    } catch {
      // Not JSON after all.
    }
  } else if (mime.includes("x-www-form-urlencoded")) {
    for (const k of new URLSearchParams(text).keys()) names.add(k);
  }
}

export function emptySummary(): ImportSummary {
  return { requests: 0, imported: 0, endpoints: 0, newEndpoints: 0, params: 0, skippedStatic: 0, skippedOutOfScope: 0, outOfScopeHosts: [] };
}

/** Totals for an import sent in several chunks. */
export function addSummary(a: ImportSummary, b: ImportSummary): ImportSummary {
  return {
    requests: a.requests + b.requests,
    imported: a.imported + b.imported,
    endpoints: a.endpoints + b.endpoints,
    newEndpoints: a.newEndpoints + b.newEndpoints,
    params: a.params + b.params,
    skippedStatic: a.skippedStatic + b.skippedStatic,
    skippedOutOfScope: a.skippedOutOfScope + b.skippedOutOfScope,
    outOfScopeHosts: [...new Set([...a.outOfScopeHosts, ...b.outOfScopeHosts])].slice(0, 8),
    hint: b.hint ?? a.hint,
  };
}

/** One line for the CLI, the dashboard and the activity stream. */
export function describeImport(s: ImportSummary): string {
  const skipped = [s.skippedOutOfScope && `${s.skippedOutOfScope} out of scope`, s.skippedStatic && `${s.skippedStatic} static`].filter(Boolean);
  return (
    `Imported ${s.imported} of ${s.requests} requests: ${s.endpoints} endpoints (${s.newEndpoints} new), ${s.params} parameters` +
    (skipped.length ? `; skipped ${skipped.join(", ")}` : "") +
    "."
  );
}

/* ── Events ────────────────────────────────────────────── */

interface Base {
  /** ms since epoch */
  ts: number;
  sessionId: string;
  source: EventSource;
}

export type SpectraEvent =
  | (Base & { type: "session.start"; cwd?: string; title?: string })
  | (Base & { type: "session.end"; reason?: string })
  | (Base & { type: "node.upsert"; node: MapNode })
  | (Base & { type: "edge.upsert"; edge: MapEdge })
  | (Base & { type: "chain.step"; step: ChainStep })
  | (Base & { type: "thought"; text: string; reason?: string })
  | (Base & {
      type: "tool.call";
      toolUseId: string;
      tool: string;
      summary: string;
      nodeId?: string;
      targets?: Target[];
    })
  | (Base & { type: "tool.result"; toolUseId: string; ok: boolean })
  | (Base & { type: "scope.set"; scope: Scope })
  | (Base & { type: "scope.violation"; violation: ScopeViolation })
  | (Base & { type: "finding.upsert"; finding: Finding })
  | (Base & { type: "finding.review"; findingId: string; review: Review })
  | (Base & { type: "finding.edit"; findingId: string; edit: FixEdit })
  | (Base & { type: "target.triage"; nodeId: string; triage: Triage | null })
  | (Base & { type: "assessment.upsert"; assessment: Assessment })
  | (Base & { type: "finding.assessment"; findingId: string; assessment: FindingAssessment });

export type SpectraEventType = SpectraEvent["type"];

/** Event types only the hub itself may produce; rejected from POST /events. */
export const HUB_ONLY_EVENTS: SpectraEventType[] = ["scope.set", "scope.violation", "finding.review", "finding.edit", "target.triage"];

/** Only the Navigator (via the hub's /validator endpoint) may produce these; rejected from POST /events. */
export const VALIDATOR_ONLY_EVENTS: SpectraEventType[] = ["assessment.upsert", "finding.assessment"];

export interface GraphState {
  sessionId?: string;
  nodes: Record<string, MapNode>;
  edges: Record<string, MapEdge>;
  chain: Record<string, ChainStep>;
  findings: Record<string, Finding>;
  /** The Navigator's leads, keyed by assessment id. */
  assessments: Record<string, Assessment>;
  /** The operator's triage marks, keyed by node id. */
  triage: Record<string, Triage>;
  scope?: Scope;
  violations: ScopeViolation[];
  /** Absolute path → how the agent touched it */
  files: Record<string, FileTouch>;
  /** Running totals; the timeline itself is capped. */
  counts: { toolCalls: number; failed: number; firstTs?: number; lastTs?: number };
  /** Most recent last; capped by the reducer. */
  timeline: SpectraEvent[];
}

export type ServerMessage =
  | { kind: "snapshot"; state: GraphState }
  | { kind: "event"; event: SpectraEvent };

export interface SessionInfo {
  id: string;
  events: number;
  bytes: number;
  updated: number;
}

export const TIMELINE_LIMIT = 500;

export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export function emptyState(): GraphState {
  return { nodes: {}, edges: {}, chain: {}, findings: {}, assessments: {}, triage: {}, violations: [], files: {}, counts: { toolCalls: 0, failed: 0 }, timeline: [] };
}

/** Pure reducer shared by the hub, the live dashboard and replay. */
export function applyEvent(state: GraphState, e: SpectraEvent): GraphState {
  const next: GraphState = {
    ...state,
    timeline: [...state.timeline, e].slice(-TIMELINE_LIMIT),
    counts: {
      ...state.counts,
      firstTs: state.counts.firstTs ?? e.ts,
      lastTs: e.ts,
      toolCalls: state.counts.toolCalls + (e.type === "tool.call" ? 1 : 0),
      failed: state.counts.failed + (e.type === "tool.result" && !e.ok ? 1 : 0),
    },
  };
  switch (e.type) {
    case "session.start":
      next.sessionId = e.sessionId;
      break;
    case "node.upsert": {
      const prev = state.nodes[e.node.id];
      const node = { ...prev, ...e.node };
      // Merge properties rather than replace them, so traffic stats survive agent updates.
      if (prev?.meta && e.node.meta) node.meta = { ...prev.meta, ...e.node.meta };
      // Surface first seen in proxy traffic that the agent now touches is seen in both.
      if (prev && node.meta?.["seen in"] === "proxy traffic" && e.source !== "proxy") {
        node.meta = { ...node.meta, "seen in": "agent and proxy traffic" };
      }
      next.nodes = { ...state.nodes, [e.node.id]: node };
      if (e.node.parentId) {
        const id = `${e.node.parentId}->${e.node.id}`;
        next.edges = {
          ...state.edges,
          [id]: { id, source: e.node.parentId, target: e.node.id },
        };
      }
      break;
    }
    case "edge.upsert":
      next.edges = { ...state.edges, [e.edge.id]: e.edge };
      break;
    case "chain.step":
      next.chain = {
        ...state.chain,
        [e.step.id]: { ...state.chain[e.step.id], ...e.step },
      };
      break;
    case "scope.set":
      next.scope = e.scope;
      break;
    case "scope.violation": {
      next.violations = [...state.violations, e.violation];
      const nodeId = e.violation.nodeId;
      if (nodeId && state.nodes[nodeId]) {
        next.nodes = { ...state.nodes, [nodeId]: { ...state.nodes[nodeId], outOfScope: true } };
      }
      break;
    }
    case "finding.upsert":
      next.findings = {
        ...state.findings,
        [e.finding.id]: { ...state.findings[e.finding.id], ...e.finding },
      };
      break;
    case "finding.review": {
      const f = state.findings[e.findingId];
      if (f) next.findings = { ...state.findings, [f.id]: { ...f, review: e.review } };
      break;
    }
    case "finding.edit": {
      const f = state.findings[e.findingId];
      if (f) next.findings = { ...state.findings, [f.id]: { ...f, edits: [...(f.edits ?? []), e.edit] } };
      break;
    }
    case "target.triage": {
      const triage = { ...state.triage };
      if (e.triage) triage[e.nodeId] = e.triage;
      else delete triage[e.nodeId];
      next.triage = triage;
      break;
    }
    case "assessment.upsert":
      next.assessments = {
        ...state.assessments,
        [e.assessment.id]: { ...state.assessments[e.assessment.id], ...e.assessment },
      };
      break;
    case "finding.assessment": {
      const f = state.findings[e.findingId];
      if (f) next.findings = { ...state.findings, [f.id]: { ...f, assessment: e.assessment } };
      break;
    }
    case "tool.call": {
      const touched = (e.targets ?? []).filter((t) => t.kind === "path" && !t.heuristic && (t.access === "read" || t.access === "write"));
      if (!touched.length) break;
      next.files = { ...state.files };
      for (const t of touched) {
        const prev = next.files[t.value] ?? { reads: 0, writes: 0, lastTs: 0 };
        next.files[t.value] = {
          reads: prev.reads + (t.access === "read" ? 1 : 0),
          writes: prev.writes + (t.access === "write" ? 1 : 0),
          lastTs: e.ts,
        };
      }
      break;
    }
  }
  return next;
}
