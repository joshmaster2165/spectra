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

const RADIUS = { root: 9, category: 6, leaf: 3.5 } as const;
const W = 900;
const H = 600;
const PAD = 60;

/**
 * Network view: force-directed node-link map. Simulation nodes persist across
 * renders so positions stay stable as the agent discovers more; the viewBox
 * follows the graph's bounds so nothing drifts off-screen.
 * TODO: zoom/pan, 3D mode.
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
  const [, setTick] = useState(0);

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

  useEffect(() => {
    const sim = forceSimulation<SimNode>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance((l) => ((l.target as SimNode).kind === "leaf" ? 34 : 70)))
      .force("charge", forceManyBody().strength(-120))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide<SimNode>((d) => RADIUS[d.kind] + 6))
      .alpha(0.5)
      .on("tick", () => setTick((t) => t + 1));
    return () => void sim.stop();
  }, [nodes, links]);

  if (!nodes.length) return <div className="empty">No objects. Start a Claude Code session or run <code>npm run demo</code>.</div>;

  const xs = nodes.map((n) => n.x ?? 0);
  const ys = nodes.map((n) => n.y ?? 0);
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const vw = Math.max(Math.max(...xs) + PAD - minX, 640);
  const vh = Math.max(Math.max(...ys) + PAD - minY, 420);

  return (
    <svg className="map-svg" viewBox={`${minX} ${minY} ${vw} ${vh}`}>
      {links.map((l) => {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        return (
          <g key={l.id}>
            <line className={`edge ${l.label ? "labelled" : ""}`} x1={s.x} y1={s.y} x2={t.x} y2={t.y} />
            {l.label && (
              <text className="edge-label" x={((s.x ?? 0) + (t.x ?? 0)) / 2} y={((s.y ?? 0) + (t.y ?? 0)) / 2 - 3}>
                {l.label}
              </text>
            )}
          </g>
        );
      })}
      {nodes.map((n) => (
        <g
          key={n.id}
          className={`node ${n.kind} ${n.status} ${n.outOfScope ? "oob" : ""} ${selected === n.id ? "selected" : ""}`}
          transform={`translate(${n.x},${n.y})`}
          onClick={() => onSelect(n.id)}
          onDoubleClick={() => onOpen(n.id)}
        >
          {n.kind === "category" ? (
            <rect x={-RADIUS.category} y={-RADIUS.category} width={RADIUS.category * 2} height={RADIUS.category * 2} />
          ) : (
            <circle r={RADIUS[n.kind]} />
          )}
          {n.outOfScope && <circle className="oob-ring" r={RADIUS[n.kind] + 4} />}
          {selected === n.id && <circle className="ring" r={RADIUS[n.kind] + 7} />}
          {n.kind !== "leaf" || selected === n.id ? (
            <text dy={RADIUS[n.kind] + 13}>{n.label}</text>
          ) : (
            <title>{n.label}</title>
          )}
        </g>
      ))}
    </svg>
  );
}
