import { useEffect, useReducer, useState } from "react";
import { applyEvent, emptyState, type GraphState, type ServerMessage } from "@spectra/schema";

type Action = { kind: "snapshot"; state: GraphState } | { kind: "event"; event: any };

function reducer(state: GraphState, msg: Action): GraphState {
  return msg.kind === "snapshot" ? msg.state : applyEvent(state, msg.event);
}

/** Connects to the hub over WebSocket and keeps a live GraphState. Reconnects on drop. */
export function useSpectra() {
  const [state, dispatch] = useReducer(reducer, undefined, emptyState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => dispatch(JSON.parse(m.data) as ServerMessage);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { state, connected };
}
