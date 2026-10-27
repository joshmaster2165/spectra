import type { ChainStep, GraphState } from "@spectra/schema";

const COL = 190;
const ROW = 64;
const BOX_W = 180;
const BOX_H = 40;

/**
 * Directed flow of chain steps. Steps are placed in columns by depth
 * (longest path from a step with no `after`), rows by arrival order.
 * TODO: multiple chains side by side, edge routing, detail popovers.
 */
export function ChainBuilder({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const steps = Object.values(state.chain);
  if (!steps.length) return <div className="empty">No chain steps. The agent adds them with <code>update_chain</code>.</div>;

  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const depthOf = (s: ChainStep, seen = new Set<string>()): number => {
    if (depth.has(s.id)) return depth.get(s.id)!;
    if (seen.has(s.id)) return 0;
    seen.add(s.id);
    const parents = (s.after ?? []).map((id) => byId.get(id)).filter(Boolean) as ChainStep[];
    const d = parents.length ? 1 + Math.max(...parents.map((p) => depthOf(p, seen))) : 0;
    depth.set(s.id, d);
    return d;
  };
  const rowsUsed = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const s of steps) {
    const d = depthOf(s);
    const r = rowsUsed.get(d) ?? 0;
    rowsUsed.set(d, r + 1);
    pos.set(s.id, { x: 10 + d * COL, y: 10 + r * ROW });
  }
  const width = 20 + (Math.max(...depth.values()) + 1) * COL;
  const height = 20 + Math.max(...rowsUsed.values()) * ROW;

  return (
    <svg className="chain-svg" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" className="arrowhead" />
        </marker>
      </defs>
      {steps.flatMap((s) =>
        (s.after ?? []).filter((a) => pos.has(a)).map((a) => {
          const from = pos.get(a)!;
          const to = pos.get(s.id)!;
          return (
            <line
              key={`${a}-${s.id}`}
              className="chain-edge"
              x1={from.x + BOX_W}
              y1={from.y + BOX_H / 2}
              x2={to.x}
              y2={to.y + BOX_H / 2}
              markerEnd="url(#arrow)"
            />
          );
        }),
      )}
      {steps.map((s) => {
        const p = pos.get(s.id)!;
        return (
          <g
            key={s.id}
            className={`step ${s.confirmed ? "confirmed" : ""}`}
            transform={`translate(${p.x},${p.y})`}
            onClick={() => s.nodeIds?.[0] && onSelect(s.nodeIds[0])}
          >
            <rect width={BOX_W} height={BOX_H} />
            <rect className="step-bar" width={3} height={BOX_H} />
            <text x={10} y={24}>{s.title.length > 24 ? s.title.slice(0, 23) + "…" : s.title}</text>
            <title>{s.detail ?? s.title}</title>
          </g>
        );
      })}
    </svg>
  );
}
