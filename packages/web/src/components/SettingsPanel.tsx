import { useEffect, useState } from "react";
import type { GraphState } from "@spectra/schema";
import { clock } from "../format.ts";

interface NavigatorView {
  enabled: boolean;
  model: string;
  hasKey: boolean;
  keySource: "settings" | "environment" | null;
  keyHint: string | null;
  status: { state: "off" | "idle" | "assessing" | "error"; model: string; runs: number; lastRun?: number; lastPosted?: number; lastError?: string };
}

interface InterpreterView {
  mode: "off" | "unread" | "all";
  status: { state: "off" | "idle" | "reading" | "error"; model: string; read: number; queued: number; lastRun?: number; lastError?: string };
  /** Unread actions whose output the hub still holds. */
  waiting: number;
}

interface Health {
  hub: { startedAt: number; events: number };
  scope: { set: boolean; origin?: string; paths?: number; hosts?: number };
  hooks: { lastSeen: number | null; sessions: number };
  observer: { enabled: boolean };
  mcp: { lastSeen: number | null };
  proxy: { lastImport: number | null };
  navigator: NavigatorView & { externalLastSeen: number | null };
  audit: { enabled: boolean; dir: string | null };
  interpreter: InterpreterView;
  actions: { total: number; unread: number; open: number };
  engagement: { started: number; sessions: number; restored: { events: number; sessions: number } | null } | null;
}

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const STATE_LABEL = { off: "Off", idle: "Running", assessing: "Assessing…", error: "Stopped" } as const;

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
function ago(ts: number | null | undefined) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/**
 * Settings: the Navigator's key and model, the scope, and a checklist of what's
 * connected. The API key is write-only here — the hub stores it and never sends
 * it back.
 */
