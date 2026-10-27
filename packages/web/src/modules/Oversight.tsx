import { useState } from "react";
import { SEVERITY_RANK, type Finding, type GraphState } from "@spectra/schema";
import { Segmented } from "../components/Panel.tsx";
import { clock, formatTool } from "../format.ts";

export type OversightTab = "findings" | "scope";

/** Findings ranked by severity/confidence with their evidence trail, plus scope status and violations. */
export function Oversight({
  state,
  tab,
  onTab,
  onSelect,
}: {
  state: GraphState;
  tab: OversightTab;
  onTab: (t: OversightTab) => void;
  onSelect: (id: string) => void;
}) {
  const findings = Object.values(state.findings);
  return (
    <div className="ledger-body">
      <Segmented
        value={tab}
        onChange={onTab}
        options={[
          { value: "findings", label: `Findings ${findings.length || ""}`.trim() },
          { value: "scope", label: `Scope ${state.violations.length ? `· ${state.violations.length}` : ""}`.trim() },
        ]}
      />
      {tab === "findings" ? <Findings state={state} onSelect={onSelect} /> : <ScopeView state={state} onSelect={onSelect} />}
    </div>
  );
}

const STATUS_RANK = { confirmed: 0, suspected: 1, fixed: 2, dismissed: 3 } as const;

function Findings({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState<string>();
  const list = Object.values(state.findings).sort(
    (a, b) =>
      STATUS_RANK[a.status ?? "suspected"] - STATUS_RANK[b.status ?? "suspected"] ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  if (!list.length) return <div className="empty">No findings. The agent reports them with <code>report_finding</code>.</div>;
  return (
    <ul className="findings">
      {list.map((f) => (
        <li key={f.id} className={`finding ${f.status} ${open === f.id ? "open" : ""}`}>
          <div className="f-row" onClick={() => setOpen(open === f.id ? undefined : f.id)}>
            <span className={`sev ${f.severity}`}>{f.severity}</span>
            <span className="f-title">{f.title}</span>
            <Confidence value={f.confidence} />
          </div>
          <div className="f-sub">
            <span className="f-id">{f.id}</span>
            {f.location && (
              <code>
                {f.location.file}
                {f.location.line ? `:${f.location.line}` : ""}
              </code>
            )}
            <span className="spacer" />
            <span className={`chip ${f.status === "confirmed" ? "complete" : f.status === "suspected" ? "active" : "unexplored"}`}>{f.status}</span>
            {f.reportedBy === "mcp" && <span className="claim" title="Reported by the agent; verify against the evidence">agent-reported</span>}
          </div>
          {open === f.id && <Evidence finding={f} state={state} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}

function Evidence({ finding, state, onSelect }: { finding: Finding; state: GraphState; onSelect: (id: string) => void }) {
  const steps = (finding.stepIds ?? []).map((id) => state.chain[id]).filter(Boolean);
  const nodes = (finding.nodeIds ?? []).map((id) => state.nodes[id]).filter(Boolean);
  return (
    <div className="evidence">
      {finding.description && <p>{finding.description}</p>}
      {steps.length > 0 && (
        <>
          <h5>Evidence trail</h5>
          <ol className="trail">
            {steps.map((s) => (
              <li key={s.id} className={s.confirmed ? "confirmed" : ""} onClick={() => s.nodeIds?.[0] && onSelect(s.nodeIds[0])}>
                {s.title}
              </li>
            ))}
          </ol>
        </>
      )}
      {nodes.length > 0 && (
        <>
          <h5>Objects</h5>
          <div className="obj-list">
            {nodes.map((n) => (
              <button key={n.id} onClick={() => onSelect(n.id)} className={n.outOfScope ? "oob" : ""}>
                {n.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Confidence({ value = 0 }: { value?: number }) {
  return (
    <span className="conf" title={`confidence ${Math.round(value * 100)}%`}>
      <span className="conf-bar"><i style={{ width: `${value * 100}%` }} /></span>
      <span>{Math.round(value * 100)}%</span>
    </span>
  );
}

function ScopeView({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const scope = state.scope;
  const violations = [...state.violations].reverse();
  return (
    <div className="scope-view">
      <dl className="scope-def">
        <div>
          <dt>Set by</dt>
          <dd>{scope ? (scope.origin === "config" ? "Operator config" : "Session working directory") : "Not set"}</dd>
        </div>
        <div>
          <dt>Paths</dt>
          <dd>{scope?.paths.length ? scope.paths.map((p) => <code key={p}>{p}</code>) : "—"}</dd>
        </div>
        <div>
          <dt>Hosts</dt>
          <dd>{scope?.hosts.map((h) => <code key={h}>{h}</code>) ?? "—"}</dd>
        </div>
      </dl>
      <h5>
        Violations <span>{violations.length}</span>
      </h5>
      {!violations.length && <p className="muted">No out-of-scope access recorded.</p>}
      <ul className="violations">
        {violations.map((v) => (
          <li key={v.id} onClick={() => v.nodeId && onSelect(v.nodeId)}>
            <time>{clock(v.ts)}</time>
            <span className={`sev ${v.severity}`}>{v.severity === "high" ? "high" : "med"}</span>
            <span className="v-access">{v.target.access}</span>
            <span className="v-target">
              <code>{v.target.value}</code>
              <span className="muted">
                {formatTool(v.tool)}
                {v.target.heuristic ? " · parsed from shell" : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
