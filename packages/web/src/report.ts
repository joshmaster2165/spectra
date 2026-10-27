import { SEVERITY_RANK, type GraphState, type Severity } from "@spectra/schema";
import { formatTool } from "./format.ts";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Markdown summary of a session for the operator's records. */
export function buildReport(state: GraphState): string {
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

  out.push(`## Findings`, "");
  if (!findings.length) out.push("No findings were reported.", "");
  for (const f of findings) {
    out.push(`### ${f.id}: ${f.title}`, "");
    out.push(`- Severity: **${f.severity}**, agent confidence ${Math.round((f.confidence ?? 0) * 100)}%`);
    out.push(`- Agent status: ${f.status}${f.reportedBy === "mcp" ? " (agent-reported)" : ""}`);
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

  out.push("---", "", "_Findings marked agent-reported are the agent's own claims. Review verdicts are the operator's. Shell-derived targets are pattern-matched and may be incomplete._", "");
  return out.join("\n");
}

export function downloadReport(state: GraphState) {
  const blob = new Blob([buildReport(state)], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `spectra-report-${(state.sessionId ?? "session").slice(0, 24)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const cell = (s: string) => s.replace(/\|/g, "\\|");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
