import type { NodeStatus } from "@spectra/schema";

export function StatusChip({ status }: { status: NodeStatus }) {
  return <span className={`chip ${status}`}>{status}</span>;
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
