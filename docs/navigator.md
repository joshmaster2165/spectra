# Navigator

The Navigator is an optional second model that sits in the "second seat". Claude Code — the driver — acts on the target; you, the operator, set the scope and decide; the Navigator only reads. It sees the same map you see, points at where the promise is with scored **leads** (pursue, watch or skip, a suspected bug class, a confidence and a rationale), and gives an independent **verdict** on each finding the driver reports. It never touches the target, can't set the scope or your verdicts, and is the only part of Spectra that sends data off your machine.

## What it is

<img src="media/navigator.webp" alt="The Navigator scoring the map: leads appear in the Navigator tab with their confidence, orange halos appear on the pursued targets in the graph, and verdicts appear on the findings" width="100%">

<sub>The Navigator scoring the recon demo's map: leads with confidence, halos on the graph, verdicts on findings.</sub>

The Navigator is a separate process (`packages/server/src/validator.ts`, started with `npm run validator`). It connects to the hub like a dashboard does, keeps its own copy of the state, and periodically asks a model to read it. Its output is advice, kept apart from everything else:

| Seat | Who | Does | Spectra labels it |
|---|---|---|---|
| Driver | Claude Code | Acts on the target | Ground truth (hooks, observer) or claims (MCP) |
| Navigator | A second model | Reads the map, scores leads, checks findings | Advice (`validator`) |
| Operator | You | Sets scope, reviews findings | Authority (`operator`) |

## How it works

1. **It reads hub state over the WebSocket.** It connects to `ws://127.0.0.1:4317/ws` (from `SPECTRA_HUB`), receives the same snapshot and event stream as the dashboard, and rebuilds the state with the same reducer. If the connection drops, it retries every 3 seconds.
2. **It waits for a quiet period.** Every incoming event restarts a timer. When no event has arrived for 2.5 seconds (`SPECTRA_VALIDATOR_IDLE_MS`), it assesses the map — but never more often than once every 15 seconds, and never while a previous assessment is still running. Its own posts don't restart the timer. An empty map isn't assessed.
3. **It sends a digest.** The model gets a compact text summary of the state, not the raw events:
   - the scope (paths and hosts) and who set it;
   - up to 200 targets — the attack surface (hosts, endpoints, parameters) first, newest first, then files, searches and commands — each with its id, label, kind, status, category, proxy-traffic details (*seen in*, request count, status codes), an `[OUT OF SCOPE]` tag where it applies, and the lead it gave that target last time;
   - every finding with its severity, status, who reported it, location, description, and the titles of its chain steps;
   - counts of unexplored, active and complete targets.
4. **It gets leads and verdicts back through a tool call.** The model is given one tool, `submit_navigation`, and asked to call it once with a list of leads and a list of finding verdicts.
5. **It checks them and posts them to the hub.** Leads for unknown or out-of-scope targets and verdicts for unknown findings are dropped, recommendations and verdicts outside the allowed values are corrected or dropped, and confidences are clamped to 0–1. The rest go to the hub's `POST /validator` endpoint, which stamps them with the source `validator`.

## Leads

A lead is the Navigator's scored read on one target.

| Field | Meaning |
|---|---|
| **Recommendation** | **pursue** — worth the driver's time now; **watch** — keep it in view; **skip** — not worth it. An unrecognized value becomes *watch*. |
| **Bug class** | A short suspected class, such as `idor`, `authz`, `injection`, `ssrf`, `secrets` or `auth-bypass`. |
| **Confidence** | 0–1: the Navigator's estimate that the area hides a real, in-scope bug. |
| **Rationale** | One or two lines on why. |
| **Title** | A short name for the lead. |

There is one lead per target: each new assessment of a target replaces the previous one. Leads aren't removed when the Navigator stops mentioning a target, so a lead can be older than the latest assessment.

The prompt asks it to favour reachable, unauthenticated, and authentication- or identity-bearing surfaces and places the driver hasn't explored yet — and says that *skip* is a useful answer.

## Finding verdicts

For each finding, the Navigator gives a verdict judged only from the evidence chain and the map:

| Verdict | Meaning |
|---|---|
| **Corroborated** | The evidence supports the finding. |
| **Unconvinced** | The evidence doesn't support it. |
| **Needs evidence** | It may be real, but the chain or probes to show it aren't there yet. |

Each verdict carries a 0–1 confidence and a rationale. A new verdict replaces the previous one. It's shown next to the driver's own status and your review, never merged with either.

## Traffic-only targets

Targets seen only in imported proxy history (*seen in proxy traffic*) crossed the wire but were never tested by the driver. The Navigator is told this and treats them as strong candidates when they look sensitive — an admin route the proxy saw succeed is a typical *pursue*. See [Proxy import](proxy-import.md).

## Guardrails

- **Never advises on out-of-scope targets.** The prompt forbids it, and independently of the model, any lead for a target marked out of scope is discarded before it reaches the hub.
- **Triage, not payloads.** It's instructed to give direction and prioritization only — no exploit payloads, step-by-step intrusion instructions or code — and its tool only has fields for leads and verdicts. If the model declines an assessment, that cycle is skipped.
- **Can't set scope or verdicts.** The hub accepts exactly two event types on `/validator` — leads and finding verdicts — and stamps them `validator`. Scope changes, operator reviews and everything else are ignored there. The agent's MCP channel, in turn, can't produce leads or verdicts.
- **Read-only toward the target.** It has no tools that act on anything; its only outputs are posts to your local hub.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | | Required. Read by the Anthropic SDK. |
| `SPECTRA_VALIDATOR_MODEL` | `claude-opus-5-5` | Model id. |
| `SPECTRA_VALIDATOR_IDLE_MS` | `2500` | Quiet period before an assessment, in milliseconds. |
| `SPECTRA_HUB` | `http://127.0.0.1:4317` | The hub to watch and post to. |

Fixed in the code: at most one assessment every 15 seconds, at most 200 targets in the digest, and at most 4,000 output tokens per assessment.

Start it once the hub is up:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run validator
```

Stop it with Ctrl-C. Its leads and verdicts stay on the map and in the audit log.

## Cost and egress

- **Egress.** This is the one Spectra process that connects outside your machine, to the Anthropic API. What it sends is the digest above, which includes target ids and labels — file paths, shell commands, hostnames and URL paths — the scope, and finding titles and descriptions. It doesn't send file contents. Leave it off for zero egress.
- **Cost.** One model call per assessment, at most one every 15 seconds while the map keeps changing, and none while it's idle. Input grows with the map up to the 200-target cap; output is capped at 4,000 tokens. A long, busy session means many calls — stop the Navigator when you don't need it.
- **Coverage limit.** The digest holds 200 targets. On a larger map the attack surface is kept, newest first, and files, searches and commands drop out first; on a very large surface the oldest hosts and endpoints go too.

## Reading its output

- **Oversight → Navigator** lists every lead, pursue first, then by confidence.
- **The graph** puts a pulsing orange halo on every target the Navigator says to pursue.
- **Surface** has a **Lead** column (and **Best lead** for hosts) you can sort by, and a **Leads only** filter.
- **Oversight → Findings** shows *Navigator: Corroborated 86%* (or the verdict it gave) on each finding it has assessed; hover for the rationale.
- Its terminal logs each post: `[navigator] posted 7 assessment(s) for session …`.

Treat a lead as a second opinion on where to look next, not as evidence. A *corroborated* verdict means the chain hangs together on paper; your review is still the one that counts.

---

**Next:** [Proxy import](proxy-import.md)
