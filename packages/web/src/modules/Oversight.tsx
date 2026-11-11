import { useState } from "react";
import { SEVERITY_RANK, type Assessment, type Finding, type FindingAssessment, type GraphState, type Review } from "@spectra/schema";
import { Segmented } from "../components/Panel.tsx";
import { Confidence } from "../components/Status.tsx";
import { clock, formatTool } from "../format.ts";

export type OversightTab = "findings" | "navigator" | "scope";

const VERDICT_LABEL: Record<Review["verdict"], string> = { verified: "Verified", rejected: "Rejected", "needs-info": "Needs info" };
const NAV_VERDICT_LABEL: Record<FindingAssessment["verdict"], string> = { corroborated: "Corroborated", unconvinced: "Unconvinced", "needs-evidence": "Needs evidence" };
const REC_LABEL: Record<Assessment["recommendation"], string> = { pursue: "Pursue", watch: "Watch", skip: "Skip" };
const REC_RANK: Record<Assessment["recommendation"], number> = { pursue: 0, watch: 1, skip: 2 };

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
  const leadCount = Object.keys(state.assessments).length;
  return (
    <div className="ledger-body">
      <Segmented
        value={tab}
        onChange={onTab}
        options={[
          { value: "findings", label: `Findings ${findings.length || ""}`.trim() },
          { value: "navigator", label: `Navigator ${leadCount || ""}`.trim() },
          { value: "scope", label: `Scope ${state.violations.length ? `· ${state.violations.length}` : ""}`.trim() },
        ]}
      />
      {tab === "findings" && <Findings state={state} onSelect={onSelect} />}
      {tab === "navigator" && <Navigator state={state} onSelect={onSelect} />}
      {tab === "scope" && <ScopeView state={state} onSelect={onSelect} />}
    </div>
  );
}

/** The Navigator's leads: a second model's scored read on where the promise is. */
function Navigator({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const leads = Object.values(state.assessments).sort(
    (a, b) => REC_RANK[a.recommendation] - REC_RANK[b.recommendation] || (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  if (!leads.length)
    return (
      <div className="empty">
        No leads yet. Start the Navigator with <code>npm run validator</code> to have a second model score the map and point at what's worth pursuing.
      </div>
    );
  return (
    <ul className="leads">
      {leads.map((l) => {
        const node = l.nodeId ? state.nodes[l.nodeId] : undefined;
        return (
          <li key={l.id} className={`lead ${l.recommendation}`} onClick={() => l.nodeId && onSelect(l.nodeId)}>
            <div className="lead-row">
              <span className={`rec ${l.recommendation}`}>{REC_LABEL[l.recommendation]}</span>
              <span className="lead-title">{l.title}</span>
              <Confidence value={l.confidence} />
            </div>
            <div className="lead-sub">
              {l.bugClass && <span className="bugclass">{l.bugClass}</span>}
              {node && <code>{node.label}</code>}
              {node?.outOfScope && <span className="oob-tag">out of scope</span>}
            </div>
            {l.rationale && <p className="lead-rationale">{l.rationale}</p>}
          </li>
        );
      })}
    </ul>
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
            {f.assessment && (
              <span className={`nav-verdict ${f.assessment.verdict}`} title={f.assessment.rationale}>
                Navigator: {NAV_VERDICT_LABEL[f.assessment.verdict]} {Math.round(f.assessment.confidence * 100)}%
              </span>
            )}
            {f.review ? (
              <span className={`verdict ${f.review.verdict}`} title={f.review.note}>{VERDICT_LABEL[f.review.verdict]}</span>
            ) : (
              <span className="verdict pending">Unreviewed</span>
            )}
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
  const edits = finding.edits ?? [];
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
      <h5>Remediation</h5>
      {edits.length ? (
        <ul className="edits">
          {edits.map((e) => (
            <li key={e.toolUseId}>
              <time>{clock(e.ts)}</time>
              <span className="tool">{formatTool(e.tool)}</span>
              <code>{e.path.split("/").slice(-3).join("/")}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{finding.location?.file ? "No edits to this file yet." : "No file location; edits can't be linked."}</p>
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
      <ReviewForm finding={finding} />
    </div>
  );
}

/** Operator verdict; posted to the hub, which records it as an operator event. */
function ReviewForm({ finding }: { finding: Finding }) {
  const [note, setNote] = useState(finding.review?.note ?? "");
  const [error, setError] = useState<string>();
  const submit = async (verdict: Review["verdict"]) => {
    setError(undefined);
    const res = await fetch("/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ findingId: finding.id, verdict, note }),
    }).catch(() => undefined);
    if (!res?.ok) setError("Couldn't reach the hub.");
  };
  return (
    <div className="review">
      <h5>Your review</h5>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Notes: how you checked it, what's missing…" rows={2} />
      <div className="review-actions">
        {(Object.keys(VERDICT_LABEL) as Review["verdict"][]).map((v) => (
          <button key={v} className={`${v} ${finding.review?.verdict === v ? "on" : ""}`} onClick={() => submit(v)}>
            {VERDICT_LABEL[v]}
          </button>
        ))}
        {finding.review && <span className="muted">Saved {clock(finding.review.ts)}</span>}
        {error && <span className="alert-text">{error}</span>}
      </div>
    </div>
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
