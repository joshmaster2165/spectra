import type { GraphState } from "@spectra/schema";

/**
 * Concept sketch of how the map scales: a spectrum bar of node states plus
 * the discovery → confirmed progression. TODO: time-scrubber to replay growth.
 */
export function ExplorationSketch({ state }: { state: GraphState }) {
  const nodes = Object.values(state.nodes);
  const count = (s: string) => nodes.filter((n) => n.status === s).length;
  const total = nodes.length || 1;
  const bands = [
    { key: "unexplored", label: "unmapped", n: count("unexplored") },
    { key: "active", label: "active", n: count("active") },
    { key: "complete", label: "confirmed", n: count("complete") },
  ];
  const confirmed = Object.values(state.chain).filter((s) => s.confirmed).length;
  const stage =
    confirmed > 0 ? "Confirmed paths" : Object.keys(state.chain).length ? "Linking steps" : nodes.length ? "Discovery" : "Idle";

  return (
    <div className="sketch-body">
      <div className="spectrum">
        {bands.map((b) => (
          <div key={b.key} className={`band ${b.key}`} style={{ flexGrow: b.n }} title={`${b.label}: ${b.n}`} />
        ))}
      </div>
      <dl className="stats">
        {bands.map((b) => (
          <div key={b.key}>
            <dt>{b.label}</dt>
            <dd>{b.n}</dd>
          </div>
        ))}
        <div>
          <dt>coverage</dt>
          <dd>{Math.round((count("complete") / total) * 100)}%</dd>
        </div>
      </dl>
      <ol className="stages">
        {["Discovery", "Linking steps", "Confirmed paths"].map((s) => (
          <li key={s} className={s === stage ? "on" : ""}>{s}</li>
        ))}
      </ol>
    </div>
  );
}
