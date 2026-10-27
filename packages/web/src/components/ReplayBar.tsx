import { useMemo } from "react";
import type { Replay } from "../useReplay.ts";
import { Segmented } from "./Panel.tsx";
import { clock } from "../format.ts";

const SPEEDS = [1, 4, 16, 64].map((s) => ({ value: String(s), label: `${s}×` }));

/** Session scrubber: pick a recorded session, scrub or play it back. */
export function ReplayBar({ replay }: { replay: Replay }) {
  const { events, index, playing, speed, sessions, sessionId } = replay;
  const total = events.length;

  const markers = useMemo(
    () =>
      events.flatMap((e, i) =>
        e.type === "scope.violation" ? [{ i, kind: "violation" }] : e.type === "finding.upsert" ? [{ i, kind: "finding" }] : [],
      ),
    [events],
  );

  const current = events[Math.max(0, index - 1)];
  const step = (d: number) => replay.setIndex(Math.min(total, Math.max(0, index + d)));

  return (
    <div className="replay">
      <span className="replay-tag">Replay</span>
      <select value={sessionId ?? ""} onChange={(e) => replay.load(e.target.value)}>
        {sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id.slice(0, 18)} · {new Date(s.updated).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </option>
        ))}
      </select>
      <div className="transport">
        <button onClick={() => step(-1)} aria-label="Step back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1v8M9 1L4 5l5 4z" fill="currentColor" stroke="currentColor" /></svg>
        </button>
        <button onClick={replay.togglePlay} aria-label={playing ? "Pause" : "Play"} className="play">
          {playing ? (
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1h2v8H2zM6 1h2v8H6z" fill="currentColor" /></svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z" fill="currentColor" /></svg>
          )}
        </button>
        <button onClick={() => step(1)} aria-label="Step forward">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M8 1v8M1 1l5 4-5 4z" fill="currentColor" stroke="currentColor" /></svg>
        </button>
      </div>
      <div className="scrubber">
        <div className="markers">
          {total > 0 &&
            markers.map((m) => <i key={m.i} className={m.kind} style={{ left: `${(m.i / total) * 100}%` }} />)}
        </div>
        <input type="range" min={0} max={total} value={index} onChange={(e) => replay.setIndex(Number(e.target.value))} />
      </div>
      <span className="replay-pos">
        {index}/{total} · {current ? clock(current.ts) : "--:--:--"}
      </span>
      <Segmented value={String(speed)} options={SPEEDS} onChange={(v) => replay.setSpeed(Number(v))} />
      <button className="exit" onClick={replay.close}>Back to live</button>
    </div>
  );
}
