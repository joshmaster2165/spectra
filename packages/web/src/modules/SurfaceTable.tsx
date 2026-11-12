import { useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { TRIAGE_LABEL, type Assessment, type GraphState, type MapNode, type NodeStatus, type SurfaceTag, type Triage, type TriageState } from "@spectra/schema";
import { FilterBar } from "../components/FilterBar.tsx";
import { Segmented } from "../components/Panel.tsx";
import { Confidence, STATUS_LABEL, StatusChip } from "../components/Status.tsx";
import { matches, postTriage, ReadOnly, type SurfaceFilter, type SurfaceIndex } from "../filters.ts";

type Show = "endpoints" | "hosts" | "params";
type Source = "agent" | "proxy" | "both";

interface Row {
  id: string;
  node: MapNode;
  /** Discovery order, 1-based (the hub's insertion order). */
  order: number;
  label: string;
  /** Host for endpoints and params; the domain for subdomains. */
  host: string;
  /** The endpoint a parameter belongs to. */
  endpoint: string;
  status: NodeStatus;
  source: Source;
  tags: SurfaceTag[];
  /** Parameters (endpoint rows) or endpoints (host rows). */
  count: number;
  requests: number;
  lead?: Assessment;
  triage?: Triage;
  findings: number;
}

interface Col {
  key: string;
  label: string;
  /** Numeric/ranked columns sort high-to-low first and align right. */
  num?: boolean;
  value: (r: Row) => string | number;
  render: (r: Row) => ReactNode;
  /** Plain text for CSV export. */
  text?: (r: Row) => string | number;
  className?: string;
}

const STATUS_RANK: Record<NodeStatus, number> = { unexplored: 0, active: 1, complete: 2 };
const REC_RANK = { pursue: 3, watch: 2, skip: 1 } as const;
const TRIAGE_RANK: Record<TriageState, number> = { testing: 4, queued: 3, tested: 2, skipped: 1 };
const NEW_MS = 2200;

const leadScore = (a?: Assessment) => (a ? REC_RANK[a.recommendation] + a.confidence : 0);
const sourceOf = (n: MapNode): Source => {
  const seen = n.meta?.["seen in"];
  return seen === "proxy traffic" ? "proxy" : seen === "agent and proxy traffic" ? "both" : "agent";
};
const isHost = (n: MapNode) => n.category === "hosts" && (n.id.startsWith("domain:") || n.id.startsWith("host:"));

const order: Col = { key: "order", label: "#", num: true, value: (r) => r.order, render: (r) => r.order, className: "dim" };
const status: Col = { key: "status", label: "Status", value: (r) => STATUS_RANK[r.status], render: (r) => <StatusChip status={r.status} />, text: (r) => STATUS_LABEL[r.status] };
const source: Col = { key: "source", label: "Source", value: (r) => r.source, render: (r) => <span className={`src ${r.source}`}>{r.source}</span> };
const tags: Col = {
  key: "tags",
  label: "Tags",
  value: (r) => r.tags.join(" "),
  render: (r) => (r.tags.length ? r.tags.map((t) => <span key={t} className={`tag small ${t}`}>{t}</span>) : <span className="dim">—</span>),
};
const lead = (label: string): Col => ({
  key: "lead",
  label,
  num: true,
  value: (r) => leadScore(r.lead),
  text: (r) => (r.lead ? `${r.lead.recommendation} ${Math.round(r.lead.confidence * 100)}%` : ""),
  render: (r) =>
    r.lead ? (
      <span className="lead-cell" title={r.lead.rationale}>
        <span className={`rec ${r.lead.recommendation}`}>{r.lead.recommendation}</span>
        <Confidence value={r.lead.confidence} />
      </span>
    ) : (
      <span className="dim">—</span>
    ),
});
const triage: Col = {
  key: "triage",
  label: "Triage",
  value: (r) => (r.triage ? TRIAGE_RANK[r.triage.state] : 0),
  text: (r) => (r.triage ? TRIAGE_LABEL[r.triage.state] : ""),
  render: (r) => <TriageSelect row={r} />,
};

function TriageSelect({ row: r }: { row: Row }) {
  const readOnly = useContext(ReadOnly);
  return (
    <select
      className={`triage ${r.triage?.state ?? ""}`}
      value={r.triage?.state ?? ""}
      title={readOnly ? "Triage marks can't be changed during replay" : (r.triage?.note ?? "Your mark on this target")}
      aria-label={`Triage ${r.label}`}
      disabled={readOnly}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => void postTriage(r.id, (e.target.value || null) as TriageState | null, r.triage?.note)}
    >
      <option value="">—</option>
      {(Object.keys(TRIAGE_LABEL) as TriageState[]).map((t) => (
        <option key={t} value={t}>
          {TRIAGE_LABEL[t]}
        </option>
      ))}
    </select>
  );
}
const text = (key: "label" | "host" | "endpoint", label: string, className?: string): Col => ({
  key,
  label,
  value: (r) => r[key],
  render: (r) => r[key] || <span className="dim">—</span>,
  className,
});
const count = (key: "count" | "requests" | "findings", label: string): Col => ({
  key,
  label,
  num: true,
  value: (r) => r[key],
  render: (r) => (r[key] ? r[key] : <span className="dim">0</span>),
});

