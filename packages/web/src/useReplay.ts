import { useCallback, useEffect, useMemo, useState } from "react";
import { applyEvent, emptyState, type GraphState, type SessionInfo, type SpectraEvent } from "@spectra/schema";

/** Keep a reduced state every N events so scrubbing never replays from zero. */
const CHECKPOINT_EVERY = 250;
const MAX_GAP_MS = 800;

export type Replay = ReturnType<typeof useReplay>;

/** Loads a recorded session from the hub's audit log and replays it event by event. */
export function useReplay() {
  const [active, setActive] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [events, setEvents] = useState<SpectraEvent[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);

  const checkpoints = useMemo(() => {
    const cps: GraphState[] = [emptyState()];
    let s = emptyState();
    events.forEach((e, i) => {
      s = applyEvent(s, e);
      if ((i + 1) % CHECKPOINT_EVERY === 0) cps.push(s);
    });
    return cps;
  }, [events]);

  const state = useMemo(() => {
    const cp = Math.min(Math.floor(index / CHECKPOINT_EVERY), checkpoints.length - 1);
    let s = checkpoints[cp];
    for (let i = cp * CHECKPOINT_EVERY; i < index; i++) s = applyEvent(s, events[i]);
    return s;
  }, [index, checkpoints, events]);

  // Playback follows the recorded gaps between events, sped up and capped.
  useEffect(() => {
    if (!playing) return;
    if (index >= events.length) return setPlaying(false);
    const gap = index > 0 ? (events[index].ts - events[index - 1].ts) / speed : 0;
    const t = setTimeout(() => setIndex((i) => i + 1), Math.min(Math.max(gap, 16), MAX_GAP_MS));
    return () => clearTimeout(t);
  }, [playing, index, events, speed]);

  const load = useCallback(async (id: string) => {
    setPlaying(false);
    setSessionId(id);
    const res = await fetch(`/history?session=${encodeURIComponent(id)}`);
    const evs: SpectraEvent[] = await res.json();
    setEvents(evs);
    setIndex(evs.length);
  }, []);

  const open = useCallback(
    async (preferred?: string) => {
      const list: SessionInfo[] = await fetch("/sessions").then((r) => r.json());
      setSessions(list);
      setActive(true);
      const id = list.find((s) => s.id === preferred)?.id ?? list[0]?.id;
      if (id) await load(id);
    },
    [load],
  );

  const close = useCallback(() => {
    setPlaying(false);
    setActive(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (index >= events.length) setIndex(0);
    setPlaying((p) => !p);
  }, [index, events.length]);

  return { active, sessions, sessionId, events, index, playing, speed, state, open, close, load, setIndex, setSpeed, togglePlay };
}