export function SettingsPanel({ state, onClose }: { state: GraphState; onClose: () => void }) {
  const [nav, setNav] = useState<NavigatorView>();
  const [interp, setInterp] = useState<InterpreterView>();
  const [health, setHealth] = useState<Health>();
  const [offline, setOffline] = useState(false);

  const refresh = async () => {
    try {
      const [s, h] = await Promise.all([fetch("/settings").then((r) => r.json()), fetch("/health").then((r) => r.json())]);
      setNav(s.navigator);
      setInterp(s.interpreter);
      setHealth(h);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  };
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 3000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="modal-body">
          {offline && <p className="alert-text">Can't reach the hub. Is `npm start` still running?</p>}
          {nav && <NavigatorSettings nav={nav} onSaved={setNav} />}
          {nav && interp && <InterpreterSettings nav={nav} interp={interp} onSaved={setInterp} />}
          <ScopeSettings state={state} onSaved={refresh} />
          {health && <EngagementSettings health={health} targets={Object.keys(state.nodes).length} onReset={refresh} />}
          {health && <SetupChecklist health={health} />}
        </div>
      </div>
    </div>
  );
}

function NavigatorSettings({ nav, onSaved }: { nav: NavigatorView; onSaved: (n: NavigatorView) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(nav.model);
  const [test, setTest] = useState<{ ok: boolean; text: string }>();
  const [busy, setBusy] = useState(false);

  const save = async (patch: Record<string, unknown>) => {
    const res = await post("/settings", { navigator: patch });
    if (res.ok) onSaved((await res.json()).navigator);
    return res.ok;
  };
  const saveKey = async () => {
    if (await save({ apiKey: key.trim() })) {
      setKey("");
      setTest(undefined);
    }
  };
  const runTest = async () => {
    setBusy(true);
    setTest(undefined);
    try {
      const r = await (await post("/navigator/test", {})).json();
      setTest(r.ok ? { ok: true, text: "Connected. The key and model work." } : { ok: false, text: r.error ?? "The test failed." });
    } catch {
      setTest({ ok: false, text: "Couldn't reach the hub." });
    }
    setBusy(false);
  };

  const s = nav.status;
  return (
    <section className="settings-section">
      <h3>
        Navigator <span className={`state-pill ${s.state}`}>{STATE_LABEL[s.state]}</span>
      </h3>
      <p className="hint">
        A second model that reads your map, scores where to dig and checks findings. It only advises; it never touches the target. This key is separate from the one Claude Code uses.
      </p>

      <label className="field-row">
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={nav.hasKey ? `Saved (${nav.keyHint}). Enter a new key to replace it` : "sk-ant-…"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && void saveKey()}
        />
        <button className="ghost" disabled={!key.trim()} onClick={saveKey}>
          Save key
        </button>
        {nav.keySource === "settings" && (
          <button className="ghost" onClick={() => save({ apiKey: "", enabled: false })}>
            Remove
          </button>
        )}
      </label>
      <p className="hint small">
        {nav.keySource === "environment"
          ? "Using ANTHROPIC_API_KEY from the hub's environment. A key saved here takes its place."
          : "Stored on this machine in ~/.spectra/settings.json, readable only by you, and sent only to the Anthropic API."}
      </p>

      <label className="field-row">
        <span>Model</span>
        <input list="navigator-models" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} onBlur={() => model !== nav.model && void save({ model: model.trim() })} />
        <datalist id="navigator-models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button className="ghost" disabled={!nav.hasKey || busy} onClick={runTest}>
          {busy ? "Testing…" : "Test connection"}
        </button>
      </label>
      {test && <p className={`hint small ${test.ok ? "ok-text" : "alert-text"}`}>{test.text}</p>}

      <label className="field-row check">
        <input type="checkbox" checked={nav.enabled} disabled={!nav.hasKey} onChange={(e) => save({ enabled: e.target.checked })} />
        <span>Run the Navigator in the hub{!nav.hasKey && " (add a key first)"}</span>
      </label>
      <p className="hint small">
        {s.state === "error" && <span className="alert-text">{s.lastError} Fix the key or model above. </span>}
        {s.runs > 0 && `${s.runs} assessment${s.runs === 1 ? "" : "s"} · last ${ago(s.lastRun)} posted ${s.lastPosted} lead${s.lastPosted === 1 ? "" : "s"} and verdicts. `}
        {s.state !== "error" && s.lastError && `Last error: ${s.lastError} `}
        {nav.enabled && s.runs === 0 && s.state !== "error" && "Waiting for the map to change, then for a quiet moment."}
      </p>
    </section>
  );
}

/**
 * The second seat's other job: reading the actions the hub couldn't. It is the
 * one setting that sends command output off the machine, so it says so.
 */
function InterpreterSettings({ nav, interp, onSaved }: { nav: NavigatorView; interp: InterpreterView; onSaved: (i: InterpreterView) => void }) {
  const s = interp.status;
  const setMode = async (mode: string) => {
    const res = await post("/settings", { interpreter: { mode } }).catch(() => undefined);
    if (res?.ok) onSaved((await res.json()).interpreter);
  };
  // A mode can be saved with no key to run it (the key was removed): say so rather than "Running".
  const idle = interp.mode !== "off" && s.state === "off";
  const pill = interp.mode === "off" || idle ? "off" : s.state === "error" ? "error" : s.state === "reading" ? "assessing" : "idle";
  return (
    <section className="settings-section">
      <h3>
        Interpreter <span className={`state-pill ${pill}`}>{interp.mode === "off" ? "Off" : idle ? "No key" : s.state === "error" ? "Stopped" : s.state === "reading" ? "Reading…" : "Running"}</span>
      </h3>
      <p className="hint">
        Spectra records every action, but it can only read the ones whose targets are written in the command. The Interpreter has the same model read the rest — scripts, scanners, commands built from
        variables — and adds what their output shows to the map, marked as found in output.
      </p>
      <label className="field-row">
        <span>Read</span>
        <select value={interp.mode} disabled={!nav.hasKey} onChange={(e) => void setMode(e.target.value)}>
          <option value="off">Nothing (off)</option>
          <option value="unread">Actions Spectra can't read</option>
          <option value="all">Those, and any output that lists paths</option>
        </select>
        {!nav.hasKey && <span className="hint small">Add an API key above first.</span>}
      </label>
      <p className="hint small">
        {interp.mode === "off"
          ? "Off: nothing a command prints leaves this machine. Unread actions are still listed under Oversight → Actions."
          : "On: for each action it reads, the command and up to 6,000 characters of its output go to the Anthropic API, with credentials, tokens and email addresses masked first. Only targets that appear in that text and are in scope reach the map."}{" "}
        {s.state === "error" && <span className="alert-text">{s.lastError} Fix the key or model above. </span>}
        {s.read > 0 && `Read ${s.read} action${s.read === 1 ? "" : "s"} · last ${ago(s.lastRun)}. `}
        {s.queued > 0 && `${s.queued} queued. `}
        {interp.mode === "off" && interp.waiting > 0 && `${interp.waiting} unread action${interp.waiting === 1 ? " is" : "s are"} waiting with output in hand. `}
        {s.state !== "error" && s.lastError && `Last error: ${s.lastError}`}
      </p>
    </section>
  );
}

function ScopeSettings({ state, onSaved }: { state: GraphState; onSaved: () => void }) {
  const scope = state.scope;
  const [paths, setPaths] = useState((scope?.paths ?? []).join("\n"));
  const [hosts, setHosts] = useState((scope?.hosts ?? []).filter((h) => !LOOPBACK.has(h)).join("\n"));
  const [saved, setSaved] = useState<string>();

  const save = async () => {
    const body: { paths?: string[]; hosts: string[] } = { hosts: lines(hosts).map((h) => h.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "")) };
    // Paths the sessions supplied stay theirs unless you edit them: sending them would
    // pin the scope, and later sessions would stop adding their working directories.
    if (scope?.origin === "config" || lines(paths).join("\n") !== (scope?.paths ?? []).join("\n")) body.paths = lines(paths);
    const res = await post("/scope", body).catch(() => undefined);
    setSaved(res?.ok ? `Saved ${clock(Date.now())}` : "Couldn't reach the hub.");
    if (res?.ok) onSaved();
  };

  return (
    <section className="settings-section">
      <h3>Scope</h3>
      <p className="hint">What you're authorized to test. Anything the agent touches outside it is flagged, and only in-scope hosts are imported from proxy history.</p>
      <div className="field-cols">
        <label>
          <span>Paths (one per line)</span>
          <textarea rows={3} spellCheck={false} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="/path/to/target-repo" />
        </label>
        <label>
          <span>Hosts (one per line, subdomains included)</span>
          <textarea rows={3} spellCheck={false} value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="example-shop.test" />
        </label>
      </div>
      <div className="field-row">
        <button className="ghost" onClick={save}>
          Save scope
        </button>
        <span className="hint small">
          {saved ?? (scope ? `Set by ${scope.origin === "config" ? "you" : "the session's working directory"}. Loopback is always in scope.` : "No scope yet.")} Changes here are kept with the engagement; put them in
          spectra.config.json to make them the default.
        </span>
      </div>
    </section>
  );
}

