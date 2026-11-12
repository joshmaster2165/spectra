import { WebSocket } from "ws";
import { applyEvent, emptyState, type GraphState, type ServerMessage } from "@spectra/schema";
import { DEFAULT_MODEL, Navigator } from "./navigator.ts";

/**
 * The Navigator as its own process. It connects to the hub as a read-only
 * consumer, exactly like a dashboard, and posts its leads and verdicts to the
 * hub's /validator channel. (The hub can also run the Navigator itself: turn
 * it on in the dashboard's Settings.)
 *
 *   ANTHROPIC_API_KEY=… npm run validator
 *
 *   SPECTRA_HUB                hub base url (default http://127.0.0.1:4317)
 *   SPECTRA_VALIDATOR_MODEL    model id (default claude-opus-5-5)
 *   SPECTRA_VALIDATOR_IDLE_MS  quiet period before a reassessment (default 2500)
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const WS_URL = HUB.replace(/^http/, "ws") + "/ws";
const MODEL = process.env.SPECTRA_VALIDATOR_MODEL ?? DEFAULT_MODEL;
const log = (msg: string) => console.error(`[navigator] ${msg}`);

let state: GraphState = emptyState();

const navigator = new Navigator({
  getState: () => state,
  model: MODEL,
  idleMs: Number(process.env.SPECTRA_VALIDATOR_IDLE_MS ?? 2500),
  log,
  post: async (events) => {
    try {
      await fetch(`${HUB}/validator`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(events) });
    } catch (err) {
      log(`hub unreachable: ${err instanceof Error ? err.message : err}`);
    }
  },
});

// A missing or rejected key, or an unknown model, won't fix itself in this process.
setInterval(() => {
  const { state: s, lastError = "" } = navigator.status();
  if (s !== "error") return;
  const fix = /model/i.test(lastError) ? "Check SPECTRA_VALIDATOR_MODEL." : "Set ANTHROPIC_API_KEY (or run `ant auth login`).";
  log(`${lastError} ${fix} Exiting.`);
  process.exit(1);
}, 1000);

function connect() {
  const ws = new WebSocket(WS_URL, { origin: HUB });
  ws.on("open", () => log(`watching ${WS_URL} with ${MODEL}`));
  ws.on("message", (data) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.kind === "snapshot") state = msg.state;
    else if (msg.kind === "event") state = applyEvent(state, msg.event);
    else return;
    // Our own advice shouldn't trigger another cycle.
    if (msg.kind === "event" && msg.event.source === "validator") return;
    navigator.notify();
  });
  ws.on("close", () => {
    log("hub connection closed; retrying in 3s");
    setTimeout(connect, 3000);
  });
  ws.on("error", (err) => log(`socket error: ${err.message}`));
}

connect();
