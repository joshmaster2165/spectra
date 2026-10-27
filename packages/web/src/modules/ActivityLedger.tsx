import { useState } from "react";
import type { GraphState, MapNode } from "@spectra/schema";
import { Segmented } from "../components/Panel.tsx";
import { ImportanceBars } from "../components/Status.tsx";
import { clock, formatTool } from "../format.ts";

const STATUS_ORDER = { active: 0, complete: 1, unexplored: 2 } as const;
type Tab = "stream" | "objects";
type Sort = "importance" | "category" | "status";

/** Thought Stream (why the agent switched tasks) + sortable object cards. */
export function ActivityLedger({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("stream");
  return (
    <div className="ledger-body">
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: "stream", label: "Stream" },
          { value: "objects", label: "Objects" },
        ]}
      />
      {tab === "stream" ? <ThoughtStream state={state} onSelect={onSelect} /> : <Cards state={state} onSelect={onSelect} />}
    </div>
  );
}

function ThoughtStream({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  // TODO: smarter filter for "task switch" moments (e.g. category changes between tool calls).
  const items = state.timeline.filter((e) => e.type === "thought" || e.type === "tool.call").slice(-120).reverse();
  const flagged = new Set(state.violations.map((v) => v.toolUseId));
  return (
    <ol className="stream">
      {items.map((e, i) => (
        <li key={i} className={e.type === "thought" ? "thought" : e.type === "tool.call" && flagged.has(e.toolUseId) ? "call oob" : "call"}>
          <time>{clock(e.ts)}</time>
          {e.type === "thought" ? (
            <p>
              {e.reason && <span className="reason">{e.reason}</span>}
              {e.text}
            </p>
          ) : e.type === "tool.call" ? (
            <p className="tool" onClick={() => e.nodeId && onSelect(e.nodeId)}>
              {flagged.has(e.toolUseId) && <span className="oob-tag">out of scope</span>}
              <b>{formatTool(e.tool)}</b>
              <span>{e.summary.slice(e.tool.length).trim()}</span>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Cards({ state, onSelect }: { state: GraphState; onSelect: (id: string) => void }) {
  const [sort, setSort] = useState<Sort>("importance");
  const cards = Object.values(state.nodes)
    .filter((n) => n.kind === "leaf")
    .sort(compare(sort));
  return (
    <>
      <div className="sort-row">
        <span>Sort</span>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="importance">Importance</option>
          <option value="category">Category</option>
          <option value="status">Status</option>
        </select>
      </div>
      <ul className="cards">
        {cards.map((n) => (
          <li key={n.id} className={`card ${n.status}`} onClick={() => onSelect(n.id)}>
            <span className="label">{n.label}</span>
            <span className="tag">{n.category}</span>
            <ImportanceBars value={n.importance} />
          </li>
        ))}
      </ul>
    </>
  );
}

function compare(by: Sort) {
  return (a: MapNode, b: MapNode) => {
    if (by === "importance") return (b.importance ?? 0) - (a.importance ?? 0);
    if (by === "category") return (a.category ?? "").localeCompare(b.category ?? "");
    return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
  };
}