// What you act on (lead, triage) sits next to the target, so it stays in view on narrow panels.
const COLUMNS: Record<Show, Col[]> = {
  endpoints: [order, text("label", "Endpoint", "target"), text("host", "Host", "mono"), tags, lead("Lead"), triage, status, source, count("count", "Params"), count("requests", "Requests"), count("findings", "Findings")],
  hosts: [order, text("label", "Host", "target"), text("host", "Domain", "mono"), tags, lead("Best lead"), triage, status, count("count", "Endpoints"), source],
  params: [order, text("label", "Param", "target"), text("endpoint", "Endpoint", "mono"), text("host", "Host", "mono"), triage, status, source],
};

/**
 * Surface view: the attack surface as a live, sortable table. Newest first by
 * default, so discoveries land at the top as they come in. Tags, the
 * Navigator's lead and your own triage mark sit side by side on every target.
 */
export function SurfaceTable({
  state,
  index,
  filter,
  onFilter,
  selected,
  onSelect,
  onOpen,
}: {
  state: GraphState;
  index: SurfaceIndex;
  filter: SurfaceFilter;
  onFilter: (f: SurfaceFilter) => void;
  selected?: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [show, setShow] = useState<Show>("endpoints");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "order", dir: -1 });
  const firstSeen = useRef<Record<Show, Map<string, number>>>({ endpoints: new Map(), hosts: new Map(), params: new Map() });

  const rows = useMemo(() => buildRows(state, index, show), [state.nodes, state.findings, state.triage, index, show]);

  // Rows that appeared after this view was first shown get a brief highlight.
  const now = Date.now();
  const seen = firstSeen.current[show];
  const initial = seen.size === 0;
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, initial ? 0 : now);

  const cols = COLUMNS[show];
  const col = cols.find((c) => c.key === sort.key) ?? cols[0];
  const visible = rows
    .filter((r) => matches(r.node, state, index, filter))
    .sort((a, b) => {
      const x = col.value(a);
      const y = col.value(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c * sort.dir || b.order - a.order;
    });

  const sortBy = (c: Col) => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.num ? -1 : 1 }));

  return (
    <div className="surface">
      <div className="surface-bar">
        <Segmented<Show>
          value={show}
          onChange={setShow}
          options={[
            { value: "endpoints", label: `Endpoints ${index.counts.endpoints || ""}`.trim() },
            { value: "hosts", label: `Hosts ${index.counts.hosts || ""}`.trim() },
            { value: "params", label: `Params ${index.counts.params || ""}`.trim() },
          ]}
        />
        <span className="surface-count">{visible.length === rows.length ? `${rows.length} ${show}` : `${visible.length} of ${rows.length} ${show}`}</span>
        <button className="toggle" onClick={() => exportCsv(show, cols, visible)} disabled={!visible.length} title="Download the rows shown as CSV">
          Export CSV
        </button>
      </div>
      <FilterBar index={index} filter={filter} onChange={onFilter} />
      <div className="surface-scroll">
        {rows.length ? (
          <table>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={`${c.num ? "num" : ""} ${c.key === col.key ? "sorted" : ""}`} onClick={() => sortBy(c)} aria-sort={c.key === col.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                    {c.label}
                    {c.key === col.key && <span className="sort-arrow">{sort.dir === 1 ? "▲" : "▼"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  className={`${selected === r.id ? "selected" : ""} ${now - (seen.get(r.id) ?? 0) < NEW_MS ? "new" : ""}`}
                  onClick={() => onSelect(r.id)}
                  onDoubleClick={() => onOpen(r.id)}
                >
                  {cols.map((c) => (
                    <td key={c.key} className={`${c.num ? "num" : ""} ${c.className ?? ""}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">No {show} mapped yet.</div>
        )}
        {rows.length > 0 && !visible.length && <div className="empty">Nothing matches these filters.</div>}
      </div>
    </div>
  );
}

function buildRows(state: GraphState, index: SurfaceIndex, show: Show): Row[] {
  const orderOf = new Map(Object.keys(state.nodes).map((id, i) => [id, i + 1]));
  const children = new Map<string, MapNode[]>();
  for (const n of Object.values(state.nodes)) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n);
    children.set(n.parentId, list);
  }
  const findings = new Map<string, number>();
  for (const f of Object.values(state.findings)) for (const id of f.nodeIds ?? []) findings.set(id, (findings.get(id) ?? 0) + 1);
  const label = (id?: string) => (id ? state.nodes[id]?.label ?? "" : "");
  const kids = (id: string, category: string) => (children.get(id) ?? []).filter((c) => c.category === category);

  const base = (n: MapNode): Row => ({
    id: n.id,
    node: n,
    order: orderOf.get(n.id) ?? 0,
    label: n.label,
    host: "",
    endpoint: "",
    status: n.status,
    source: sourceOf(n),
    tags: index.tags.get(n.id) ?? [],
    count: 0,
    requests: Number(n.meta?.requests ?? 0),
    lead: index.leads.get(n.id),
    triage: state.triage[n.id],
    findings: findings.get(n.id) ?? 0,
  });

  const nodes = Object.values(state.nodes);
  if (show === "endpoints") {
    return nodes.filter((n) => n.category === "endpoints").map((n) => ({ ...base(n), host: label(n.parentId), count: kids(n.id, "params").length }));
  }
  if (show === "hosts") {
    return nodes.filter(isHost).map((n) => {
      const eps = kids(n.id, "endpoints");
      const best = eps.map((e) => index.leads.get(e.id)).reduce<Assessment | undefined>((b, a) => (leadScore(a) > leadScore(b) ? a : b), index.leads.get(n.id));
      return {
        ...base(n),
        host: n.id.startsWith("host:") ? label(n.parentId) : "",
        count: eps.length,
        lead: best,
        findings: eps.reduce((sum, e) => sum + (findings.get(e.id) ?? 0), findings.get(n.id) ?? 0),
      };
    });
  }
  return nodes
    .filter((n) => n.category === "params")
    .map((n) => {
      const ep = n.parentId ? state.nodes[n.parentId] : undefined;
      return { ...base(n), endpoint: ep?.label ?? "", host: label(ep?.parentId) };
    });
}

/** The rows on screen, as a spreadsheet for the next phase of the engagement. */
function exportCsv(show: Show, cols: Col[], rows: Row[]) {
  const cell = (v: string | number) => {
    // Quote everything, and defuse values a spreadsheet would run as a formula.
    const s = String(v).replace(/"/g, '""');
    return `"${/^[=+\-@]/.test(s) ? `'${s}` : s}"`;
  };
  const header = [...cols.map((c) => c.label), "Triage note"];
  const lines = rows.map((r) => [...cols.map((c) => (c.text ? c.text(r) : c.value(r))), r.triage?.note ?? ""].map(cell).join(","));
  const blob = new Blob([[header.map(cell).join(","), ...lines].join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spectra-${show}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