/** The live map is kept across hub restarts; this is where you clear it for the next target. */
function EngagementSettings({ health, targets, onReset }: { health: Health; targets: number; onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(false);
  const e = health.engagement;
  const reset = async () => {
    const res = await post("/engagement/new", {}).catch(() => undefined);
    setError(!res?.ok);
    setConfirming(false);
    if (res?.ok) onReset();
  };
  const started = e ? new Date(e.started).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
  return (
    <section className="settings-section">
      <h3>Engagement</h3>
      <p className="hint">
        {e
          ? "The map, your triage marks, findings and leads are kept when the hub restarts. Start a new engagement to clear the map for the next target; recorded sessions stay in Replay."
          : "The audit log is off (SPECTRA_PERSIST=0), so the map is lost when the hub stops."}
      </p>
      <div className="field-row">
        {confirming ? (
          <>
            <button className="ghost danger" onClick={reset}>
              Clear the map
            </button>
            <button className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <span className="hint small">
              This removes {targets} target{targets === 1 ? "" : "s"} from the live map for everyone viewing it. It can't be undone from here.
            </span>
          </>
        ) : (
          <>
            <button className="ghost" onClick={() => setConfirming(true)} disabled={!targets}>
              New engagement
            </button>
            <span className="hint small">
              {error && <span className="alert-text">Couldn't reach the hub. </span>}
              {e && `Started ${started} · ${e.sessions} session${e.sessions === 1 ? "" : "s"}`}
              {e?.restored && ` · restored ${e.restored.events} events when the hub started`}
            </span>
          </>
        )}
      </div>
    </section>
  );
}

function SetupChecklist({ health: h }: { health: Health }) {
  const nav = h.navigator;
  const navOn = nav.status.state === "idle" || nav.status.state === "assessing" || !!nav.externalLastSeen;
  const rows: { state: "ok" | "todo" | "optional" | "warn"; name: string; detail: string }[] = [
    { state: "ok", name: "Hub", detail: `Running since ${clock(h.hub.startedAt)} · ${h.hub.events} events` },
    h.scope.set
      ? { state: "ok", name: "Scope", detail: `${h.scope.paths} path${h.scope.paths === 1 ? "" : "s"} · ${h.scope.hosts} hosts` }
      : { state: "todo", name: "Scope", detail: "Not set. Add paths or hosts above, or start a session." },
    h.hooks.lastSeen
      ? { state: "ok", name: "Claude Code hooks", detail: `Last event ${ago(h.hooks.lastSeen)} · ${h.hooks.sessions} session${h.hooks.sessions === 1 ? "" : "s"}` }
      : {
          state: "todo",
          name: "Claude Code hooks",
          detail: `No hook events yet. Run npm run hooks:install -- /path/to/project, then restart Claude Code.${h.observer.enabled ? " Until then, activity comes from Claude Code's session logs." : ""}`,
        },
    h.mcp.lastSeen
      ? { state: "ok", name: "Agent annotations (MCP)", detail: `Last annotation ${ago(h.mcp.lastSeen)}` }
      : { state: "optional", name: "Agent annotations (MCP)", detail: "Optional. Not seen yet: register the MCP server so the agent can record discoveries and findings." },
    nav.status.state === "error"
      ? { state: "warn", name: "Navigator", detail: nav.status.lastError ?? "Stopped by an error." }
      : navOn
        ? { state: "ok", name: "Navigator", detail: nav.status.runs ? `${nav.status.runs} assessment${nav.status.runs === 1 ? "" : "s"} · last ${ago(nav.status.lastRun)}` : nav.externalLastSeen ? `External process · last advice ${ago(nav.externalLastSeen)}` : "On, waiting for the map to change" }
        : { state: "optional", name: "Navigator", detail: nav.hasKey ? "Optional. A key is saved; turn it on above." : "Optional. Add an API key above to turn it on." },
    h.actions.open
      ? { state: "warn", name: "Actions", detail: `${h.actions.total} recorded · ${h.actions.open} Spectra couldn't read. See Oversight → Actions${h.interpreter.mode === "off" ? ", or turn the Interpreter on above" : ""}.` }
      : { state: "ok", name: "Actions", detail: h.actions.total ? `${h.actions.total} recorded, all accounted for${h.actions.unread ? ` (${h.actions.unread} needed a second look)` : ""}` : "None yet" },
    h.proxy.lastImport
      ? { state: "ok", name: "Proxy history", detail: `Last import ${ago(h.proxy.lastImport)}` }
      : { state: "optional", name: "Proxy history", detail: "Optional. Use Import HAR to add what your proxy saw." },
    h.audit.enabled ? { state: "ok", name: "Audit log", detail: h.audit.dir ?? "" } : { state: "warn", name: "Audit log", detail: "Off (SPECTRA_PERSIST=0): sessions aren't recorded or replayable." },
  ];
  return (
    <section className="settings-section">
      <h3>Setup</h3>
      <ul className="checklist">
        {rows.map((r) => (
          <li key={r.name} className={r.state}>
            <span className="dot" aria-label={r.state} />
            <span className="name">{r.name}</span>
            <span className="detail">{r.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
