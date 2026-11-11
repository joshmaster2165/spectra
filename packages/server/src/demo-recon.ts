import fs from "node:fs";
import { parseHar, type SpectraEvent } from "@spectra/schema";

/**
 * A scripted recon engagement for the README video: the operator authorizes
 * acme-shop.test (a fictional .test domain), and the agent enumerates its
 * subdomains, probes them, maps the API from its OpenAPI document, the OIDC
 * surface, fuzzes the admin host, mines a JS bundle for unlinked routes, strays
 * once to production, reports what it found, and the operator's proxy history
 * is imported. The Navigator then scores the surface.
 *
 *   npm run demo:recon
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const PACE = Number(process.env.SPECTRA_DEMO_PACE ?? 1); // <1 is faster
const sessionId = `recon-${Date.now().toString(36)}`;
const CWD = "/work/acme-shop-recon";
const DOMAIN = "acme-shop.test";
const R = `root:${sessionId}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * PACE));

type Step = Omit<SpectraEvent, "ts" | "sessionId" | "source">;
let n = 0;

async function post(step: Step, wait = 140) {
  await fetch(`${HUB}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...step, sessionId, source: "demo" }),
  });
  await sleep(wait);
}

const node = (id: string, label: string, kind: "root" | "category" | "leaf", parentId: string | undefined, category: string | undefined, status = "active") =>
  post({ type: "node.upsert", node: { id, label, kind, parentId, category, status } } as Step);
const done = (id: string, wait = 70) => post({ type: "node.upsert", node: { id, status: "complete" } } as Step, wait);
const think = (text: string, reason: string) => post({ type: "thought", text, reason } as Step, 900);
const host = (h: string) => `host:${h}.${DOMAIN}`;
const ep = (h: string, route: string) => `endpoint:${h}.${DOMAIN}${route}`;

/** A tool call against an in-scope URL (or a local file), with its node. */
async function action(category: string, tool: string, label: string, target: { url?: string; path?: string }) {
  const id = `${category}:${label}`;
  await node(id, label, "leaf", `${R}:${category}`, category);
  const targets = target.url
    ? [{ kind: "host", value: new URL(target.url).hostname, access: "network", url: target.url }]
    : [{ kind: "path", value: `${CWD}/${target.path}`, access: "read" }];
  await post({ type: "tool.call", toolUseId: `${sessionId}-${++n}`, tool, summary: `${tool} ${label}`, nodeId: id, targets } as Step, 400);
  return id;
}

async function endpoints(h: string, routes: string[], wait = 110) {
  for (const route of routes) await node(ep(h, route), route, "leaf", host(h), "endpoints", "unexplored");
  await sleep(wait);
}

async function params(h: string, route: string, names: string[]) {
  for (const p of names) await node(`param:${h}.${DOMAIN}${route}?${p}`, p, "leaf", ep(h, route), "params", "unexplored");
}

async function finding(f: Record<string, unknown>) {
  await post({ type: "finding.upsert", finding: f } as Step, 700);
}

// ── Scope: the operator authorizes the test domain ────────────────────────
await fetch(`${HUB}/scope`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ paths: [CWD], hosts: [DOMAIN] }),
});

await post({ type: "session.start", title: `Recon: ${DOMAIN}`, cwd: CWD } as Step);
await node(R, `${DOMAIN} recon`, "root", undefined, undefined);
for (const c of ["commands", "web", "searches"]) await node(`${R}:${c}`, c, "category", R, c, "active");
await node(`${R}:hosts`, "hosts", "category", R, "hosts");
await node(`domain:${DOMAIN}`, DOMAIN, "category", `${R}:hosts`, "hosts");

// ── 1. Subdomain enumeration ──────────────────────────────────────────────
await think(`Starting passive enumeration of ${DOMAIN}.`, "enumerate");
const subfinder = await action("commands", "Bash", `subfinder -d ${DOMAIN} -silent`, { url: `https://${DOMAIN}` });
const SUBS = ["www", "api", "auth", "admin", "cdn", "staging", "dev", "docs", "status", "grafana", "mail", "shop", "ws", "legacy", "payments", "partners"];
for (const s of SUBS) await node(host(s), `${s}.${DOMAIN}`, "category", `domain:${DOMAIN}`, "hosts", "unexplored");
await done(subfinder);

