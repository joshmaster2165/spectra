import Anthropic from "@anthropic-ai/sdk";
import type { Assessment, FindingAssessment, GraphState, Recommendation } from "@spectra/schema";

/**
 * The Navigator — the validator in the second seat.
 *
 * It reads the same GraphState the operator sees and asks a second model where
 * the promise is. Its output is advice: scored leads and independent verdicts
 * on the driver's findings. It never touches the target, and the hub accepts
 * only leads and finding verdicts from it.
 *
 * This class is the whole Navigator. The hub runs it in-process when it's
 * enabled in Settings; `npm run validator` runs the same class as a separate
 * process over the hub's WebSocket.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";
const MIN_GAP_MS = 15_000;
const MAX_NODES = 200;

const RECS: Recommendation[] = ["pursue", "watch", "skip"];
const VERDICTS = ["corroborated", "unconvinced", "needs-evidence"] as const;

const SYSTEM = `You are the Navigator, a read-only co-pilot for AUTHORIZED security testing. Another agent — the driver — is exploring a target and mapping what it touches. You sit in the second seat: you read the live map, you do not act on the target.

Your job each cycle:
1. Point at the promising areas. For map nodes worth the driver's attention, emit a lead with a 0–1 confidence (your estimate the area hides a real, in-scope bug), a recommendation (pursue / watch / skip), a short suspected bug class (e.g. idor, authz, injection, ssrf, secrets, auth-bypass), and a one-line rationale. Favour reachable, unauthenticated, or auth/identity-bearing surfaces and places the driver has not yet explored. Nodes "seen in proxy traffic" were observed on the wire but never tested by the driver — strong candidates when they look sensitive. Nodes "found in command output" were reported by a scanner or script, or mentioned in a response, and not yet examined directly — good leads, held a little more loosely. Targets the operator marked "skipped" are theirs to skip; targets marked "tested" need a reason to revisit. It is fine — useful — to say skip.
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

/** A lead or a finding verdict, ready for the hub's validator channel. */
export type NavigatorEvent =
  | { type: "assessment.upsert"; assessment: Assessment; sessionId: string }
  | { type: "finding.assessment"; findingId: string; assessment: FindingAssessment; sessionId: string };

export interface NavigatorStatus {
  /** off: not running · idle: waiting for changes · assessing: a model call is in flight · error: stopped by a fatal error. */
  state: "off" | "idle" | "assessing" | "error";
  model: string;
  /** Completed assessments since start. */
  runs: number;
  lastRun?: number;
  /** Leads and verdicts posted by the last assessment. */
  lastPosted?: number;
  lastError?: string;
}

export interface NavigatorOptions {
  getState: () => GraphState;
  post: (events: NavigatorEvent[]) => void | Promise<void>;
  /** Falls back to the SDK's own credential resolution (ANTHROPIC_API_KEY, …). */
  apiKey?: string;
  model?: string;
  /** Quiet period after a change before assessing. */
  idleMs?: number;
  log?: (msg: string) => void;
}

export class Navigator {
  private client: Anthropic;
  private model: string;
  private idleMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  private lastAttempt = 0;
  private info: NavigatorStatus;

  constructor(private opts: NavigatorOptions) {
    this.client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
    this.model = opts.model || DEFAULT_MODEL;
    this.idleMs = opts.idleMs ?? 2500;
    this.info = { state: "idle", model: this.model, runs: 0 };
  }

  status(): NavigatorStatus {
    return { ...this.info };
  }

