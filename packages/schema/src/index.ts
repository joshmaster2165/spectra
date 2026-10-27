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
export type EventSource = "hook" | "observer" | "mcp" | "demo" | "hub";

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

/* ── Findings ──────────────────────────────────────────── */

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "suspected" | "confirmed" | "dismissed" | "fixed";

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
  | (Base & { type: "finding.upsert"; finding: Finding });

export type SpectraEventType = SpectraEvent["type"];

/** Event types only the hub itself may produce; rejected from POST /events. */
export const HUB_ONLY_EVENTS: SpectraEventType[] = ["scope.set", "scope.violation"];

export interface GraphState {
  sessionId?: string;
  nodes: Record<string, MapNode>;
  edges: Record<string, MapEdge>;
  chain: Record<string, ChainStep>;
  findings: Record<string, Finding>;
  scope?: Scope;
  violations: ScopeViolation[];
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
  return { nodes: {}, edges: {}, chain: {}, findings: {}, violations: [], timeline: [] };
}

/** Pure reducer shared by the hub, the live dashboard and replay. */
export function applyEvent(state: GraphState, e: SpectraEvent): GraphState {
  const next: GraphState = {
    ...state,
    timeline: [...state.timeline, e].slice(-TIMELINE_LIMIT),
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
  }
  return next;
}
