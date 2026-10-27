import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileTouch, GraphState } from "@spectra/schema";
import { clock } from "../format.ts";

type ScopeFiles = { root: string; files: string[]; truncated: boolean };

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
  total: number;
  opened: number;
  edited: number;
}

/**
 * Files view: review coverage of the in-scope code. Every file under the scope
 * paths, marked read / edited / never opened, with per-directory coverage.
 */
export function FilesView({ state }: { state: GraphState }) {
  const [listing, setListing] = useState<ScopeFiles[]>();
  const [error, setError] = useState<string>();
  const [unopenedOnly, setUnopenedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scopeKey = state.scope?.paths.join("|") ?? "";
  const load = useCallback(() => {
    fetch("/files")
      .then((r) => r.json())
      .then((l: ScopeFiles[]) => {
        setListing(l);
        setExpanded(new Set(l.map((x) => x.root)));
        setError(undefined);
      })
      .catch(() => setError("Couldn't load the file list from the hub."));
  }, []);
  useEffect(load, [load, scopeKey]);

  const trees = useMemo(() => (listing ?? []).map((l) => buildTree(l, state.files)), [listing, state.files]);

  if (error) return <div className="empty">{error}</div>;
  if (!listing) return <div className="empty">Loading files…</div>;
  if (!listing.length) return <div className="empty">No scope paths set. Configure a scope to see review coverage.</div>;

  const total = trees.reduce((n, t) => n + t.total, 0);
  const opened = trees.reduce((n, t) => n + t.opened, 0);
  const edited = trees.reduce((n, t) => n + t.edited, 0);

  const toggle = (p: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(p) ? next.delete(p) : next.add(p);
      return next;
    });

  const renderDir = (d: Dir, depth: number): React.ReactNode => {
    if (unopenedOnly && d.opened === d.total) return null;
    const open = expanded.has(d.path);
    return (
      <li key={d.path}>
        <div className="file-row dir" onClick={() => toggle(d.path)} style={{ paddingLeft: 8 + depth * 14 }}>
          <span className={`caret ${open ? "open" : ""}`}>
            <svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 1 L6 4 L2 7" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
          </span>
          <span className="file-name">{d.name}/</span>
          <CoverageBar opened={d.opened} total={d.total} />
        </div>
        {open && (
          <ul>
            {[...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => renderDir(c, depth + 1))}
            {d.files
              .filter((f) => !unopenedOnly || !state.files[f])
              .map((f) => (
                <FileRow key={f} path={f} touch={state.files[f]} depth={depth + 1} />
              ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className="files-view">
      <div className="files-head">
        <span>
          <b>{opened}</b> of <b>{total}</b> files opened ({total ? Math.round((opened / total) * 100) : 0}%) · <b>{edited}</b> edited
        </span>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={unopenedOnly} onChange={(e) => setUnopenedOnly(e.target.checked)} />
          Unopened only
        </label>
        <button className="ghost" onClick={load}>Refresh</button>
      </div>
      {listing.some((l) => l.truncated) && <p className="muted files-note">Large tree: listing stopped at 20,000 files.</p>}
      <ul className="file-tree">{trees.map((t) => renderDir(t, 0))}</ul>
      <div className="legend">
        <span><i className="read" /> read</span>
        <span><i className="edited" /> edited</span>
        <span><i className="unopened" /> never opened</span>
      </div>
    </div>
  );
}

function FileRow({ path, touch, depth }: { path: string; touch?: FileTouch; depth: number }) {
  const status = !touch ? "unopened" : touch.writes ? "edited" : "read";
  return (
    <li>
      <div className={`file-row ${status}`} style={{ paddingLeft: 8 + depth * 14 + 14 }}>
        <span className="file-dot" />
        <span className="file-name">{path.split("/").pop()}</span>
        {touch && (
          <span className="file-meta">
            {touch.reads ? `${touch.reads}r` : ""} {touch.writes ? `${touch.writes}w` : ""} · {clock(touch.lastTs)}
          </span>
        )}
      </div>
    </li>
  );
}

function CoverageBar({ opened, total }: { opened: number; total: number }) {
  const pct = total ? opened / total : 0;
  return (
    <span className="file-cov">
      <span className="conf-bar"><i style={{ width: `${pct * 100}%` }} /></span>
      <span>
        {opened}/{total}
      </span>
    </span>
  );
}

function buildTree(l: ScopeFiles, touched: Record<string, FileTouch>): Dir {
  const root: Dir = { name: l.root, path: l.root, dirs: new Map(), files: [], total: 0, opened: 0, edited: 0 };
  for (const file of l.files) {
    const parts = file.slice(l.root.length + 1).split("/");
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const p = `${d.path}/${part}`;
      if (!d.dirs.has(part)) d.dirs.set(part, { name: part, path: p, dirs: new Map(), files: [], total: 0, opened: 0, edited: 0 });
      d = d.dirs.get(part)!;
    }
    d.files.push(file);
  }
  const count = (d: Dir) => {
    for (const c of d.dirs.values()) count(c);
    d.files.sort();
    d.total = d.files.length + [...d.dirs.values()].reduce((n, c) => n + c.total, 0);
    d.opened = d.files.filter((f) => touched[f]).length + [...d.dirs.values()].reduce((n, c) => n + c.opened, 0);
    d.edited = d.files.filter((f) => touched[f]?.writes).length + [...d.dirs.values()].reduce((n, c) => n + c.edited, 0);
  };
  count(root);
  return root;
}
