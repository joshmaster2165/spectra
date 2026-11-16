// The fallback that reads Claude Code's own session logs when no hooks are installed. A subagent's
// records are in a file of their own beside the session's, and must reach the map as the subagent's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { subagentsOf, type SpectraEvent } from "@spectra/schema";
import { startObserver } from "../src/observer.ts";
import { sleep, tempDir } from "./helpers.ts";

const SESSION = "5f0c2d1e-0000-4000-8000-000000000001";
const CWD = "/work/target-repo";
const now = () => new Date().toISOString();
/** One line of a session log, in the shape Claude Code writes. */
const record = (extra: object, content: object[]) => JSON.stringify({ type: "assistant", sessionId: SESSION, cwd: CWD, timestamp: now(), message: { role: "assistant", content }, ...extra }) + "\n";
const bash = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });

test("session logs: the main agent's calls and a subagent's are both mapped, each as its own", async () => {
  const dir = tempDir("claude-projects");
  const project = path.join(dir, "-work-target-repo");
  const subagents = path.join(project, SESSION, "subagents");
  fs.mkdirSync(subagents, { recursive: true });

  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), record({}, [bash("t-main", "curl -s https://example-shop.test/api/cart")]));
  // The subagent's log: same session id, flagged as a side chain, with the subagent's id on every record.
  fs.writeFileSync(path.join(subagents, "agent-a1b2c3.jsonl"), record({ isSidechain: true, agentId: "a1b2c3" }, [bash("t-sub", "curl -s 'https://example-shop.test/api/orders?status=open'")]));
  fs.writeFileSync(path.join(subagents, "agent-a1b2c3.meta.json"), JSON.stringify({ agentType: "Explore", toolUseId: "t-spawn" }));
  // A subagent whose kind isn't recorded is still a subagent.
  fs.writeFileSync(path.join(subagents, "agent-d4e5f6.jsonl"), record({ isSidechain: true, agentId: "d4e5f6" }, [bash("t-anon", "curl -s https://example-shop.test/api/login")]));

  const events: SpectraEvent[] = [];
  const stop = startObserver({ dir, replay: true, pollMs: 50, emit: (e) => events.push(e) });
  try {
    for (let i = 0; i < 40 && events.filter((e) => e.type === "tool.call").length < 3; i++) await sleep(50);
  } finally {
    stop();
  }

  const calls = Object.fromEntries(events.flatMap((e) => (e.type === "tool.call" ? [[e.toolUseId, e]] : [])));
  assert.deepEqual(Object.keys(calls).sort(), ["t-anon", "t-main", "t-sub"]);
  assert.ok([...new Set(events.map((e) => e.sessionId))].every((s) => s === SESSION), "a subagent's calls belong to the session that started it");
  assert.equal((calls["t-main"] as any).agent, undefined);
  assert.deepEqual((calls["t-sub"] as any).agent, { id: "a1b2c3", type: "Explore" });
  assert.deepEqual((calls["t-anon"] as any).agent, { id: "d4e5f6" });

  const node = (id: string) => events.flatMap((e) => (e.type === "node.upsert" && e.node.id === id && e.node.kind ? [e.node] : [])).at(-1);
  assert.deepEqual(subagentsOf(node("endpoint:example-shop.test/api/cart")!), []);
  assert.deepEqual(subagentsOf(node("endpoint:example-shop.test/api/orders")!), ["Explore"]);
  assert.deepEqual(subagentsOf(node("param:example-shop.test/api/orders?status")!), ["Explore"]);
  assert.deepEqual(subagentsOf(node("endpoint:example-shop.test/api/login")!), ["subagent"]);
});