// ── 2. Probe for live HTTP services ───────────────────────────────────────
await think(`${SUBS.length} subdomains. Probing which ones serve HTTP.`, "probe");
const httpx = await action("commands", "Bash", "httpx -l subs.txt -title -tech-detect", { url: `https://api.${DOMAIN}` });
const DEAD = new Set(["mail", "legacy", "partners", "ws"]);
for (const s of SUBS) if (!DEAD.has(s)) await done(host(s), 90);
await done(httpx);

// ── 3. API from its OpenAPI document ──────────────────────────────────────
await think("api serves an OpenAPI document — mapping every route it declares.", "follow lead");
const spec = await action("web", "WebFetch", `https://api.${DOMAIN}/openapi.json`, { url: `https://api.${DOMAIN}/openapi.json` });
await endpoints("api", [
  "/v1/users", "/v1/users/:id", "/v1/users/:id/orders", "/v1/orders", "/v1/orders/:id", "/v1/orders/:id/refund",
  "/v1/cart", "/v1/cart/items", "/v1/payments", "/v1/payments/:id", "/v1/coupons/:code", "/v1/products",
  "/v1/products/:id", "/v1/reviews", "/v1/search", "/v1/admin/reports", "/v1/admin/users", "/v1/webhooks",
]);
await params("api", "/v1/search", ["q", "sort", "page"]);
await params("api", "/v1/orders/:id/refund", ["amount", "reason"]);
await params("api", "/v1/users/:id", ["email", "role"]);
await params("api", "/v1/webhooks", ["url", "events"]);
await done(spec);
await post({ type: "chain.step", step: { id: "s1", chainId: "main", title: "OpenAPI exposed on api", nodeIds: [spec] } } as Step);

// ── 4. Identity surface ───────────────────────────────────────────────────
const oidc = await action("web", "WebFetch", `https://auth.${DOMAIN}/.well-known/openid-configuration`, { url: `https://auth.${DOMAIN}/.well-known/openid-configuration` });
await endpoints("auth", ["/.well-known/openid-configuration", "/authorize", "/token", "/userinfo", "/logout", "/password/reset"]);
await params("auth", "/authorize", ["client_id", "redirect_uri", "response_type", "state"]);
await done(oidc);

// ── 5. Content discovery on admin ─────────────────────────────────────────
await think("admin answers with a login page. Fuzzing for paths it doesn't link.", "content discovery");
const ffuf = await action("commands", "Bash", `ffuf -u https://admin.${DOMAIN}/FUZZ -w common.txt`, { url: `https://admin.${DOMAIN}/FUZZ` });
await endpoints("admin", ["/login", "/dashboard", "/debug", "/backup", "/metrics", "/api/export", "/.git/HEAD", "/server-status"]);
await done(ffuf);

// ── 6. Mine the JS bundle for unlinked routes ─────────────────────────────
await think("Pulling the storefront bundle from cdn to find routes the UI calls but never links.", "js analysis");
const bundle = await action("web", "WebFetch", `https://cdn.${DOMAIN}/assets/main.8c1f.js`, { url: `https://cdn.${DOMAIN}/assets/main.8c1f.js` });
const grep = await action("searches", "Grep", '"/(internal|graphql|v2)/" main.8c1f.js', { path: "bundle/main.8c1f.js" });
await endpoints("api", ["/graphql", "/internal/feature-flags", "/internal/healthz", "/v2/checkout"]);
await params("api", "/graphql", ["operationName", "query", "variables"]);
await done(bundle);
await done(grep);
await post({ type: "chain.step", step: { id: "s2", chainId: "main", title: "Internal routes leak through the JS bundle", after: ["s1"], nodeIds: [ep("api", "/internal/feature-flags")] } } as Step);

// ── 7. The rest of the estate ─────────────────────────────────────────────
await endpoints("staging", ["/debug/vars", "/api/v1/users", "/api/v1/orders"], 60);
await endpoints("dev", ["/graphql/playground", "/api/v1/seed"], 60);
await endpoints("grafana", ["/login", "/api/health", "/api/dashboards/home"], 60);
await endpoints("docs", ["/swagger-ui", "/openapi.yaml"], 60);
await endpoints("status", ["/api/v2/summary.json"], 60);
await endpoints("payments", ["/v1/intents", "/v1/intents/:id/confirm", "/v1/webhooks/stripe"], 60);
await endpoints("shop", ["/checkout", "/account"], 60);

