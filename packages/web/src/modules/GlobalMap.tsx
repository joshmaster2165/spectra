import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphState, MapNode } from "@spectra/schema";

type SimNode = SimulationNodeDatum & MapNode;
type SimLink = SimulationLinkDatum<SimNode> & { id: string; label?: string };

const RADIUS = { root: 13, category: 10, leaf: 8 } as const;
const W = 900;
const H = 600;
const ZOOM = { min: 0.25, max: 6 } as const;
/** Auto-fit never zooms past this, so small graphs don't render oversized. */
const FIT_MAX = 1.4;
/** Leaf labels show at this zoom; below it only the attack surface keeps its labels. */
const LABEL_ZOOM = 1.7;
/** Leaves that are the attack surface itself, labelled at any zoom. */
const SURFACE = new Set(["endpoints", "params"]);

/** Per-type glyphs, drawn in a 24×24 box (centred ~12,12), stroked in the node's status colour. */
const ICONS: Record<string, string[]> = {
  root: ["M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0", "M8 12 a4 4 0 1 0 8 0 a4 4 0 1 0 -8 0", "M11 12 a1 1 0 1 0 2 0 a1 1 0 1 0 -2 0"],
  files: ["M7 3 L14 3 L18 7 L18 21 L7 21 Z", "M14 3 L14 7 L18 7", "M9.5 12 H15", "M9.5 15.5 H15"],
  searches: ["M5 10 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0", "M13.5 13.5 L19 19"],
  commands: ["M6 8 L10 12 L6 16", "M12.5 16 H18"],
  web: ["M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0", "M4 12 H20", "M12 4 C7 7 7 17 12 20", "M12 4 C17 7 17 17 12 20"],
  agents: ["M12 4 L20 12 L12 20 L4 12 Z", "M12 9 V15", "M9 12 H15"],
  mcp: ["M9 3 V8", "M15 3 V8", "M7 8 H17 V11 A5 5 0 0 1 7 11 Z", "M12 16 V21"],
  hosts: ["M4 6 H20 V10 H4 Z", "M4 13 H20 V17 H4 Z", "M7 8 H7.5", "M7 15 H7.5"],
  domain: ["M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0", "M4 12 H20", "M12 4 C7 7 7 17 12 20", "M12 4 C17 7 17 17 12 20"],
  subdomain: ["M12 3 C15.3 3 18 5.7 18 9 C18 14 12 21 12 21 C12 21 6 14 6 9 C6 5.7 8.7 3 12 3 Z", "M9.5 9 a2.5 2.5 0 1 0 5 0 a2.5 2.5 0 1 0 -5 0"],
  endpoint: ["M9 4 C6 4 8 11 5 12 C8 13 6 20 9 20", "M15 4 C18 4 16 11 19 12 C16 13 18 20 15 20"],
  params: ["M4 12.5 L11.5 5 H19 V12.5 L11.5 20 Z", "M14.9 9.1 a0.9 0.9 0 1 0 1.8 0 a0.9 0.9 0 1 0 -1.8 0"],
  proxy: ["M5 9 H18", "M15 6 L18 9 L15 12", "M19 15 H6", "M9 12 L6 15 L9 18"],
  other: ["M4 12 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0", "M12 9.5 V13", "M12 16 H12.01"],
};

const LEGEND: { name: string; label: string }[] = [
  { name: "root", label: "Session" },
  { name: "files", label: "Files" },
  { name: "searches", label: "Search" },
  { name: "commands", label: "Shell" },
  { name: "web", label: "Web" },
  { name: "agents", label: "Subagent" },
  { name: "mcp", label: "MCP" },
  { name: "domain", label: "Domain" },
  { name: "subdomain", label: "Host" },
  { name: "endpoint", label: "Endpoint" },
  { name: "params", label: "Param" },
  { name: "proxy", label: "Proxy import" },
];

function iconFor(n: MapNode): string {
  if (n.id.startsWith("import:") && n.kind === "root") return "proxy";
  if (n.kind === "root") return "root";
  if (n.id.startsWith("domain:")) return "domain";
  if (n.id.startsWith("host:")) return "subdomain";
  if (n.category === "endpoints" || n.id.startsWith("endpoint:")) return "endpoint";
  return ICONS[n.category ?? ""] ? (n.category as string) : "other";
}

