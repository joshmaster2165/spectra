import { emptySummary, describeImport, type GraphState, type HttpEntry, type ImportSummary, type MapNode, type SpectraEvent } from "@spectra/schema";
import { inScope } from "./scope.ts";
import { apexOf, normalizeRoute } from "./toolmap.ts";

/**
 * Turns proxy history into attack-surface events. Ids follow the same
 * conventions as live agent traffic (domain:, host:, endpoint:), so an endpoint
 * the proxy saw and the agent touched becomes one node. Surface the agent
 * hasn't touched arrives as "unexplored" — exactly what the Navigator should
 * point at. Only in-scope, non-static requests are kept.
 */

const STATIC_PATH = /\.(m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf)$/i;
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/css$|javascript/;

export interface ImportOptions {
  sessionId: string;
  /** Shown on the import's root node, e.g. the file name. */
  label: string;
  includeStatic?: boolean;
}

interface Agg {
  label: string;
  kind: MapNode["kind"];
  parentId: string;
  category: string;
  requests: number;
  methods: Set<string>;
  statuses: Set<number>;
}

export function importEntries(state: GraphState, entries: HttpEntry[], opts: ImportOptions): { events: SpectraEvent[]; summary: ImportSummary } {
  const summary = { ...emptySummary(), requests: entries.length };
  const oob = new Map<string, number>();
  const root = `import:${opts.label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(0, 40)}`;
  const surface = `${root}:hosts`;
  // Insertion order puts parents before children.
  const seen = new Map<string, Agg>();
  const touch = (id: string, e: HttpEntry, shape: Omit<Agg, "requests" | "methods" | "statuses">) => {
    let a = seen.get(id);
    if (!a) seen.set(id, (a = { ...shape, requests: 0, methods: new Set(), statuses: new Set() }));
    a.requests++;
    a.methods.add(e.method);
    if (e.status) a.statuses.add(e.status);
  };

  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.url);
    } catch {
      continue;
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!state.scope || !inScope({ kind: "host", value: hostname, access: "network" }, state.scope)) {
      summary.skippedOutOfScope++;
      oob.set(hostname, (oob.get(hostname) ?? 0) + 1);
      continue;
    }
    if (!opts.includeStatic && (STATIC_PATH.test(url.pathname) || (e.mime && STATIC_MIME.test(e.mime)))) {
      summary.skippedStatic++;
      continue;
    }
    summary.imported++;

    const apex = apexOf(hostname);
    const domainId = `domain:${apex}`;
    touch(domainId, e, { label: apex, kind: "category", parentId: surface, category: "hosts" });
    let hostId = domainId;
    if (hostname !== apex) {
      hostId = `host:${hostname}`;
      touch(hostId, e, { label: hostname, kind: "category", parentId: domainId, category: "hosts" });
    }
    const route = normalizeRoute(e.url);
    if (!route) continue;
    const endpointId = `endpoint:${hostname}${route}`;
    touch(endpointId, e, { label: route, kind: "leaf", parentId: hostId, category: "endpoints" });
    for (const name of e.params ?? []) {
      touch(`param:${hostname}${route}?${name}`, e, { label: name, kind: "leaf", parentId: endpointId, category: "params" });
    }
  }

  summary.outOfScopeHosts = [...oob.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h]) => h);
  if (!summary.imported && summary.skippedOutOfScope) {
    summary.hint = "Nothing in this file is in scope. Add the target's hosts to your scope (spectra.config.json or POST /scope) and import again.";
  }

  const ts = Date.now();
  const base = { ts, sessionId: opts.sessionId, source: "proxy" as const };
  const events: SpectraEvent[] = [];
  const upsert = (node: MapNode) => events.push({ ...base, type: "node.upsert", node });

  // The import's own root only appears when it brings a domain the map doesn't have yet.
  if ([...seen].some(([id, a]) => a.parentId === surface && !state.nodes[id])) {
    if (!state.nodes[root]) upsert({ id: root, label: `proxy · ${opts.label}`, kind: "root", status: "complete", category: "proxy" });
    if (!state.nodes[surface]) upsert({ id: surface, label: "hosts", kind: "category", status: "complete", parentId: root, category: "hosts" });
  }
  for (const [id, a] of seen) {
    const prev = state.nodes[id];
    const meta = trafficMeta(prev, a);
    if (prev) {
      // Already on the map (often from the agent): add traffic, keep its place and status.
      upsert({ id, meta: { ...prev.meta, ...meta } } as MapNode);
    } else {
      upsert({ id, label: a.label, kind: a.kind, parentId: a.parentId, category: a.category, status: "unexplored", meta });
    }
    if (a.category === "endpoints") {
      summary.endpoints++;
      if (!prev) summary.newEndpoints++;
    } else if (a.category === "params") {
      summary.params++;
    }
  }
  events.push({ ...base, type: "thought", text: `${opts.label}: ${describeImport(summary)}`, reason: "proxy import" });
  return { events, summary };
}

/** Flat values so the Target view can show them as properties. */
function trafficMeta(prevNode: MapNode | undefined, a: Agg): Record<string, unknown> {
  const prev = prevNode?.meta;
  const list = (v: unknown) => (typeof v === "string" && v ? v.split(", ") : []);
  const methods = new Set([...list(prev?.methods), ...a.methods]);
  const statuses = new Set([...list(prev?.["status codes"]), ...[...a.statuses].map(String)]);
  // A node that existed without traffic came from the agent.
  const seenIn = !prevNode ? "proxy traffic" : (prev?.["seen in"] ?? "agent and proxy traffic");
  return {
    "seen in": seenIn,
    requests: Number(prev?.requests ?? 0) + a.requests,
    methods: [...methods].sort().join(", "),
    ...(statuses.size ? { "status codes": [...statuses].sort().join(", ") } : {}),
  };
}