// ── 8. One stray request to production ────────────────────────────────────
await think("Checking whether production runs the same build.", "verify");
await node("domain:acme-shop.com", "acme-shop.com", "category", `${R}:hosts`, "hosts");
await node("host:www.acme-shop.com", "www.acme-shop.com", "category", "domain:acme-shop.com", "hosts");
await action("web", "WebFetch", "https://www.acme-shop.com/", { url: "https://www.acme-shop.com/" });

// ── 9. Findings ───────────────────────────────────────────────────────────
await post({ type: "chain.step", step: { id: "s3", chainId: "main", title: "Staging leaks runtime state at /debug/vars", after: ["s2"], nodeIds: [ep("staging", "/debug/vars")], confirmed: true } } as Step);
await finding({ id: "R-1", title: "Exposed .git directory on admin", severity: "high", confidence: 0.92, status: "confirmed", description: "admin.acme-shop.test serves /.git/HEAD, so the repository history can be reconstructed.", nodeIds: [ep("admin", "/.git/HEAD")] });
await finding({ id: "R-2", title: "Refund endpoint may skip ownership check", severity: "high", confidence: 0.6, status: "suspected", location: { file: "src/api/orders/refund.ts" }, nodeIds: [ep("api", "/v1/orders/:id/refund")] });
await finding({ id: "R-3", title: "Staging exposes /debug/vars", severity: "medium", confidence: 0.85, status: "confirmed", nodeIds: [ep("staging", "/debug/vars")], stepIds: ["s1", "s2", "s3"] });
await finding({ id: "R-4", title: "Grafana dashboards readable anonymously", severity: "low", confidence: 0.5, status: "suspected", nodeIds: [ep("grafana", "/api/dashboards/home")] });
for (const id of [ep("admin", "/.git/HEAD"), ep("staging", "/debug/vars"), ep("api", "/v1/search"), ep("auth", "/authorize")]) await done(id, 120);

// ── 10. Proxy history ─────────────────────────────────────────────────────
const har = JSON.parse(fs.readFileSync(new URL("../../../examples/acme-shop.har", import.meta.url), "utf8"));
await fetch(`${HUB}/import`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ entries: parseHar(har), label: "acme-shop.har" }),
});
await sleep(800);

// ── 11. The Navigator's read ──────────────────────────────────────────────
const lead = (h: string, route: string, title: string, bugClass: string, confidence: number, recommendation: string, rationale: string) => ({
  type: "assessment.upsert",
  assessment: { id: `nav:${ep(h, route)}`, nodeId: ep(h, route), title, bugClass, confidence, recommendation, rationale },
});
const nav = [
  lead("api", "/v1/orders/:id/refund", "Refund by order id", "idor", 0.84, "pursue", "Takes an object id and moves money; no sign of an ownership check in the spec."),
  lead("api", "/internal/feature-flags", "Internal feature flags", "authz", 0.79, "pursue", "Unlinked internal route found only in the bundle; likely missing auth."),
  lead("api", "/v1/admin/users", "Admin user listing", "authz", 0.74, "pursue", "Admin route on the public API host. Check it with a normal user token."),
  lead("api", "/graphql", "GraphQL endpoint", "injection", 0.55, "watch", "Introspection and batching are worth checking once the REST routes are done."),
  lead("auth", "/authorize", "OIDC authorize", "auth-bypass", 0.48, "watch", "redirect_uri validation is the usual weak spot."),
  lead("grafana", "/api/dashboards/home", "Grafana home dashboard", "info", 0.22, "skip", "Low impact unless dashboards hold secrets."),
  { type: "finding.assessment", findingId: "R-1", assessment: { verdict: "corroborated", confidence: 0.93, rationale: "/.git/HEAD answering is enough to reconstruct the repo." } },
  { type: "finding.assessment", findingId: "R-2", assessment: { verdict: "needs-evidence", confidence: 0.45, rationale: "Plausible from the spec; needs a request with another user's order id." } },
];
for (const e of nav) {
  await fetch(`${HUB}/validator`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...e, assessment: { ...e.assessment, ts: Date.now() }, sessionId }),
  });
  await sleep(350);
}
console.log(`[spectra] recon demo complete (session ${sessionId})`);
