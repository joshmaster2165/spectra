import type { SpectraEvent } from "@spectra/schema";

/**
 * Posts a scripted bug-hunting session to a running hub so the dashboard can
 * be built without a live agent. Covers map, chain, findings and one scope
 * violation (a request to a host that isn't in scope).
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const sessionId = `demo-${Date.now().toString(36)}`;
const CWD = "/work/acme-shop";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = Omit<SpectraEvent, "ts" | "sessionId" | "source">;
const node = (id: string, label: string, kind: "root" | "category" | "leaf", parentId?: string, status = "active") =>
  ({ type: "node.upsert", node: { id, label, kind, parentId, status, category: parentId?.split(":")[1] } }) as Step;
const done = (id: string) => ({ type: "node.upsert", node: { id, status: "complete" } }) as Step;
let n = 0;
const call = (tool: string, summary: string, nodeId: string, targets: any[]) =>
  ({ type: "tool.call", toolUseId: `${sessionId}-${++n}`, tool, summary, nodeId, targets }) as Step;

const script: Step[] = [
  { type: "session.start", title: "Demo: audit acme-shop", cwd: CWD } as Step,
  node("root", "acme-shop", "root"),
  { type: "thought", text: "Starting with the project layout to find entry points.", reason: "orient" } as Step,
  node("c:files", "files", "category", "root"),
  node("f:server.ts", "server.ts", "leaf", "c:files"),
  call("Read", "Read src/server.ts", "f:server.ts", [{ kind: "path", value: `${CWD}/src/server.ts`, access: "read" }]),
  done("f:server.ts"),
  node("c:routes", "routes", "category", "root"),
  node("r:/api/login", "/api/login", "leaf", "c:routes"),
  node("r:/api/cart", "/api/cart", "leaf", "c:routes", "unexplored"),
  node("r:/api/orders", "/api/orders", "leaf", "c:routes", "unexplored"),
  { type: "chain.step", step: { id: "s1", chainId: "main", title: "Found Express server", nodeIds: ["f:server.ts"] } } as Step,
  { type: "thought", text: "Login route reads a session cookie; switching to auth middleware.", reason: "follow data flow" } as Step,
  node("c:params", "params", "category", "root"),
  node("p:session", "session cookie", "leaf", "c:params"),
  { type: "edge.upsert", edge: { id: "e1", source: "r:/api/login", target: "p:session", label: "sets" } } as Step,
  done("r:/api/login"),
  { type: "chain.step", step: { id: "s2", chainId: "main", title: "Login issues session cookie", after: ["s1"], nodeIds: ["r:/api/login", "p:session"] } } as Step,
  { type: "thought", text: "Checking whether the live API behaves the same as the local build.", reason: "verify" } as Step,
  node("c:web", "web", "category", "root"),
  node("w:prod", "api.acme-shop.com", "leaf", "c:web"),
  call("WebFetch", "WebFetch https://api.acme-shop.com/api/cart", "w:prod", [{ kind: "host", value: "api.acme-shop.com", access: "network" }]),
  node("r:/api/cart", "/api/cart", "leaf", "c:routes"),
  { type: "edge.upsert", edge: { id: "e2", source: "r:/api/cart", target: "p:session", label: "reads" } } as Step,
  {
    type: "finding.upsert",
    finding: {
      id: "F-1",
      title: "Cart trusts unsigned user id from cookie",
      severity: "high",
      confidence: 0.55,
      status: "suspected",
      location: { file: "src/routes/cart.ts", line: 42 },
      description: "The cart handler reads `uid` from the session cookie without verifying its signature, so any user can read another user's cart. Fix: verify the cookie with the session secret before use.",
      nodeIds: ["r:/api/cart", "p:session"],
      stepIds: ["s1", "s2"],
    },
  } as Step,
  done("r:/api/cart"),
  done("p:session"),
  { type: "chain.step", step: { id: "s3", chainId: "main", title: "Cart trusts cookie for user id", after: ["s2"], nodeIds: ["r:/api/cart"], confirmed: true } } as Step,
  { type: "finding.upsert", finding: { id: "F-1", confidence: 0.9, status: "confirmed", stepIds: ["s1", "s2", "s3"] } } as Step,
  {
    type: "finding.upsert",
    finding: {
      id: "F-2",
      title: "Orders endpoint lacks rate limiting",
      severity: "low",
      confidence: 0.4,
      status: "suspected",
      location: { file: "src/routes/orders.ts" },
      nodeIds: ["r:/api/orders"],
    },
  } as Step,
  done("c:routes"),
  done("c:params"),
  done("c:files"),
];

for (const step of script) {
  await fetch(`${HUB}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...step, sessionId, source: "demo" }),
  });
  await sleep(500);
}
console.log(`[spectra] demo complete (session ${sessionId})`);
