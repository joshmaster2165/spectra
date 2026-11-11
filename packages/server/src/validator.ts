import Anthropic from "@anthropic-ai/sdk";
import { WebSocket } from "ws";
import {
  applyEvent,
  emptyState,
  type Assessment,
  type FindingAssessment,
  type GraphState,
  type Recommendation,
  type ServerMessage,
} from "@spectra/schema";

/**
 * The Navigator — the validator in the second seat.
 *
 * It connects to the hub as a read-only consumer, exactly like a dashboard,
 * rebuilds the same GraphState the operator sees, and asks a second model to
 * read the map and say where the promise is. Its output is advice: scored leads
 * and independent verdicts on the driver's findings. It never touches the
 * target and it can't set scope or operator verdicts — the hub stamps its
 * events `validator` and accepts only leads and finding verdicts from it.
 *
 * This is the one process in Spectra that makes an outbound connection (to the
 * Anthropic API). It is opt-in: start it with `npm run validator` once a hub is
 * up, with ANTHROPIC_API_KEY set.
 *
 *   SPECTRA_HUB            hub base url (default http://127.0.0.1:4317)
 *   SPECTRA_VALIDATOR_MODEL  model id (default claude-opus-5-5)
 *   SPECTRA_VALIDATOR_IDLE_MS  quiet period before a reassessment (default 2500)
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const WS_URL = HUB.replace(/^http/, "ws") + "/ws";
const MODEL = process.env.SPECTRA_VALIDATOR_MODEL ?? "claude-opus-5-5";
const IDLE_MS = Number(process.env.SPECTRA_VALIDATOR_IDLE_MS ?? 2500);
const MIN_GAP_MS = 15_000;
const MAX_NODES = 200;

const RECS: Recommendation[] = ["pursue", "watch", "skip"];
const VERDICTS = ["corroborated", "unconvinced", "needs-evidence"] as const;

const SYSTEM = `You are the Navigator, a read-only co-pilot for AUTHORIZED security testing. Another agent — the driver — is exploring a target and mapping what it touches. You sit in the second seat: you read the live map, you do not act on the target.

Your job each cycle:
1. Point at the promising areas. For map nodes worth the driver's attention, emit a lead with a 0–1 confidence (your estimate the area hides a real, in-scope bug), a recommendation (pursue / watch / skip), a short suspected bug class (e.g. idor, authz, injection, ssrf, secrets, auth-bypass), and a one-line rationale. Favour reachable, unauthenticated, or auth/identity-bearing surfaces and places the driver has not yet explored. Nodes "seen in proxy traffic" were observed on the wire but never tested by the driver — strong candidates when they look sensitive. It is fine — useful — to say skip.
2. Validate the driver's findings. For each finding, give an independent verdict (corroborated / unconvinced / needs-evidence) and a calibrated confidence, judging only from the evidence chain and map shown.

Hard rules:
- Authorized scope only. NEVER recommend pursuing anything marked [OUT OF SCOPE]. Do not emit leads for those nodes.
- You give direction and prioritization — triage, not attacks. Do NOT write exploit payloads, step-by-step intrusion instructions, or code.
- Be calibrated and specific. Reference node ids and finding ids exactly as given.
- Call submit_navigation exactly once with your leads and verdicts.`;

const TOOL: Anthropic.Tool = {
  name: "submit_navigation",
  description: "Report your leads and finding verdicts for the current state of the map.",
  input_schema: {
    type: "object",
    properties: {
      leads: {
        type: "array",
        description: "Scored pointers at map nodes. Omit nodes you have nothing to say about.",
        items: {
          type: "object",
          properties: {
            nodeId: { type: "string", description: "Exact id of the map node this points at" },
            title: { type: "string" },
            rationale: { type: "string" },
            bugClass: { type: "string" },
            confidence: { type: "number", description: "0–1" },
            recommendation: { type: "string", enum: RECS as unknown as string[] },
          },
          required: ["nodeId", "title", "confidence", "recommendation"],
        },
      },
      findingVerdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            findingId: { type: "string" },
            verdict: { type: "string", enum: VERDICTS as unknown as string[] },
            confidence: { type: "number", description: "0–1" },
            rationale: { type: "string" },
          },
          required: ["findingId", "verdict", "confidence"],
        },
      },
    },
    required: ["leads", "findingVerdicts"],
  },
};

const client = new Anthropic();
let state: GraphState = emptyState();

/** A compact, model-readable snapshot of what the operator currently sees. */
function digest(s: GraphState): string {
  const lines: string[] = [];
  if (s.scope) {
    lines.push(`Scope (${s.scope.origin}): paths=${s.scope.paths.join(", ") || "—"}; hosts=${s.scope.hosts.join(", ")}`);
  }
  lines.push("");

  // Over the cap, keep the attack surface (newest first) ahead of files, searches and commands.
  const SURFACE = new Set(["hosts", "endpoints", "params"]);
  const all = Object.values(s.nodes);
  const surface = all.filter((n) => SURFACE.has(n.category ?? "")).reverse();
  const rest = all.filter((n) => !SURFACE.has(n.category ?? "")).reverse();
  const nodes = [...surface, ...rest].slice(0, MAX_NODES);
  lines.push(all.length > nodes.length ? `Map — ${nodes.length} of ${all.length} nodes (attack surface first, newest first):` : `Map — ${nodes.length} nodes:`);
  for (const n of nodes) {
    const seenIn = n.meta?.["seen in"];
    const traffic = seenIn && `seen in ${seenIn}, ${n.meta?.requests} req${n.meta?.["status codes"] ? `, status ${n.meta["status codes"]}` : ""}`;
    const tags = [n.kind, n.status, n.category && `in:${n.category}`, traffic, n.outOfScope && "[OUT OF SCOPE]"].filter(Boolean).join(" ");
    const existing = s.assessments[`nav:${n.id}`];
    const prior = existing ? ` (you last said ${existing.recommendation} ${Math.round(existing.confidence * 100)}%)` : "";
    lines.push(`- ${n.id} "${n.label}" [${tags}]${prior}`);
  }
  lines.push("");

  const findings = Object.values(s.findings);
  lines.push(`Findings — ${findings.length}:`);
  for (const f of findings) {
    const loc = f.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ""}` : "—";
    const steps = (f.stepIds ?? []).map((id) => s.chain[id]?.title).filter(Boolean);
    lines.push(`- ${f.id} "${f.title}" [sev:${f.severity} status:${f.status} by:${f.reportedBy ?? "?"}] at ${loc}`);
    if (f.description) lines.push(`    ${f.description}`);
    if (steps.length) lines.push(`    chain: ${steps.join(" → ")}`);
  }
  lines.push("");

  const statuses = Object.values(s.nodes).reduce(
    (a, n) => ((a[n.status] = (a[n.status] ?? 0) + 1), a),
    {} as Record<string, number>,
  );
  lines.push(`Coverage: ${statuses.unexplored ?? 0} unexplored, ${statuses.active ?? 0} active, ${statuses.complete ?? 0} complete.`);
  lines.push("Assess the current map. Call submit_navigation once.");
  return lines.join("\n");
}

async function assess() {
  if (!Object.keys(state.nodes).length) return;
  const sessionId = state.sessionId ?? "validator";

  let res;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: digest(state) }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error("[navigator] auth failed — set ANTHROPIC_API_KEY (or run `ant auth login`). Exiting.");
      process.exit(1);
    }
    console.error("[navigator] model call failed:", err instanceof Error ? err.message : err);
    return;
  }

  const stop: string = res.stop_reason ?? "";
  if (stop === "refusal") {
    console.error("[navigator] model declined to assess this state; skipping cycle.");
    return;
  }

  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) return;
  const input = call.input as { leads?: unknown[]; findingVerdicts?: unknown[] };

  const now = Date.now();
  const events: Array<Record<string, unknown>> = [];

  for (const raw of Array.isArray(input.leads) ? input.leads : []) {
    const l = raw as Record<string, unknown>;
    const nodeId = typeof l.nodeId === "string" ? l.nodeId : undefined;
    const node = nodeId ? state.nodes[nodeId] : undefined;
    // Guardrail: never advise on nodes outside the authorized scope.
    if (!node || node.outOfScope) continue;
    const recommendation = RECS.includes(l.recommendation as Recommendation) ? (l.recommendation as Recommendation) : "watch";
    const assessment: Assessment = {
      id: `nav:${nodeId}`,
      nodeId,
      title: String(l.title ?? node.label),
      rationale: typeof l.rationale === "string" ? l.rationale : undefined,
      bugClass: typeof l.bugClass === "string" ? l.bugClass : undefined,
      confidence: clamp(l.confidence),
      recommendation,
      ts: now,
    };
    events.push({ type: "assessment.upsert", assessment, sessionId });
  }

  for (const raw of Array.isArray(input.findingVerdicts) ? input.findingVerdicts : []) {
    const v = raw as Record<string, unknown>;
    const findingId = typeof v.findingId === "string" ? v.findingId : undefined;
    if (!findingId || !state.findings[findingId]) continue;
    if (!VERDICTS.includes(v.verdict as (typeof VERDICTS)[number])) continue;
    const assessment: FindingAssessment = {
      verdict: v.verdict as FindingAssessment["verdict"],
      confidence: clamp(v.confidence),
      rationale: typeof v.rationale === "string" ? v.rationale : undefined,
      ts: now,
    };
    events.push({ type: "finding.assessment", findingId, assessment, sessionId });
  }

  if (!events.length) return;
  try {
    await fetch(`${HUB}/validator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
    console.error(`[navigator] posted ${events.length} assessment(s) for session ${sessionId}`);
  } catch (err) {
    console.error("[navigator] hub unreachable:", err instanceof Error ? err.message : err);
  }
}

function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/* ── Live connection to the hub ─────────────────────────── */

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let lastRun = 0;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, IDLE_MS);
}

async function tick() {
  if (running) return schedule();
  const since = Date.now() - lastRun;
  if (since < MIN_GAP_MS) {
    timer = setTimeout(tick, MIN_GAP_MS - since);
    return;
  }
  running = true;
  try {
    await assess();
  } finally {
    running = false;
    lastRun = Date.now();
  }
}

function connect() {
  const ws = new WebSocket(WS_URL, { origin: HUB });
  ws.on("open", () => console.error(`[navigator] watching ${WS_URL} with ${MODEL}`));
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
    schedule();
  });
  ws.on("close", () => {
    console.error("[navigator] hub connection closed; retrying in 3s");
    setTimeout(connect, 3000);
  });
  ws.on("error", (err) => console.error("[navigator] socket error:", err.message));
}

connect();