function Glyph({ name, r }: { name: string; r: number }) {
  const s = (r * 1.4) / 24;
  return (
    <g className="glyph" transform={`translate(${-12 * s} ${-12 * s}) scale(${s})`}>
      {(ICONS[name] ?? ICONS.other).map((d, i) => (
        <path key={i} d={d} />
      ))}
    </g>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Network view: force-directed node-link map with zoom, pan and per-type
 * glyphs. Simulation nodes persist across renders so positions stay stable as
 * the agent discovers more; a user transform (translate + scale) rides on top
 * so you can zoom to the cursor, drag the canvas and click into any object.
 */
export function GlobalMap({
  state,
  selected,
  onSelect,
  onOpen,
}: {
  state: GraphState;
  selected?: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const nodesRef = useRef(new Map<string, SimNode>());
  const svgRef = useRef<SVGSVGElement>(null);
  const [, setTick] = useState(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const [legend, setLegend] = useState(false);
  const pan = useRef<{ x: number; y: number } | null>(null);
  /** Auto-frame the graph as it grows, until the user zooms or pans; the fit button re-engages it. */
  const follow = useRef(true);

  const { nodes, links } = useMemo(() => {
    const cache = nodesRef.current;
    const nodes = Object.values(state.nodes).map((n) => {
      const prev = cache.get(n.id);
      const parent = n.parentId ? cache.get(n.parentId) : undefined;
      const seed = { x: (parent?.x ?? W / 2) + Math.random() * 20 - 10, y: (parent?.y ?? H / 2) + Math.random() * 20 - 10 };
      const sim: SimNode = Object.assign(prev ?? seed, n);
      cache.set(n.id, sim);
      return sim;
    });
    const links: SimLink[] = Object.values(state.edges)
      .filter((e) => cache.has(e.source) && cache.has(e.target))
      .map((e) => ({ id: e.id, label: e.label, source: e.source, target: e.target }));
    return { nodes, links };
  }, [state.nodes, state.edges]);

  const fit = () => {
    const ns = [...nodesRef.current.values()];
    if (!ns.length) return;
    const xs = ns.map((n) => n.x ?? 0);
    const ys = ns.map((n) => n.y ?? 0);
    const minX = Math.min(...xs) - 50;
    const maxX = Math.max(...xs) + 50;
    const minY = Math.min(...ys) - 50;
    const maxY = Math.max(...ys) + 50;
    const k = clamp(Math.min(W / (maxX - minX), H / (maxY - minY)), ZOOM.min, FIT_MAX);
    setView({ k, x: W / 2 - (k * (minX + maxX)) / 2, y: H / 2 - (k * (minY + maxY)) / 2 });
  };

  useEffect(() => {
    let ticks = 0;
    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => ((l.target as SimNode).kind === "leaf" ? 58 : 105)))
      .force("charge", forceManyBody().strength(-280))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<SimNode>((d) => RADIUS[d.kind] + 14))
      .alpha(0.5)
      .on("tick", () => {
        setTick((t) => t + 1);
        // While following, keep the moving layout framed.
        if (follow.current && ++ticks % 20 === 0) fit();
      })
      .on("end", () => follow.current && fit());
    // A first, early framing so the graph doesn't wait for the layout to finish.
    const t = setTimeout(() => follow.current && fit(), 450);
    return () => {
      sim.stop();
      clearTimeout(t);
    };
  }, [nodes, links]);

  // Wheel zoom toward the cursor. Native listener so we can preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      follow.current = false;
      const { vx, vy } = clientToView(svg, e.clientX, e.clientY);
      setView((v) => {
        const k = clamp(v.k * Math.exp(-e.deltaY * 0.0015), ZOOM.min, ZOOM.max);
        return { k, x: vx - (k * (vx - v.x)) / v.k, y: vy - (k * (vy - v.y)) / v.k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  if (!nodes.length) return <div className="empty">No surface mapped yet. Start an authorized testing session or run <code>npm run demo</code>.</div>;

  const promising = new Set(
    Object.values(state.assessments)
      .filter((a) => a.recommendation === "pursue" && a.nodeId)
      .map((a) => a.nodeId as string),
  );

  const zoomBy = (f: number) => {
    follow.current = false;
    setView((v) => {
      const k = clamp(v.k * f, ZOOM.min, ZOOM.max);
      return { k, x: W / 2 - (k * (W / 2 - v.x)) / v.k, y: H / 2 - (k * (H / 2 - v.y)) / v.k };
    });
  };

  const refit = () => {
    follow.current = true;
    fit();
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".node")) return; // let the node take the click
    follow.current = false;
    pan.current = { x: e.clientX, y: e.clientY };
    setPanning(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pan.current || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const s = Math.min(r.width / W, r.height / H) || 1;
    const dx = (e.clientX - pan.current.x) / s;
    const dy = (e.clientY - pan.current.y) / s;
    pan.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const endPan = (e: React.PointerEvent<SVGSVGElement>) => {
    pan.current = null;
    setPanning(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        className={`map-svg ${panning ? "panning" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerLeave={endPan}
      >
        <rect className="map-bg" x={0} y={0} width={W} height={H} pointerEvents="all" />
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const s = l.source as SimNode;
            const t = l.target as SimNode;
            return (
              <g key={l.id}>
                <line className={`edge ${l.label ? "labelled" : ""}`} x1={s.x} y1={s.y} x2={t.x} y2={t.y} />
                {l.label && view.k > 0.8 && (
                  <text className="edge-label" x={((s.x ?? 0) + (t.x ?? 0)) / 2} y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 3}>
                    {l.label}
                  </text>
                )}
              </g>
            );
          })}
          {nodes.map((n) => {
            const r = RADIUS[n.kind];
            const showLabel = n.kind !== "leaf" || selected === n.id || view.k > LABEL_ZOOM || SURFACE.has(n.category ?? "") || n.outOfScope;
            return (
              <g
                key={n.id}
                className={`node ${n.kind} ${n.status} ${n.outOfScope ? "oob" : ""} ${promising.has(n.id) ? "promise" : ""} ${selected === n.id ? "selected" : ""}`}
                transform={`translate(${n.x},${n.y})`}
                onClick={() => onSelect(n.id)}
                onDoubleClick={() => onOpen(n.id)}
              >
                {promising.has(n.id) && <circle className="promise-ring" r={r + 6} />}
                {n.outOfScope && <circle className="oob-ring" r={r + 4} />}
                {selected === n.id && <circle className="ring" r={r + 7} />}
                <circle className="disc" r={r} />
                <Glyph name={iconFor(n)} r={r} />
                {showLabel ? <text dy={r + 13}>{n.label}</text> : <title>{n.label}</title>}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="map-controls">
        <button onClick={() => zoomBy(1.4)} title="Zoom in" aria-label="Zoom in">+</button>
        <span className="map-zoom-label">{Math.round(view.k * 100)}%</span>
        <button onClick={() => zoomBy(1 / 1.4)} title="Zoom out" aria-label="Zoom out">–</button>
        <button onClick={refit} title="Fit to view and follow new targets" aria-label="Fit to view">⤢</button>
        <button className={legend ? "on" : ""} onClick={() => setLegend((v) => !v)} title="Legend" aria-label="Toggle legend">?</button>
      </div>

      {legend && (
        <div className="map-legend">
          {LEGEND.map((item) => (
            <span className="leg-item" key={item.name}>
              <svg viewBox="0 0 24 24" aria-hidden>
                <g className="glyph">
                  {(ICONS[item.name] ?? ICONS.other).map((d, i) => (
                    <path key={i} d={d} />
                  ))}
                </g>
              </svg>
              {item.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pointer client coords → viewBox coords, accounting for xMidYMid letterboxing. */
function clientToView(svg: SVGSVGElement, cx: number, cy: number) {
  const r = svg.getBoundingClientRect();
  const s = Math.min(r.width / W, r.height / H) || 1;
  const offX = (r.width - W * s) / 2;
  const offY = (r.height - H * s) / 2;
  return { vx: (cx - r.left - offX) / s, vy: (cy - r.top - offY) / s };
}
