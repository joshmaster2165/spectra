// An engagement survives the hub: a clean restart, a hard kill, a new engagement, and
// SPECTRA_RESUME=0. The map is built by the recon demo plus a hook session, a scope change and
// two triage marks, so every kind of event is in the logs being restored.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { run, SERVER_DIR, sleep, startHub, tempDir, type TestHub } from "./helpers.ts";

/** A state with its timeline as a set: sessions' events are merged by time on restore, so ties may reorder. */
const comparable = (s: any) => ({ ...s, timeline: s.timeline.map((e: any) => JSON.stringify(e)).sort() });

describe("an engagement across restarts", () => {
  let hub: TestHub;
  let dir = "";
  let state: any;
  const SID = "hk1";
  const hook = (payload: object) => hub.post("/hooks", { session_id: SID, cwd: "/tmp/proj-a", ...payload });
  const bash = (id: string, command: string) => ({ tool_name: "Bash", tool_use_id: id, tool_input: { command } });

  async function verifyAll() {
    const sessions = fs.readdirSync(hub.dataDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.basename(f, ".jsonl"));
    assert.ok(sessions.length >= 2, `expected the demo's log and the hook session's, found ${sessions.join(", ")}`);
    for (const id of sessions) {
      const v = await hub.get(`/verify?session=${encodeURIComponent(id)}`);
      assert.equal(v.ok, true, `audit log of ${id}: ${v.reason ?? ""}`);
    }
  }

  before(async () => {
    dir = tempDir("persist-hub");
    hub = await startHub({ dir });
    const demo = await run(process.execPath, ["--import", "tsx", path.join(SERVER_DIR, "src", "demo-recon.ts")], { cwd: SERVER_DIR, env: { SPECTRA_HUB: hub.url, SPECTRA_DEMO_PACE: "0.01" }, timeout: 120_000 });
    assert.equal(demo.code, 0, demo.stderr);
    await hook({ hook_event_name: "SessionStart" });
    await hook({ hook_event_name: "PreToolUse", ...bash("tu1", "curl https://example-shop.test/api/orders/42") });
    await hook({ hook_event_name: "PostToolUse", ...bash("tu1", "curl https://example-shop.test/api/orders/42"), ok: true, output: "ok" });
    await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu2", tool_input: { file_path: "/etc/hosts" } });
    await hub.post("/scope", { hosts: ["example-shop.test", "partner.example.test"] });
    // Triage one target the demo mapped and one the hook session reached.
    const fromDemo = Object.keys((await hub.state()).nodes).find((k) => k.startsWith("endpoint:") && !k.startsWith("endpoint:example-shop.test/"));
    assert.ok(fromDemo, "the demo mapped no endpoint");
    assert.ok((await hub.post("/triage", { nodeId: fromDemo, state: "queued", note: "try as low-priv user" })).ok);
    assert.ok((await hub.post("/triage", { nodeId: "endpoint:example-shop.test/api/orders/:id", state: "testing" })).ok);
    await sleep(500);
    state = await hub.state();
  });
  after(() => hub?.stop());

  it("the demo and the hook session built a real map", () => {
    assert.ok(Object.keys(state.nodes).length > 80, `${Object.keys(state.nodes).length} targets`);
    assert.ok(state.violations.length >= 1 && Object.keys(state.findings).length >= 1 && Object.keys(state.assessments).length >= 1);
    assert.equal(Object.keys(state.triage).length, 2);
  });

  it("a clean restart restores the same map, and every audit log verifies", async () => {
    await hub.stop();
    hub = await startHub({ dir });
    assert.match(hub.log(), /restored the engagement/);
    assert.deepEqual(comparable(await hub.state()), comparable(state));
    await verifyAll();
  });

  it("a session carries on after the restart, without double-counting a repeated call", async () => {
    const calls = state.counts.toolCalls;
    await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tu2", tool_input: { file_path: "/etc/hosts" }, ok: true, output: "x" });
    await hook({ hook_event_name: "PreToolUse", ...bash("tu1", "dup") });
    await hook({ hook_event_name: "PreToolUse", ...bash("tu3", "curl https://example-shop.test/api/cart") });
    await sleep(500);
    state = await hub.state();
    assert.equal(state.counts.toolCalls, calls + 1);
    assert.ok(state.nodes["endpoint:example-shop.test/api/cart"]);
  });

  it("a hard kill loses nothing", async () => {
    await hub.stop("SIGKILL");
    hub = await startHub({ dir });
    assert.deepEqual(comparable(await hub.state()), comparable(state));
    await verifyAll();
  });

  it("a new engagement starts from an empty map and keeps the old sessions replayable", async () => {
    assert.ok((await hub.post("/engagement/new", {})).ok);
    const empty = await hub.state();
    assert.deepEqual([Object.keys(empty.nodes).length, Object.keys(empty.findings).length, empty.violations.length, empty.counts.toolCalls], [0, 0, 0, 0]);
    // The session that was running keeps going, on the new map.
    await hub.post("/scope", { hosts: ["newtarget.test"] });
    await hook({ hook_event_name: "PreToolUse", ...bash("tu4", "curl https://newtarget.test/api/login") });
    await sleep(500);
    const fresh = await hub.state();
    assert.ok(fresh.nodes["endpoint:newtarget.test/api/login"]);
    assert.ok(!fresh.nodes["endpoint:example-shop.test/api/cart"]);

    await hub.stop();
    hub = await startHub({ dir });
    assert.deepEqual(comparable(await hub.state()), comparable(fresh));
    await verifyAll();
    const sessions: any[] = await hub.get("/sessions");
    assert.ok(sessions.some((s) => s.id === SID) && sessions.length >= 2, JSON.stringify(sessions.map((s) => s.id)));
  });

  it("SPECTRA_RESUME=0 starts empty", async () => {
    await hub.stop();
    hub = await startHub({ dir, env: { SPECTRA_RESUME: "0" } });
    const s = await hub.state();
    assert.equal(Object.keys(s.nodes).length, 0);
    assert.equal((await hub.get("/health")).engagement.restored, null);
  });
});
