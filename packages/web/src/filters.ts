import { createContext } from "react";
import { surfaceTags, type Assessment, type GraphState, type MapNode, type NodeStatus, type SurfaceTag, type TriageState } from "@spectra/schema";

/** One filter, shared by the Graph and Surface views, so narrowing the map narrows the table too. */
export interface SurfaceFilter {
  query: string;
  /** Every selected tag must be present. */
  tags: SurfaceTag[];
  status: "all" | NodeStatus;
  leadsOnly: boolean;
  /** "none" = targets you haven't marked yet. */
  triage: "all" | "none" | TriageState;
}

export const NO_FILTER: SurfaceFilter = { query: "", tags: [], status: "all", leadsOnly: false, triage: "all" };

export const isFiltering = (f: SurfaceFilter) => !!(f.query.trim() || f.tags.length || f.status !== "all" || f.leadsOnly || f.triage !== "all");

/** The categories that are the attack surface itself; everything else is the agent's activity. */
export const SURFACE_CATEGORIES = new Set(["hosts", "endpoints", "params"]);
export const isSurface = (n: MapNode) => SURFACE_CATEGORIES.has(n.category ?? "");

/** Derived lookups over one GraphState: tags per target, the Navigator's lead per target, the host each belongs to. */
export interface SurfaceIndex {
  tags: Map<string, SurfaceTag[]>;
  leads: Map<string, Assessment>;
  host: Map<string, string>;
  /** How many hosts and endpoints carry each tag. */
  tagCounts: Map<SurfaceTag, number>;
  counts: { hosts: number; endpoints: number; params: number; activity: number };
}

export function indexSurface(state: GraphState): SurfaceIndex {
  const tags = new Map<string, SurfaceTag[]>();
  const host = new Map<string, string>();
  const tagCounts = new Map<SurfaceTag, number>();
  const counts = { hosts: 0, endpoints: 0, params: 0, activity: 0 };
  const label = (id?: string) => (id ? state.nodes[id]?.label ?? "" : "");

  for (const n of Object.values(state.nodes)) {
    if (n.category === "endpoints") {
      host.set(n.id, label(n.parentId));
      tags.set(n.id, surfaceTags(n.label, label(n.parentId)));
      counts.endpoints++;
    } else if (n.category === "hosts" && (n.id.startsWith("domain:") || n.id.startsWith("host:"))) {
      host.set(n.id, n.label);
      tags.set(n.id, surfaceTags("", n.label));
      counts.hosts++;
    } else if (n.category === "params") {
      counts.params++;
    } else if (n.kind === "leaf") {
      counts.activity++;
    }
  }
  // A parameter is the kind of surface its endpoint is.
  for (const n of Object.values(state.nodes)) {
    if (n.category !== "params" || !n.parentId) continue;
    tags.set(n.id, tags.get(n.parentId) ?? []);
    host.set(n.id, host.get(n.parentId) ?? "");
  }
  for (const [id, list] of tags) {
    if (state.nodes[id]?.category === "params") continue;
    for (const t of list) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }

  const leads = new Map<string, Assessment>();
  for (const a of Object.values(state.assessments)) if (a.nodeId) leads.set(a.nodeId, a);
  return { tags, leads, host, tagCounts, counts };
}

export function matches(n: MapNode, state: GraphState, index: SurfaceIndex, f: SurfaceFilter): boolean {
  if (f.status !== "all" && n.status !== f.status) return false;
  if (f.leadsOnly && !index.leads.has(n.id)) return false;
  if (f.triage !== "all") {
    const mark = state.triage[n.id]?.state;
    if (f.triage === "none" ? !!mark : mark !== f.triage) return false;
  }
  if (f.tags.length) {
    const own = index.tags.get(n.id) ?? [];
    if (!f.tags.every((t) => own.includes(t))) return false;
  }
  const q = f.query.trim().toLowerCase();
  if (q && !`${n.label} ${index.host.get(n.id) ?? ""} ${n.id}`.toLowerCase().includes(q)) return false;
  return true;
}

/** Ids matching the filter, plus their ancestors so matches stay connected to the map. */
export function matchedIds(state: GraphState, index: SurfaceIndex, f: SurfaceFilter): { direct: Set<string>; withContext: Set<string> } {
  const direct = new Set<string>();
  for (const n of Object.values(state.nodes)) if (matches(n, state, index, f)) direct.add(n.id);
  const withContext = new Set(direct);
  for (const id of direct) {
    let parent = state.nodes[id]?.parentId;
    while (parent && !withContext.has(parent)) {
      withContext.add(parent);
      parent = state.nodes[parent]?.parentId;
    }
  }
  return { direct, withContext };
}

/** True while a recorded session is being replayed: the map is history, so triage marks can't be changed. */
export const ReadOnly = createContext(false);

/** Records the operator's triage mark on a target. */
export async function postTriage(nodeId: string, state: TriageState | null, note?: string): Promise<boolean> {
  const res = await fetch("/triage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId, state, note }) }).catch(() => undefined);
  return !!res?.ok;
}
