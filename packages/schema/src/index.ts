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
 * actually did); mcp/demo are claims made by the agent or a script.
 */
export type EventSource = "hook" | "observer" | "mcp" | "demo" | "hub" | "operator";

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
  /** Edits to the finding's file, linked by the hub. */
  edits?: FixEdit[];
}

/** How the agent touched one file, from observed tool calls. */
export interface FileTouch {
  reads: number;
  writes: number;
  lastTs: number;
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
  | (Base & { type: "finding.edit"; findingId: string; edit: FixEdit });

export type SpectraEventType = SpectraEvent["type"];

/** Event types only the hub itself may produce; rejected from POST /events. */
export const HUB_ONLY_EVENTS: SpectraEventType[] = ["scope.set", "scope.violation", "finding.review", "finding.edit"];

export interface GraphState {
  sessionId?: string;
  nodes: Record<string, MapNode>;
  edges: Record<string, MapEdge>;
  chain: Record<string, ChainStep>;
  findings: Record<string, Finding>;
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
  return { nodes: {}, edges: {}, chain: {}, findings: {}, violations: [], files: {}, counts: { toolCalls: 0, failed: 0 }, timeline: [] };
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
      next.nodes = { ...state.nodes, [e.node.id]: { ...prev, ...e.node } };
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
