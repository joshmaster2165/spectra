import fs from "node:fs";
import { parseHar, type SpectraEvent } from "@spectra/schema";

/**
 * Posts a scripted bug-hunting session to a running hub so the dashboard can
 * be explored without a live agent. Node ids follow the same conventions the
 * hub uses for live traffic (domain:, host:, endpoint:), so the attack surface
 * renders exactly as it would in a real session.
 *
 * Story: the operator authorizes acme-shop.test. The agent maps its API, finds
 * an IDOR in the cart, fixes it, and strays once to production (acme-shop.com),
 * which is flagged as a scope violation. The operator's proxy history is then
 * imported (examples/acme-shop.har), revealing surface the agent never touched,
 * and the Navigator scores it all.
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const sessionId = `demo-${Date.now().toString(36)}`;
const CWD = "/work/acme-shop";
const API = "api.acme-shop.test";
const R = `root:${sessionId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = Omit<SpectraEvent, "ts" | "sessionId" | "source">;
type Kind = "root" | "category" | "leaf";
const node = (id: string, label: string, kind: Kind, parentId: string | undefined, category?: string, status = "active") =>
  ({ type: "node.upsert", node: { id, label, kind, parentId, category, status } }) as Step;
const done = (id: string) => ({ type: "node.upsert", node: { id, status: "complete" } }) as Step;
const think = (text: string, reason: string) => ({ type: "thought", text, reason }) as Step;
const link = (source: string, target: string, label: string) =>
  ({ type: "edge.upsert", edge: { id: `${source}=>${target}`, source, target, label } }) as Step;
let n = 0;
const call = (tool: string, summary: string, nodeId: string, targets: any[]) =>
  ({ type: "tool.call", toolUseId: `${sessionId}-${++n}`, tool, summary, nodeId, targets }) as Step;
const path = (p: string, access: string) => ({ kind: "path", value: `${CWD}/${p}`, access });
const host = (h: string, url: string) => ({ kind: "host", value: h, access: "network", url });
const endpoint = (route: string, status = "active") => node(`endpoint:${API}${route}`, route, "leaf", `host:${API}`, "endpoints", status);
const ep = (route: string) => `endpoint:${API}${route}`;

const script: Step[] = [
  { type: "session.start", title: "Demo: authorized test of acme-shop.test", cwd: CWD } as Step,
  node(R, "acme-shop", "root", undefined),
  think("Starting with the project layout to find the routes it exposes.", "orient"),

  // Code: entry point and route table.
  node(`${R}:files`, "files", "category", R, "files"),
  node(`files:${CWD}/src/server.ts`, "server.ts", "leaf", `${R}:files`, "files"),
  call("Read", "Read src/server.ts", `files:${CWD}/src/server.ts`, [path("src/server.ts", "read")]),
  done(`files:${CWD}/src/server.ts`),
  node(`${R}:searches`, "searches", "category", R, "searches"),
  node("searches:router.(get|post)", "router.(get|post)", "leaf", `${R}:searches`, "searches"),
  call("Grep", "Grep router.(get|post) src/", "searches:router.(get|post)", [path("src", "read")]),
  done("searches:router.(get|post)"),
  { type: "chain.step", step: { id: "s1", chainId: "main", title: "Mapped Express routes", nodeIds: [`files:${CWD}/src/server.ts`] } } as Step,

  // Attack surface: domain → subdomain → endpoints → parameters.
  node(`${R}:hosts`, "hosts", "category", R, "hosts"),
  node("domain:acme-shop.test", "acme-shop.test", "category", `${R}:hosts`, "hosts"),
  node(`host:${API}`, API, "category", "domain:acme-shop.test", "hosts"),
  endpoint("/api/login"),
  endpoint("/api/cart", "unexplored"),
  endpoint("/api/orders", "unexplored"),
  endpoint("/api/users/:id", "unexplored"),
  think("Login sets a session cookie; following it into the handlers that read it.", "follow data flow"),
  node("param:session", "session", "leaf", ep("/api/login"), "params"),
  link(ep("/api/login"), "param:session", "sets"),
  done(ep("/api/login")),
  { type: "chain.step", step: { id: "s2", chainId: "main", title: "Login issues session cookie", after: ["s1"], nodeIds: [ep("/api/login"), "param:session"] } } as Step,

  // Probe the in-scope API.
  node(`${R}:commands`, "commands", "category", R, "commands"),
  node(`commands:curl ${API}/api/cart`, `curl ${API}/api/cart`, "leaf", `${R}:commands`, "commands"),
  call("Bash", `Bash curl -s https://${API}/api/cart`, `commands:curl ${API}/api/cart`, [host(API, `https://${API}/api/cart`)]),
  link(`commands:curl ${API}/api/cart`, ep("/api/cart"), "request"),
  node("param:uid", "uid", "leaf", ep("/api/cart"), "params"),
  link(ep("/api/cart"), "param:session", "reads"),
  done(`commands:curl ${API}/api/cart`),

  // One stray request to production — out of scope.
  think("Checking whether production behaves the same as the test build.", "verify"),
  node(`${R}:web`, "web", "category", R, "web"),
  node("web:https://api.acme-shop.com/api/cart", "api.acme-shop.com/api/cart", "leaf", `${R}:web`, "web"),
  node("domain:acme-shop.com", "acme-shop.com", "category", `${R}:hosts`, "hosts"),
  node("host:api.acme-shop.com", "api.acme-shop.com", "category", "domain:acme-shop.com", "hosts"),
  call("WebFetch", "WebFetch https://api.acme-shop.com/api/cart", "web:https://api.acme-shop.com/api/cart", [
    host("api.acme-shop.com", "https://api.acme-shop.com/api/cart"),
  ]),
  link("web:https://api.acme-shop.com/api/cart", "host:api.acme-shop.com", "request"),

  // The finding.
  {
    type: "finding.upsert",
    finding: {
      id: "F-1",
      title: "Cart trusts unsigned user id from cookie",
      severity: "high",
      confidence: 0.55,
      status: "suspected",
      location: { file: "src/routes/cart.ts", line: 42 },
      description:
        "The cart handler reads `uid` from the session cookie without verifying its signature, so any user can read another user's cart. Fix: verify the cookie with the session secret before use.",
      nodeIds: [ep("/api/cart"), "param:uid", "param:session"],
      stepIds: ["s1", "s2"],
    },
  } as Step,
  { type: "chain.step", step: { id: "s3", chainId: "main", title: "Cart trusts cookie for user id", after: ["s2"], nodeIds: [ep("/api/cart")], confirmed: true } } as Step,
  { type: "finding.upsert", finding: { id: "F-1", confidence: 0.9, status: "confirmed", stepIds: ["s1", "s2", "s3"] } } as Step,
  done(ep("/api/cart")),
  done("param:uid"),
  done("param:session"),

  // Remediation: an edit to the finding's file is linked to it by the hub.
  node(`files:${CWD}/src/routes/cart.ts`, "cart.ts", "leaf", `${R}:files`, "files"),
  call("Edit", "Edit src/routes/cart.ts", `files:${CWD}/src/routes/cart.ts`, [path("src/routes/cart.ts", "write")]),
  done(`files:${CWD}/src/routes/cart.ts`),

  {
    type: "finding.upsert",
    finding: {
      id: "F-2",
      title: "Orders endpoint lacks rate limiting",
      severity: "low",
      confidence: 0.4,
      status: "suspected",
      location: { file: "src/routes/orders.ts" },
      nodeIds: [ep("/api/orders")],
    },
  } as Step,
  done(`${R}:files`),
  done(`${R}:searches`),
  done(`${R}:commands`),
];

// The operator authorizes the test target (the demo plays the operator here).
await fetch(`${HUB}/scope`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ paths: [CWD], hosts: ["acme-shop.test"] }),
});

for (const step of script) {
  await fetch(`${HUB}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...step, sessionId, source: "demo" }),
  });
  await sleep(400);
}

// The operator's proxy history arrives — the same path as Import HAR and `npm run import`.
const har = JSON.parse(fs.readFileSync(new URL("../../../examples/acme-shop.har", import.meta.url), "utf8"));
await fetch(`${HUB}/import`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ entries: parseHar(har), label: "acme-shop.har" }),
});
await sleep(400);

// The Navigator's take — scored leads and finding verdicts the validator process
// would normally produce. Posted to /validator so they're labelled `validator`.
const nav: any[] = [
  {
    type: "assessment.upsert",
    assessment: { id: `nav:${ep("/api/cart")}`, nodeId: ep("/api/cart"), title: "Cart authorization boundary", bugClass: "idor", confidence: 0.82, recommendation: "pursue", rationale: "Reads a user id from an unsigned cookie — classic IDOR surface, and already load-bearing in the chain." },
  },
  {
    type: "assessment.upsert",
    assessment: { id: `nav:${ep("/api/admin/export")}`, nodeId: ep("/api/admin/export"), title: "Admin export, seen only in traffic", bugClass: "authz", confidence: 0.77, recommendation: "pursue", rationale: "An admin route the proxy saw succeed from a normal session, and the agent has never tested it. Check who can call it." },
  },
  {
    type: "assessment.upsert",
    assessment: { id: `nav:${ep("/api/users/:id")}`, nodeId: ep("/api/users/:id"), title: "User profile by id", bugClass: "idor", confidence: 0.71, recommendation: "pursue", rationale: "Unexplored, takes an object id in the path, and likely shares the cart's cookie-trust pattern." },
  },
  {
    type: "assessment.upsert",
    assessment: { id: `nav:${ep("/api/orders")}`, nodeId: ep("/api/orders"), title: "Orders endpoint", bugClass: "idor", confidence: 0.45, recommendation: "watch", rationale: "Same handler family as cart. Check once the cart fix lands." },
  },
  {
    type: "assessment.upsert",
    assessment: { id: `nav:${ep("/api/login")}`, nodeId: ep("/api/login"), title: "Login handler", bugClass: "authn", confidence: 0.3, recommendation: "watch", rationale: "Issues the session cookie; the signing secret and verification path are worth tracing." },
  },
  {
    type: "finding.assessment",
    findingId: "F-1",
    assessment: { verdict: "corroborated", confidence: 0.86, rationale: "Chain holds: login sets the cookie, cart reads uid without verifying its signature. High severity is justified." },
  },
  {
    type: "finding.assessment",
    findingId: "F-2",
    assessment: { verdict: "needs-evidence", confidence: 0.4, rationale: "No supporting chain step or observed probe yet — the rate-limit claim is unverified." },
  },
];
for (const e of nav) {
  await fetch(`${HUB}/validator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...e, assessment: { ...e.assessment, ts: Date.now() }, sessionId }),
  });
  await sleep(250);
}
console.log(`[spectra] demo complete (session ${sessionId})`);
