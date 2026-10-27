import type { ReactNode } from "react";

export function Panel({
  area,
  title,
  meta,
  controls,
  children,
}: {
  area: string;
  title: string;
  meta?: ReactNode;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${area}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {controls}
        <span className="panel-meta">{meta}</span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
