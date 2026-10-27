import type { GraphState, MapNode, SpectraEvent } from "@spectra/schema";
import { ImportanceBars, StatusChip } from "../components/Status.tsx";
import { clock, formatTool } from "../format.ts";

type Link = { node: MapNode; dir: "in" | "out"; label: string };

/** Node view: one object's properties, its ego network, connections and activity. */
export function NodeView({
  state,
  nodeId,
  onSelect,
}: {
  state: GraphState;
  nodeId?: string;
  onSelect: (id: string) => void;
}) {
  const node =
    (nodeId && state.nodes[nodeId]) || Object.values(state.nodes).find((n) => n.kind === "root");
  if (!node) return <div className="empty">Select an object in Network or Hierarchy.</div>;

  const links: Link[] = [];
  for (const e of Object.values(state.edges)) {
    if (e.source === node.id && state.nodes[e.target]) {
      links.push({ node: state.nodes[e.target], dir: "out", label: e.label ?? (state.nodes[e.target].parentId === node.id ? "contains" : "links") });
    } else if (e.target === node.id && state.nodes[e.source]) {
      links.push({ node: state.nodes[e.source], dir: "in", label: e.label ?? (node.parentId === e.source ? "parent" : "links") });
    }
  }

  const results = new Map<string, boolean>();
  for (const e of state.timeline) if (e.type === "tool.result") results.set(e.toolUseId, e.ok);
  const activity = state.timeline.filter(
    (e): e is Extract<SpectraEvent, { type: "tool.call" }> => e.type === "tool.call" && e.nodeId === node.id,
  );
  const steps = Object.values(state.chain).filter((s) => s.nodeIds?.includes(node.id));
  const violations = state.violations.filter((v) => v.nodeId === node.id);

  const props: [string, React.ReactNode][] = [
    ["id", <code>{node.id}</code>],
    ["kind", node.kind],
    ["category", node.category ?? "—"],
    ["parent", node.parentId ? <a onClick={() => onSelect(node.parentId!)}>{state.nodes[node.parentId]?.label ?? node.parentId}</a> : "—"],
    ["importance", <ImportanceBars value={node.importance} />],
    ...Object.entries(node.meta ?? {}).map(([k, v]) => [k, String(v)] as [string, React.ReactNode]),
  ];

  return (
    <div className="node-view">
      <div className="nv-head">
        <span className="nv-kind">{node.kind}</span>
        <h3>{node.label}</h3>
        <StatusChip status={node.status} />
        {node.outOfScope && <span className="oob-tag">out of scope</span>}
      </div>

      <div className="nv-grid">
        <EgoGraph node={node} links={links} onSelect={onSelect} />

        <section>
          <h4>Properties</h4>
          <dl className="props">
            {props.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </section>

        {violations.length > 0 && (
          <section>
            <h4>Scope violations <span>{violations.length}</span></h4>
            <table className="table">
              <tbody>
                {violations.map((v) => (
                  <tr key={v.id}>
                    <td className="muted">{clock(v.ts)}</td>
                    <td className="err">{v.target.access}</td>
                    <td><code>{v.target.value}</code></td>
                    <td className="tool">{formatTool(v.tool)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h4>Connections <span>{links.length}</span></h4>
          <table className="table">
            <tbody>
              {links.map((l) => (
                <tr key={`${l.dir}${l.node.id}`} onClick={() => onSelect(l.node.id)}>
                  <td className="dir">{l.dir === "out" ? "→" : "←"}</td>
                  <td className="muted">{l.label}</td>
                  <td>{l.node.label}</td>
                  <td><StatusChip status={l.node.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h4>Activity <span>{activity.length}</span></h4>
          <table className="table">
            <tbody>
              {activity.slice(-30).reverse().map((e) => (
                <tr key={e.toolUseId}>
                  <td className="muted">{clock(e.ts)}</td>
                  <td className="tool">{formatTool(e.tool)}</td>
                  <td className={results.get(e.toolUseId) === false ? "err" : results.has(e.toolUseId) ? "ok" : "muted"}>
                    {results.has(e.toolUseId) ? (results.get(e.toolUseId) ? "OK" : "ERR") : "…"}
                  </td>
                </tr>
              ))}
              {steps.map((s) => (
                <tr key={s.id}>
                  <td className="muted">chain</td>
                  <td colSpan={2}>{s.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!activity.length && !steps.length && <p className="muted">No recorded activity.</p>}
        </section>
      </div>
    </div>
  );
}

function EgoGraph({ node, links, onSelect }: { node: MapNode; links: Link[]; onSelect: (id: string) => void }) {
  const S = 220;
  const c = S / 2;
  const R = 80;
  const shown = links.slice(0, 16);
  return (
    <svg className="ego" viewBox={`0 0 ${S} ${S}`}>
      <circle cx={c} cy={c} r={R} className="ego-orbit" />
      {shown.map((l, i) => {
        const a = (i / shown.length) * Math.PI * 2 - Math.PI / 2;
        const x = c + Math.cos(a) * R;
        const y = c + Math.sin(a) * R;
        return (
          <g key={`${l.dir}${l.node.id}`} className={`node ${l.node.kind} ${l.node.status}`} onClick={() => onSelect(l.node.id)}>
            <line className="edge" x1={c} y1={c} x2={x} y2={y} />
            <circle cx={x} cy={y} r={4} />
            <title>{l.node.label}</title>
          </g>
        );
      })}
      <g className={`node ${node.kind} ${node.status} selected`}>
        <circle cx={c} cy={c} r={8} />
      </g>
      {links.length > shown.length && (
        <text x={S - 4} y={S - 4} className="ego-more">+{links.length - shown.length}</text>
      )}
    </svg>
  );
}
