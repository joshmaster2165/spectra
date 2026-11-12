import { SURFACE_TAGS, TRIAGE_LABEL, type NodeStatus, type TriageState } from "@spectra/schema";
import { Segmented } from "./Panel.tsx";
import { isFiltering, NO_FILTER, type SurfaceFilter, type SurfaceIndex } from "../filters.ts";

/** Search, surface tags, status, leads and triage — the same filter drives the Graph and the Surface table. */
export function FilterBar({ index, filter, onChange }: { index: SurfaceIndex; filter: SurfaceFilter; onChange: (f: SurfaceFilter) => void }) {
  const set = (patch: Partial<SurfaceFilter>) => onChange({ ...filter, ...patch });
  const toggleTag = (t: (typeof SURFACE_TAGS)[number]) => set({ tags: filter.tags.includes(t) ? filter.tags.filter((x) => x !== t) : [...filter.tags, t] });
  const present = SURFACE_TAGS.filter((t) => index.tagCounts.has(t) || filter.tags.includes(t));

  return (
    <div className="filter-bar">
      <input type="search" placeholder="Filter targets" value={filter.query} onChange={(e) => set({ query: e.target.value })} aria-label="Filter targets by name or host" />
      <Segmented<"all" | NodeStatus>
        value={filter.status}
        onChange={(status) => set({ status })}
        options={[
          { value: "all", label: "All" },
          { value: "unexplored", label: "Unmapped" },
          { value: "active", label: "Active" },
          { value: "complete", label: "Confirmed" },
        ]}
      />
      <button className={`toggle ${filter.leadsOnly ? "on" : ""}`} onClick={() => set({ leadsOnly: !filter.leadsOnly })} title="Only targets the Navigator has scored">
        Leads only
      </button>
      <select value={filter.triage} onChange={(e) => set({ triage: e.target.value as SurfaceFilter["triage"] })} aria-label="Filter by your triage mark" title="Filter by your triage mark">
        <option value="all">Any triage</option>
        <option value="none">Not marked</option>
        {(Object.keys(TRIAGE_LABEL) as TriageState[]).map((t) => (
          <option key={t} value={t}>
            {TRIAGE_LABEL[t]}
          </option>
        ))}
      </select>
      {isFiltering(filter) && (
        <button className="toggle clear" onClick={() => onChange(NO_FILTER)}>
          Clear
        </button>
      )}
      {present.length > 0 && (
        <div className="tag-row">
          {present.map((t) => (
            <button key={t} className={`tag ${t} ${filter.tags.includes(t) ? "on" : ""}`} onClick={() => toggleTag(t)} title={`Targets that look like ${t} surface`}>
              {t}
              <span>{index.tagCounts.get(t) ?? 0}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
