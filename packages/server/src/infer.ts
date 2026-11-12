import { OUTPUT_SEEN_IN, type GraphState, type MapNode, type SpectraEvent } from "@spectra/schema";
import { inScope } from "./scope.ts";
import { apexOf, normalizeRoute, rootId } from "./toolmap.ts";

/**
 * Surface read out of a command's output rather than out of a request the hub
 * saw: URLs printed by a scanner, endpoints listed in a JavaScript file, hosts
 * a script reported. Ids follow the same conventions as live traffic, so an
 * endpoint found this way and later requested by the agent is one node.
 *
 * Everything here is inference, and is labelled so: new nodes arrive
 * "unexplored" with `seen in: command output`. Nodes already on the map are
 * left exactly as they are, and out-of-scope hosts are never added.
 */

export interface InferredEntry {
  /** Absolute http(s) URL. Query values are never kept; parameter names are. */
  url: string;
  method?: string;
  status?: number;
  params?: string[];
  /** A short quote from the output that shows it. */
  evidence?: string;
}

export interface InferOptions {
  sessionId: string;
  /** "hub": the local URL scan. "interpreter": a model's reading. */
  source: "hub" | "interpreter";
  /** The command's node, linked to what its output revealed. */
  fromNodeId?: string;
}

const NOISE_PATH = /\.(css|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i;
const PARAM_NAME = /^[\w.\-[\]]{1,64}$/;

export function inferEntries(state: GraphState, entries: InferredEntry[], opts: InferOptions): { events: SpectraEvent[]; added: number; outOfScope: number } {
  const base = { ts: Date.now(), sessionId: opts.sessionId, source: opts.source };
  const events: SpectraEvent[] = [];
  const fresh = new Map<string, MapNode>();
  const targets = new Set<string>();
  let outOfScope = 0;
  const readBy = opts.source === "interpreter" ? "interpreter" : "url scan";
  const surfaceId = `${rootId(opts.sessionId)}:hosts`;
  const add = (node: MapNode) => {
    if (state.nodes[node.id] || fresh.has(node.id)) return false;
    fresh.set(node.id, node);
    return true;
  };

  for (const e of entries) {
    let url: URL;
    try {
      url = new URL(e.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || !state.scope || !inScope({ kind: "host", value: hostname, access: "network" }, state.scope)) {
      outOfScope++;
      continue;
    }
    if (NOISE_PATH.test(url.pathname)) continue;

    const seen = { "seen in": OUTPUT_SEEN_IN, "read by": readBy };
    add({ id: surfaceId, label: "hosts", kind: "category", status: "active", parentId: rootId(opts.sessionId), category: "hosts" });
    const apex = apexOf(hostname);
    const domainId = `domain:${apex}`;
    add({ id: domainId, label: apex, kind: "category", status: "unexplored", parentId: surfaceId, category: "hosts", meta: seen });
    let hostId = domainId;
    if (hostname !== apex) {
      hostId = `host:${hostname}`;
      add({ id: hostId, label: hostname, kind: "category", status: "unexplored", parentId: domainId, category: "hosts", meta: seen });
    }
    const clean = `${url.origin}${url.pathname}`;
    const route = normalizeRoute(clean);
    if (!route) {
      if (fresh.has(hostId)) targets.add(hostId);
      continue;
    }
    const endpointId = `endpoint:${hostname}${route}`;
    const isNew = add({
      id: endpointId,
      label: route,
      kind: "leaf",
      status: "unexplored",
      parentId: hostId,
      category: "endpoints",
      meta: {
        ...seen,
        host: hostname,
        example: clean,
        ...(e.method ? { methods: e.method } : {}),
        ...(e.status ? { "status codes": String(e.status) } : {}),
        ...(e.evidence ? { evidence: e.evidence } : {}),
      },
    });
    if (isNew) targets.add(endpointId);
    const names = new Set([...(e.params ?? []), ...url.searchParams.keys()]);
    for (const name of [...names].filter((n) => PARAM_NAME.test(n)).slice(0, 20)) {
      const paramId = `param:${hostname}${route}?${name}`;
      if (add({ id: paramId, label: name, kind: "leaf", status: "unexplored", parentId: endpointId, category: "params", meta: seen })) targets.add(paramId);
    }
  }

  for (const node of fresh.values()) events.push({ ...base, type: "node.upsert", node });
  if (opts.fromNodeId && state.nodes[opts.fromNodeId]) {
    for (const id of targets) {
      // Parameters hang off their endpoint; the command links to hosts and endpoints.
      if (id.startsWith("param:")) continue;
      events.push({ ...base, type: "edge.upsert", edge: { id: `${opts.fromNodeId}=>${id}`, source: opts.fromNodeId, target: id, label: "found" } });
    }
  }
  const added = [...fresh.keys()].filter((id) => id !== surfaceId).length;
  return { events, added, outOfScope };
}

/** Absolute URLs printed in a command's output. Local and deterministic; nothing leaves the hub. */
export function mineUrls(output: string, limit = 150): InferredEntry[] {
  const seen = new Set<string>();
  const out: InferredEntry[] = [];
  for (const m of output.matchAll(/\bhttps?:\/\/[^\s'"`<>()\\,;\]}|]+/gi)) {
    const raw = m[0].replace(/[.:!?*]+$/, "");
    // A template or a shell variable isn't an address anyone requested.
    if (/[${]/.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push({ url: raw });
    if (seen.size >= limit) break;
  }
  return out;
}

/** True when output reads like a list of places: several distinct URL paths that aren't local files. */
export function listsPaths(output: string): boolean {
  const LOCAL = /^\/(usr|bin|sbin|etc|tmp|var|dev|private|Users|home|opt|proc|sys|lib|Library|System|Applications|Volumes|root|mnt|node_modules)(\/|$)/;
  const found = new Set<string>();
  for (const m of output.matchAll(/(?<![\w:./-])\/[A-Za-z0-9_~.-]+(?:\/[A-Za-z0-9_~.{}:-]+)*/g)) {
    const p = m[0];
    if (p.length < 4 || !/[A-Za-z]/.test(p) || LOCAL.test(p)) continue;
    found.add(p);
    if (found.size >= 4) return true;
  }
  return false;
}
