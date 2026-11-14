// A real Claude Code session, replayed. fixtures/recorded-session.json holds the tool calls one
// session made while inventorying the lab app, in order. Each is sent through the real hook:
// commands that ran are run again against the lab, and calls Claude Code denied are replayed the
// way it reports them (a permission request, then the batch, and never a result).
// Then the map is checked against what the lab received, and the hub is restarted.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { startLab, type Lab } from "./lab/app.ts";
import { copyLabProject, FIXTURE_PORT, freePort, HERE, missingPrograms, nodeIdOf, onMap, run, sleep, startHub, tempDir, truthOf, type LabProject, type TestHub, type Truth } from "./helpers.ts";

interface Call {
  tool: string;
  input: Record<string, any>;
  /** The denial Claude Code reported, when the call never ran. */
  denied?: string;
}

const missing = await missingPrograms(["zsh", "curl", "jq", "python3"]);
if (missing.length && process.env.CI) throw new Error(`the replay test needs ${missing.join(", ")} installed`);

describe("a recorded Claude Code session, replayed", { skip: missing.length ? `needs ${missing.join(", ")} installed` : false }, () => {
  let lab: Lab;
  let hub: TestHub;
  let proj: LabProject;
  let hubDir = "";
  let state: any;
  let truth: Truth;
  const SID = "recorded-session";

  before(async () => {
    const port = await freePort();
    lab = await startLab(port);
    proj = copyLabProject(port);
    hubDir = tempDir("replay-hub");
    hub = await startHub({ dir: hubDir, scope: { paths: [proj.dir], hosts: ["lab.localhost"] } });

    const text = fs.readFileSync(path.join(HERE, "fixtures", "recorded-session.json"), "utf8").split("{{PROJECT}}").join(proj.dir).split(FIXTURE_PORT).join(String(port));
    const calls: Call[] = JSON.parse(text).calls;
    const hook = (payload: object) => hub.hook({ session_id: SID, cwd: proj.dir, ...payload });

    await hook({ hook_event_name: "SessionStart" });
    let i = 0;
    for (const c of calls) {
      const call = { tool_name: c.tool, tool_use_id: `r${++i}`, tool_input: c.input };
      await hook({ hook_event_name: "PreToolUse", ...call });
      if (c.denied) {
        await hook({ hook_event_name: "PermissionRequest", tool_name: c.tool, tool_input: c.input });
        await hook({ hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: c.denied }] });
        continue;
      }
      if (c.tool === "Bash") {
        const r = await run("zsh", ["-c", c.input.command], { cwd: proj.dir, env: { PATH: proj.path } });
        if (r.code === 0) await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false } });
        else await hook({ hook_event_name: "PostToolUseFailure", ...call, error: `Exit code ${r.code}\n${r.stdout}${r.stderr}`, is_interrupt: false });
        await hook({ hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: r.stdout.slice(0, 200) }] });
      } else {
        if (c.tool === "Write") fs.writeFileSync(c.input.file_path, c.input.content);
        await hook({ hook_event_name: "PostToolUse", ...call, tool_response: c.tool === "Write" ? { filePath: c.input.file_path, type: "create" } : "" });
        await hook({ hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: "" }] });
      }
    }
    await hook({ hook_event_name: "SessionEnd", reason: "other" });
    await sleep(300);
    state = await hub.state();
    truth = truthOf(lab.requests);
  });
  after(async () => {
    await hub?.stop();
    await lab?.stop();
  });

  it("the session really exercised the lab", () => {
    // If the fixture or the lab drift apart, the checks below would pass on nothing.
    assert.ok(truth.live.size >= 40, `only ${truth.live.size} routes answered`);
    assert.ok(truth.dead.size >= 60, `only ${truth.dead.size} probes found nothing`);
    assert.ok(truth.params.size >= 8, `only ${truth.params.size} parameters were sent`);
  });

  it("every route that answered is on the map", () => {
    assert.deepEqual([...truth.live].filter((k) => !onMap(state, k)), []);
  });

  it("every parameter sent to a route that answered is on the map", () => {
    assert.deepEqual([...truth.params].filter((p) => !state.nodes[p]), []);
  });

  it("probes that found nothing are kept off the map", () => {
    assert.deepEqual([...truth.dead].filter((k) => onMap(state, k)), []);
  });

  it("nothing is on the map that was neither requested nor read from output", () => {
    const touched = new Set([...truth.live, ...truth.dead].map(nodeIdOf));
    const hosts = new Set([...truth.live, ...truth.dead].map((k) => `host:${k.split("/")[0]}`));
    const phantom = Object.keys(state.nodes).filter((k) => /^(endpoint|host|param):/.test(k) && !touched.has(k) && !hosts.has(k) && !truth.params.has(k) && state.nodes[k].meta?.["seen in"] !== "command output");
    assert.deepEqual(phantom, []);
  });

  it("the denied calls are recorded as never run, and no call is left unread", async () => {
    const health = await hub.get("/health");
    assert.equal(health.actions.open, 0, JSON.stringify(health.actions));
    assert.equal(health.actions.total, 18);
    // No target is left marked as still being worked on once its call has finished.
    assert.deepEqual(Object.values(state.nodes).filter((n: any) => /^(endpoint|host|param):/.test(n.id) && n.status === "active").map((n: any) => n.id), []);
  });

  it("no scope violation is raised for a session that stayed in scope", () => {
    assert.deepEqual(state.violations, []);
  });

  it("the audit log verifies, and a restart restores the same map", async () => {
    assert.equal((await hub.get(`/verify?session=${SID}`)).ok, true);
    await hub.stop();
    hub = await startHub({ dir: hubDir });
    const restored = await hub.state();
    const sorted = (s: any) => ({ ...s, timeline: [...s.timeline].map((e: any) => JSON.stringify(e)).sort() });
    assert.deepEqual(sorted(restored), sorted(state));
    assert.equal((await hub.get(`/verify?session=${SID}`)).ok, true);
  });
});