  /** The map changed: assess once it has been quiet for a moment. */
  notify() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), this.idleMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.info = { ...this.info, state: "off" };
  }

  /** One tiny request to check the key and model work. */
  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.messages.create({ model: this.model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  private async tick() {
    if (this.stopped) return;
    if (this.running) return this.notify();
    const since = Date.now() - this.lastAttempt;
    if (since < MIN_GAP_MS) {
      this.timer = setTimeout(() => void this.tick(), MIN_GAP_MS - since);
      return;
    }
    this.running = true;
    this.info = { ...this.info, state: "assessing" };
    try {
      const posted = await this.assess();
      if (posted !== undefined) this.info = { ...this.info, runs: this.info.runs + 1, lastRun: Date.now(), lastPosted: posted, lastError: undefined };
      if (!this.stopped) this.info = { ...this.info, state: "idle" };
    } catch (err) {
      const fatal = noCredentials(err) || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError;
      this.info = { ...this.info, state: fatal ? "error" : "idle", lastError: describeError(err) };
      this.opts.log?.(`model call failed: ${this.info.lastError}`);
      // A rejected key or unknown model won't fix itself; wait for new settings.
      if (fatal) this.stopped = true;
    } finally {
      this.running = false;
      this.lastAttempt = Date.now();
    }
  }

  /** Returns how many leads and verdicts were posted, or undefined if there was nothing to assess. */
  private async assess(): Promise<number | undefined> {
    const state = this.opts.getState();
    if (!Object.keys(state.nodes).length) return undefined;
    const sessionId = state.sessionId ?? "validator";

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: digest(state) }],
    });

    const stop: string = res.stop_reason ?? "";
    if (stop === "refusal") {
      this.opts.log?.("model declined to assess this state; skipping cycle.");
      return 0;
    }
    const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!call) return 0;
    const input = call.input as { leads?: unknown[]; findingVerdicts?: unknown[] };

    const now = Date.now();
    const events: NavigatorEvent[] = [];
    for (const raw of Array.isArray(input.leads) ? input.leads : []) {
      const l = raw as Record<string, unknown>;
      const nodeId = typeof l.nodeId === "string" ? l.nodeId : undefined;
      const node = nodeId ? state.nodes[nodeId] : undefined;
      // Guardrail: never advise on nodes outside the authorized scope.
      if (!nodeId || !node || node.outOfScope) continue;
      events.push({
        type: "assessment.upsert",
        sessionId,
        assessment: {
          id: `nav:${nodeId}`,
          nodeId,
          title: String(l.title ?? node.label),
          rationale: typeof l.rationale === "string" ? l.rationale : undefined,
          bugClass: typeof l.bugClass === "string" ? l.bugClass : undefined,
          confidence: clamp(l.confidence),
          recommendation: RECS.includes(l.recommendation as Recommendation) ? (l.recommendation as Recommendation) : "watch",
          ts: now,
        },
      });
    }
    for (const raw of Array.isArray(input.findingVerdicts) ? input.findingVerdicts : []) {
      const v = raw as Record<string, unknown>;
      const findingId = typeof v.findingId === "string" ? v.findingId : undefined;
      if (!findingId || !state.findings[findingId]) continue;
      if (!VERDICTS.includes(v.verdict as (typeof VERDICTS)[number])) continue;
      events.push({
        type: "finding.assessment",
        sessionId,
        findingId,
        assessment: {
          verdict: v.verdict as FindingAssessment["verdict"],
          confidence: clamp(v.confidence),
          rationale: typeof v.rationale === "string" ? v.rationale : undefined,
          ts: now,
        },
      });
    }
    if (events.length) await this.opts.post(events);
    this.opts.log?.(`posted ${events.length} assessment(s) for session ${sessionId}`);
    return events.length;
  }
}

/** A compact, model-readable snapshot of what the operator currently sees. */
function digest(s: GraphState): string {
  const lines: string[] = [];
  if (s.scope) lines.push(`Scope (${s.scope.origin}): paths=${s.scope.paths.join(", ") || "—"}; hosts=${s.scope.hosts.join(", ")}`);
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
    const traffic =
      seenIn === "command output"
        ? `found in command output, not requested directly${n.meta?.["status codes"] ? `, status ${n.meta["status codes"]}` : ""}`
        : seenIn && `seen in ${seenIn}, ${n.meta?.requests} req${n.meta?.["status codes"] ? `, status ${n.meta["status codes"]}` : ""}`;
    const triage = s.triage?.[n.id];
    const tags = [n.kind, n.status, n.category && `in:${n.category}`, traffic, triage && `operator marked: ${triage.state}`, n.outOfScope && "[OUT OF SCOPE]"]
      .filter(Boolean)
      .join(" ");
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

  const statuses = all.reduce((a, n) => ((a[n.status] = (a[n.status] ?? 0) + 1), a), {} as Record<string, number>);
  lines.push(`Coverage: ${statuses.unexplored ?? 0} unexplored, ${statuses.active ?? 0} active, ${statuses.complete ?? 0} complete.`);
  lines.push("Assess the current map. Call submit_navigation once.");
  return lines.join("\n");
}

function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/** The SDK throws a plain Error, before any request, when it has no key to send. */
function noCredentials(err: unknown): boolean {
  return err instanceof Error && !(err instanceof Anthropic.APIError) && /authentication method|apiKey|api key/i.test(err.message);
}

function describeError(err: unknown): string {
  if (noCredentials(err)) return "No API key is set.";
  if (err instanceof Anthropic.AuthenticationError) return "The API key was rejected.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This key isn't allowed to use that model.";
  if (err instanceof Anthropic.NotFoundError) return "That model wasn't found.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited; it will try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}`.trim();
  return err instanceof Error ? err.message : String(err);
}
