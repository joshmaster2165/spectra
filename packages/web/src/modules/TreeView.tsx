import { useMemo, useState } from "react";
import type { GraphState, MapNode } from "@spectra/schema";
import { StatusChip } from "../components/Status.tsx";

const KIND_ORDER = { root: 0, category: 1, leaf: 2 } as const;

/** Hierarchy view: collapsible root → category → leaf outline. */
export function TreeView({
  state,
  selected,
  onSelect,
  onOpen,
}: {
  state: GraphState;
  selected?: string;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const { roots, children } = useMemo(() => {
    const children = new Map<string, MapNode[]>();
    const roots: MapNode[] = [];
    for (const n of Object.values(state.nodes)) {
      if (n.parentId && state.nodes[n.parentId]) {
        const list = children.get(n.parentId) ?? [];
        list.push(n);
        children.set(n.parentId, list);
      } else {
        roots.push(n);
      }
    }
    const sort = (a: MapNode, b: MapNode) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.label.localeCompare(b.label);
    for (const list of children.values()) list.sort(sort);
    return { roots: roots.sort(sort), children };
  }, [state.nodes]);

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const countLeaves = (id: string): number =>
    (children.get(id) ?? []).reduce((sum, c) => sum + (c.kind === "leaf" ? 1 : 0) + countLeaves(c.id), 0);

  const renderNode = (n: MapNode) => {
    const kids = children.get(n.id) ?? [];
    const open = !collapsed.has(n.id);
    return (
      <li key={n.id}>
        <div
          className={`tree-row ${n.status} ${n.outOfScope ? "oob" : ""} ${selected === n.id ? "selected" : ""}`}
          onClick={() => onSelect(n.id)}
          onDoubleClick={() => onOpen(n.id)}
        >
          <button
            className={`caret ${kids.length ? "" : "none"} ${open ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              if (kids.length) toggle(n.id);
            }}
            aria-label={open ? "collapse" : "expand"}
          >
            <svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
          <span className={`glyph ${n.kind}`} />
          <span className="tree-label">
            {n.label}
            {n.outOfScope && <span className="oob-tag">out of scope</span>}
          </span>
          {n.kind !== "leaf" && <span className="tree-count">{countLeaves(n.id)}</span>}
          <span className="tree-kind">{n.kind === "leaf" ? (n.meta?.tool as string) ?? n.category : n.kind}</span>
          <StatusChip status={n.status} />
        </div>
        {kids.length > 0 && open && <ul>{kids.map(renderNode)}</ul>}
      </li>
    );
  };

  if (!roots.length) return <div className="empty">No objects.</div>;
  return <ul className="tree">{roots.map(renderNode)}</ul>;
}
