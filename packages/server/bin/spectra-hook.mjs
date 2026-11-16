#!/usr/bin/env node
/**
 * Claude Code hook → Spectra hub. Strictly observational:
 *   - never prints to stdout (hook output can steer Claude Code)
 *   - always exits 0, whatever happens (non-zero can block a tool call)
 *   - gives up on the hub after 300 ms so the agent is never slowed down
 *
 * Registered for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, PostToolBatch and SessionEnd by bin/install-hooks.mjs.
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";

/** File contents and patches are large and not needed to draw the map. */
const DROP_INPUT_KEYS = ["content", "new_string", "old_string", "edits", "new_source"];
const FILE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
/** Longest single input field forwarded for any other tool. */
const INPUT_FIELD_CAP = 20000;

/**
 * Output is forwarded for the tools whose results are discoveries — shell
 * commands, fetches and other MCP tools — never for file tools, whose "output"
 * is file contents. Capped; SPECTRA_HOOK_OUTPUT=0 turns it off.
 */
const OUTPUT_TOOLS = /^(Bash|BashOutput|TaskOutput|WebFetch)$|^mcp__(?!spectra)/;
const OUTPUT_HEAD = 60000;
const OUTPUT_TAIL = 20000;

/** Claude Code writes a background command's output to a task file and reads it back later. */
const TASK_OUTPUT = /\/tasks\/[\w-]+\.output$/;

function outputOf(p) {
  if (process.env.SPECTRA_HOOK_OUTPUT === "0") return;
  const r = p.tool_response;
  const taskRead = p.tool_name === "Read" && TASK_OUTPUT.test(String(p.tool_input?.file_path ?? ""));
  if (!taskRead && !OUTPUT_TOOLS.test(p.tool_name ?? "")) return;
  let text;
  if (taskRead) text = typeof r?.file?.content === "string" ? r.file.content : typeof r === "string" ? r : undefined;
  else if (typeof r === "string") text = r;
  else if (Array.isArray(r)) text = r.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  else if (r && typeof r === "object") {
    if (typeof r.stdout === "string" || typeof r.stderr === "string") text = [r.stdout, r.stderr].filter(Boolean).join("\n");
    else if (typeof r.result === "string") text = r.result;
    else if (Array.isArray(r.content)) text = r.content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
    else text = JSON.stringify(r);
  }
  if (!text && typeof p.error === "string") text = p.error;
  if (!text) return;
  if (text.length <= OUTPUT_HEAD + OUTPUT_TAIL) return text;
  return `${text.slice(0, OUTPUT_HEAD)}\n…[${text.length - OUTPUT_HEAD - OUTPUT_TAIL} characters left out]…\n${text.slice(-OUTPUT_TAIL)}`;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const p = JSON.parse(raw);

  const input = { ...(p.tool_input ?? {}) };
  // Only Claude Code's own file tools carry file contents; another tool's "content" may be the request it sends.
  if (FILE_TOOLS.test(p.tool_name ?? "")) for (const k of DROP_INPUT_KEYS) delete input[k];
  else for (const k of Object.keys(input)) if (typeof input[k] === "string" && input[k].length > INPUT_FIELD_CAP) input[k] = input[k].slice(0, INPUT_FIELD_CAP);

  const r = p.tool_response;
  const ok = !(r && typeof r === "object" && (r.is_error || r.error || r.interrupted));

  const payload = {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    cwd: p.cwd,
    tool_name: p.tool_name,
    tool_use_id: p.tool_use_id,
    // Set by Claude Code on a subagent's tool calls; the main agent's calls carry neither.
    agent_id: typeof p.agent_id === "string" ? p.agent_id.slice(0, 80) : undefined,
    agent_type: typeof p.agent_type === "string" ? p.agent_type.slice(0, 80) : undefined,
    tool_input: p.tool_name ? input : undefined,
    prompt: p.prompt,
    reason: p.reason,
    ok,
    output: p.hook_event_name === "PostToolUse" || p.hook_event_name === "PostToolUseFailure" ? outputOf(p) : undefined,
    // A background command's task id, so output read from it later can be credited to this call.
    task: typeof r?.backgroundTaskId === "string" ? r.backgroundTaskId : undefined,
    // The calls of a finished batch: one that has no result by now was denied before it ran.
    batch:
      p.hook_event_name === "PostToolBatch" && Array.isArray(p.tool_calls)
        ? p.tool_calls.map((c) => ({ id: c?.tool_use_id, note: (typeof c?.tool_response === "string" ? c.tool_response : JSON.stringify(c?.tool_response ?? "")).slice(0, 200) }))
        : undefined,
  };

  await fetch(`${HUB}/hooks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
