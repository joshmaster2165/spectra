import { useEffect, useState } from "react";
import { useSpectra } from "./useSpectra.ts";
import { useReplay } from "./useReplay.ts";
import { Logo } from "./components/Logo.tsx";
import { Panel, Segmented } from "./components/Panel.tsx";
import { ReplayBar } from "./components/ReplayBar.tsx";
import { GlobalMap } from "./modules/GlobalMap.tsx";
import { TreeView } from "./modules/TreeView.tsx";
import { NodeView } from "./modules/NodeView.tsx";
import { ActivityLedger } from "./modules/ActivityLedger.tsx";
import { ChainBuilder } from "./modules/ChainBuilder.tsx";
import { ExplorationSketch } from "./modules/ExplorationSketch.tsx";
import { Oversight, type OversightTab } from "./modules/Oversight.tsx";
import { FilesView } from "./modules/FilesView.tsx";
import { downloadReport } from "./report.ts";
import { AuditStatus } from "./components/AuditStatus.tsx";
import { clock } from "./format.ts";

type View = "network" | "hierarchy" | "files" | "node";

const VIEWS: { value: View; label: string }[] = [
  { value: "network", label: "Network" },
  { value: "hierarchy", label: "Hierarchy" },
  { value: "files", label: "Files" },
  { value: "node", label: "Node" },
];

export function App() {
  const live = useSpectra();
  const replay = useReplay();
  const state = replay.active ? replay.state : live.state;

  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState<View>("network");
  const [oversightTab, setOversightTab] = useState<OversightTab>("findings");

  const open = (id: string) => {
    setSelected(id);
    setView("node");
  };

  const nodeCount = Object.keys(state.nodes).length;
  const edgeCount = Object.keys(state.edges).length;
  const violations = state.violations.length;
  const last = state.timeline.at(-1);

  // Unseen violations show in the browser tab title.
  useEffect(() => {
    document.title = violations ? `(${violations}) Spectra` : "Spectra";
  }, [violations]);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">
          <Logo />
          <span className="wordmark">SPECTRA</span>
        </span>
        <span className="divider" />
        <span className="field">
          <label>Session</label>
          <span>{state.sessionId ?? "Awaiting agent"}</span>
        </span>
        <span className="divider" />
        <button className="field scope-badge" onClick={() => setOversightTab("scope")} title="Show scope and violations">
          <label>Scope</label>
          <span>
            {state.scope ? `${state.scope.paths.length} path${state.scope.paths.length === 1 ? "" : "s"} · ${state.scope.hosts.length} hosts` : "unset"}
          </span>
          {violations > 0 && <span className="alert-pill">{violations} out of scope</span>}
        </button>
        <span className="spacer" />
        <button className="ghost" onClick={() => downloadReport(state)} title="Download a Markdown report of this session">
          Report
        </button>
        {replay.active ? (
          <span className="field link replaying">
            <span className="dot" />
            Replay
          </span>
        ) : (
          <>
            <button className="ghost" onClick={() => replay.open(live.state.sessionId)}>Replay</button>
            <span className={`field link ${live.connected ? "up" : "down"}`}>
              <span className="dot" />
              {live.connected ? "Live" : "Offline"}
            </span>
          </>
        )}
        <Clock />
      </header>

      {replay.active && <ReplayBar replay={replay} />}

      <main className="grid">
        <Panel
          area="map"
          title="Map"
          controls={<Segmented value={view} options={VIEWS} onChange={setView} />}
          meta={`${nodeCount} objects · ${edgeCount} links`}
        >
          {view === "network" && <GlobalMap state={state} selected={selected} onSelect={setSelected} onOpen={open} />}
          {view === "hierarchy" && <TreeView state={state} selected={selected} onSelect={setSelected} onOpen={open} />}
          {view === "files" && <FilesView state={state} />}
          {view === "node" && <NodeView state={state} nodeId={selected} onSelect={setSelected} />}
        </Panel>

        <Panel area="ledger" title="Activity" meta={`${state.timeline.length} events`}>
          <ActivityLedger state={state} onSelect={open} />
        </Panel>

        <Panel area="findings" title="Oversight" meta={violations ? <span className="alert-text">{violations} violations</span> : "in scope"}>
          <Oversight state={state} tab={oversightTab} onTab={setOversightTab} onSelect={open} />
        </Panel>

        <Panel area="chain" title="Chain" meta={`${Object.keys(state.chain).length} steps`}>
          <ChainBuilder state={state} onSelect={open} />
        </Panel>

        <Panel area="sketch" title="Coverage">
          <ExplorationSketch state={state} />
        </Panel>
      </main>

      <footer className="statusbar">
        <span>Hub {location.host}</span>
        <span>Hooks · Observer · MCP</span>
        <AuditStatus sessionId={replay.active ? replay.sessionId : state.sessionId} />
        <span className="spacer" />
        <span>Last event {last ? clock(last.ts) : "—"}</span>
      </footer>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="clock">{now.toISOString().slice(11, 19)} UTC</span>;
}
