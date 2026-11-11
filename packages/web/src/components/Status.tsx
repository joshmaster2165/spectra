import type { NodeStatus } from "@spectra/schema";

/** Recon wording for node states, shared by every view and the Coverage panel. */
export const STATUS_LABEL: Record<NodeStatus, string> = { unexplored: "unmapped", active: "active", complete: "confirmed" };

export function StatusChip({ status }: { status: NodeStatus }) {
  return <span className={`chip ${status}`}>{STATUS_LABEL[status]}</span>;
}

/** A 0–1 score as a bar and a percentage (agent confidence, Navigator leads). */
export function Confidence({ value = 0 }: { value?: number }) {
  return (
    <span className="conf" title={`confidence ${Math.round(value * 100)}%`}>
      <span className="conf-bar"><i style={{ width: `${value * 100}%` }} /></span>
      <span>{Math.round(value * 100)}%</span>
    </span>
  );
}

export function ImportanceBars({ value = 0 }: { value?: number }) {
  return (
    <span className="imp" title={`importance ${value}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= value ? "on" : ""} />
      ))}
    </span>
  );
}
