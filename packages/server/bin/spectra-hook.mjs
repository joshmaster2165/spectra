#!/usr/bin/env node
/**
 * Claude Code hook → Spectra hub. Strictly observational:
 *   - never prints to stdout (hook output can steer Claude Code)
 *   - always exits 0, whatever happens (non-zero can block a tool call)
 *   - gives up on the hub after 300 ms so the agent is never slowed down
 *
 * Registered for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * SessionEnd by bin/install-hooks.mjs.
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";

/** File contents and patches are large and not needed to draw the map. */
const DROP_INPUT_KEYS = ["content", "new_string", "old_string", "edits", "new_source"];

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const p = JSON.parse(raw);

  const input = { ...(p.tool_input ?? {}) };
  for (const k of DROP_INPUT_KEYS) delete input[k];

  const r = p.tool_response;
  const ok = !(r && typeof r === "object" && (r.is_error || r.error || r.interrupted));

  const payload = {
    hook_event_name: p.hook_event_name,
    session_id: p.session_id,
    cwd: p.cwd,
    tool_name: p.tool_name,
    tool_use_id: p.tool_use_id,
    tool_input: p.tool_name ? input : undefined,
    prompt: p.prompt,
    reason: p.reason,
    ok,
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
