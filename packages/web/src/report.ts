import { isUnsettled, SEVERITY_RANK, TRIAGE_LABEL, type AuditVerification, type GraphState, type Severity } from "@spectra/schema";
import { STATUS_LABEL } from "./components/Status.tsx";
import { indexSurface } from "./filters.ts";
import { formatTool } from "./format.ts";
import { fetchVerification } from "./components/AuditStatus.tsx";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Markdown summary of a session for the operator's records. */
export function buildReport(state: GraphState, audit?: AuditVerification): string {
  const findings = Object.values(state.findings).sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  const files = Object.entries(state.files);
  const edited = files.filter(([, t]) => t.writes).map(([p]) => p).sort();
  const { counts, scope, violations } = state;
  const time = (ts?: number) => (ts ? new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
  const verdict = (v?: string) => (v ? v.replace("-", " ") : "unreviewed");

  const out: string[] = [];
  out.push(`# Spectra session report`, "");
  out.push(`| | |`, `|---|---|`);
  out.push(`| Session | \`${state.sessionId ?? "—"}\` |`);
  out.push(`| Activity | ${time(counts.firstTs)} → ${time(counts.lastTs)} |`);
  out.push(`| Generated | ${time(Date.now())} |`);
  out.push(`| Tool calls | ${counts.toolCalls} (${counts.failed} failed) |`);
  out.push(`| Files opened | ${files.length} (${edited.length} edited) |`, "");

  out.push(`## Scope`, "");
  if (scope) {
    out.push(`Set by: ${scope.origin === "config" ? "operator config" : "session working directory"}`, "");
    out.push(`- Paths: ${scope.paths.map((p) => `\`${p}\``).join(", ") || "none"}`);
    out.push(`- Hosts: ${scope.hosts.map((h) => `\`${h}\``).join(", ")}`, "");
  } else {
    out.push("No scope was set.", "");
  }

  out.push(`## Summary`, "");
  out.push(`| Severity | Findings | Verified | Rejected | Unreviewed |`, `|---|---|---|---|---|`);
  for (const sev of SEVERITIES) {
    const fs = findings.filter((f) => f.severity === sev);
    if (!fs.length) continue;
    const by = (v?: string) => fs.filter((f) => f.review?.verdict === v).length;
    out.push(`| ${sev} | ${fs.length} | ${by("verified")} | ${by("rejected")} | ${fs.filter((f) => !f.review).length} |`);
  }
  if (!findings.length) out.push(`| — | 0 | | | |`);
  out.push("", `Scope violations: ${violations.length} (${violations.filter((v) => v.severity === "high").length} high).`, "");

  // Reconciliation: every action is recorded; say which ones Spectra couldn't read, and how each was settled.
  const unread = Object.values(state.actions ?? {});
  const open = unread.filter(isUnsettled);
  out.push(
    `Actions: ${state.counts.toolCalls} recorded, ${unread.length} Spectra couldn't read on its own` +
      (unread.length ? ` (${unread.filter((a) => a.resolution === "interpreted" || a.resolution === "nothing").length} read by the Interpreter, ${unread.filter((a) => a.resolution === "dismissed").length} dismissed, ${open.length} still not read).` : "."),
    "",
  );
  if (open.length) {
    out.push("Not read — what these touched isn't on the map:", "");
    for (const a of open.slice(0, 40)) out.push(`- \`${oneLine(a.summary)}\` (${a.reason})`);
    if (open.length > 40) out.push(`- …and ${open.length - 40} more`);
    out.push("");
  }

  out.push(...surfaceSection(state));

  out.push(`## Findings`, "");
  if (!findings.length) out.push("No findings were reported.", "");
  for (const f of findings) {
    out.push(`### ${f.id}: ${f.title}`, "");
    out.push(`- Severity: **${f.severity}**, agent confidence ${Math.round((f.confidence ?? 0) * 100)}%`);
    out.push(`- Agent status: ${f.status}${f.reportedBy === "mcp" ? " (agent-reported)" : ""}`);
    if (f.assessment) out.push(`- Navigator: ${verdict(f.assessment.verdict)}, ${Math.round(f.assessment.confidence * 100)}%${f.assessment.rationale ? `: ${oneLine(f.assessment.rationale)}` : ""}`);
    out.push(`- Review: **${verdict(f.review?.verdict)}**${f.review?.note ? `: ${oneLine(f.review.note)}` : ""}`);
    if (f.location) out.push(`- Location: \`${f.location.file}${f.location.line ? `:${f.location.line}` : ""}\``);
    out.push("");
    if (f.description) out.push(f.description, "");
    const steps = (f.stepIds ?? []).map((id) => state.chain[id]).filter(Boolean);
    if (steps.length) {
      out.push("Evidence trail:", "");
      steps.forEach((s, i) => out.push(`${i + 1}. ${s.title}${s.confirmed ? " (confirmed)" : ""}`));
      out.push("");
    }
    out.push(f.edits?.length ? `Remediation: ${f.edits.length} edit(s) to the affected file, last ${time(f.edits.at(-1)!.ts)}.` : "Remediation: no edits recorded.", "");
  }

  out.push(`## Scope violations`, "");
  if (!violations.length) {
    out.push("None recorded.", "");
  } else {
    out.push(`| Time | Severity | Access | Target | Tool |`, `|---|---|---|---|---|`);
    for (const v of violations) {
      out.push(`| ${time(v.ts)} | ${v.severity} | ${v.target.access} | \`${cell(v.target.value)}\`${v.target.heuristic ? " (from shell)" : ""} | ${cell(formatTool(v.tool))} |`);
    }
    out.push("");
  }

  out.push(`## Files edited`, "");
  out.push(edited.length ? edited.map((p) => `- \`${p}\``).join("\n") : "None.", "");

  out.push(`## Audit log`, "");
  if (audit?.ok && audit.head) {
    out.push(`The session's hash-chained log verified intact at report time: ${audit.events} events, head hash:`, "");
    out.push("```", audit.head, "```", "");
    out.push(`Keep this hash with the report. To confirm later that the log hasn't been rewritten: \`npm run verify -- ${state.sessionId} ${audit.head}\``, "");
  } else if (audit && !audit.ok) {
    out.push(`**Verification failed** at line ${audit.badLine ?? "?"}: ${audit.reason}.`, "");
  } else {
    out.push("Not verified (audit log unavailable).", "");
  }

  out.push("---", "", "_Findings marked agent-reported are the agent's own claims. Review verdicts and triage marks are the operator's. Navigator entries are a second model's advice. Tags are name-based heuristics, not findings. Shell-derived targets are pattern-matched and may be incomplete. Targets with the source \"output (inferred)\" were read out of a command's output, by a URL scan or a second model, and weren't seen in a request._", "");
  return out.join("\n");
}

/** The mapped surface, host by host, with tags, the Navigator's lead and the operator's triage — the handoff to the next phase. */
function surfaceSection(state: GraphState): string[] {
  const index = indexSurface(state);
  const nodes = Object.values(state.nodes);
  const hosts = nodes.filter((n) => n.category === "hosts" && (n.id.startsWith("domain:") || n.id.startsWith("host:")));
  const out: string[] = [`## Attack surface`, ""];
  if (!index.counts.endpoints && !hosts.length) return [...out, "No hosts or endpoints were mapped.", ""];

  const marks = Object.values(state.triage);
  const count = (s: string) => marks.filter((m) => m.state === s).length;
  out.push(`${index.counts.hosts} hosts, ${index.counts.endpoints} endpoints, ${index.counts.params} parameters.`);
  if (marks.length) out.push(`Triage: ${count("queued")} to test, ${count("testing")} testing, ${count("tested")} tested, ${count("skipped")} skipped.`);
  out.push("");

  const source = (seen: unknown) => (seen === "proxy traffic" ? "proxy" : seen === "agent and proxy traffic" ? "agent + proxy" : seen === "command output" ? "output (inferred)" : "agent");
  for (const h of hosts) {
    const endpoints = nodes.filter((n) => n.category === "endpoints" && n.parentId === h.id);
    if (!endpoints.length && !state.triage[h.id]) continue;
    const tags = index.tags.get(h.id) ?? [];
    out.push(`### ${h.label}${h.outOfScope ? " (out of scope)" : ""}${tags.length ? ` — ${tags.join(", ")}` : ""}`, "");
    if (state.triage[h.id]) out.push(`Triage: ${TRIAGE_LABEL[state.triage[h.id].state]}${state.triage[h.id].note ? `: ${oneLine(state.triage[h.id].note!)}` : ""}`, "");
    if (!endpoints.length) continue;
    out.push(`| Endpoint | Tags | Status | Seen by | Parameters | Navigator | Triage |`, `|---|---|---|---|---|---|---|`);
    for (const e of endpoints) {
      const params = nodes.filter((n) => n.category === "params" && n.parentId === e.id).map((n) => n.label);
      const lead = index.leads.get(e.id);
      const mark = state.triage[e.id];
      out.push(
        `| \`${cell(e.label)}\` | ${(index.tags.get(e.id) ?? []).join(", ")} | ${STATUS_LABEL[e.status]} | ${source(e.meta?.["seen in"])} | ${cell(params.join(", "))} | ` +
          `${lead ? `${lead.recommendation} ${Math.round(lead.confidence * 100)}%${lead.bugClass ? ` (${cell(lead.bugClass)})` : ""}` : ""} | ` +
          `${mark ? `${TRIAGE_LABEL[mark.state]}${mark.note ? `: ${cell(oneLine(mark.note))}` : ""}` : ""} |`,
      );
    }
    out.push("");
  }
  return out;
}

export async function downloadReport(state: GraphState) {
  const audit = state.sessionId ? await fetchVerification(state.sessionId) : undefined;
  const blob = new Blob([buildReport(state, audit)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spectra-report-${(state.sessionId ?? "session").slice(0, 24)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const cell = (s: string) => s.replace(/\|/g, "\\|");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
