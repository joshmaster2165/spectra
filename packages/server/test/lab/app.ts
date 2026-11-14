// A deliberately vulnerable lab app for testing Spectra end to end. Loopback only.
// One server, four virtual hosts: shop / api / admin / staging .lab.localhost.
// Every request it answers is recorded: the ground truth for what a command really touched.
// All "secrets" below are fake lab values.
import http from "node:http";

export interface LabRequest {
  ts: number;
  host: string;
  method: string;
  path: string;
  params: string[];
  status: number;
}

export interface Lab {
  port: number;
  /** Every request received since the last clear(), in order. */
  requests: LabRequest[];
  clear(): void;
  stop(): Promise<void>;
}

type Send = (status: number, body: string, type?: string, headers?: Record<string, string>) => void;

const USERS: Record<string, object> = {
  1: { id: 1, email: "admin@lab.localhost", role: "admin", address: "1 Lab Way" },
  2: { id: 2, email: "alice@lab.localhost", role: "customer", address: "22 Test St" },
  3: { id: 3, email: "bob@lab.localhost", role: "customer", address: "9 Demo Rd" },
};
const ORDERS: Record<string, { id: number; user_id: number; total: number; card_last4: string }> = {
  1001: { id: 1001, user_id: 2, total: 49.5, card_last4: "4242" },
  1002: { id: 1002, user_id: 3, total: 120, card_last4: "1881" },
};
const TOKENS: Record<string, number> = { "lab-token-alice": 2, "lab-token-bob": 3 };

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

export async function startLab(port: number): Promise<Lab> {
  const requests: LabRequest[] = [];

  function shop(_req: http.IncomingMessage, url: URL, send: Send, staging = false) {
    const p = url.pathname;
    if (p === "/")
      return send(200, html("Lab Shop", `<h1>Lab Shop</h1><a href="/products?id=1">Products</a> <a href="/search?q=mug">Search</a> <a href="/login">Login</a> <a href="/account/orders">Orders</a><script src="/static/app.js"></script><!-- admin panel moved to admin.lab.localhost -->`), "text/html");
    if (p === "/static/app.js")
      return send(
        200,
        `const API = "http://api.lab.localhost:${port}/v1";
fetch(API + "/users/me");
fetch(API + "/orders?user_id=" + uid);
fetch(API + "/orders/" + orderId);
fetch(API + "/auth/login", { method: "POST" });
fetch(API + "/auth/reset", { method: "POST" });
fetch(API + "/files/download?path=invoices/" + orderId + ".pdf");
fetch("http://api.lab.localhost:${port}/graphql", { method: "POST" });
// third-party, not ours
import("https://cdn.thirdparty-example.com/analytics.js");
const PARTNER = "https://partner-api.example.net/v2/track";`,
        "application/javascript",
      );
    if (p === "/robots.txt") return send(200, "User-agent: *\nDisallow: /backup/\nDisallow: /admin-old/\nDisallow: /.env\nSitemap: /sitemap.xml\n");
    if (p === "/sitemap.xml") return send(200, `<urlset><url><loc>/products</loc></url><url><loc>/search</loc></url><url><loc>/account/orders</loc></url><url><loc>/help/contact</loc></url></urlset>`, "application/xml");
    if (p === "/.env") return send(200, "APP_ENV=lab\nDB_PASSWORD=lab-not-a-real-secret\nSTRIPE_KEY=sk_test_lab_fake_000\n");
    if (p === "/backup/") return send(200, html("Index of /backup", `<a href="db-2026-01.sql.gz">db-2026-01.sql.gz</a>`), "text/html");
    if (p === "/backup/db-2026-01.sql.gz") return send(200, "fake-lab-backup", "application/gzip");
    if (p === "/admin-old/") return send(403, "Forbidden");
    if (p === "/products") return send(200, html("Product", `<h1>Product ${url.searchParams.get("id") ?? ""}</h1>`), "text/html");
    // Reflects the query unescaped.
    if (p === "/search") return send(200, html("Search", `<p>Results for ${url.searchParams.get("q") ?? ""}</p><form><input name="q"><select name="sort"></select></form>`), "text/html");
    if (p === "/login") return send(200, html("Login", `<form method="post" action="/login"><input name="email"><input name="password" type="password"><input name="next" type="hidden"></form>`), "text/html");
    if (p === "/account/orders") return send(302, "", "text/plain", { location: "/login?next=/account/orders" });
    if (p === "/help/contact") return send(200, html("Contact", `<form method="post"><input name="email"><textarea name="message"></textarea></form>`), "text/html");
    if (staging && p === "/debug") return send(200, JSON.stringify({ env: "staging", db: "postgres://lab:lab@db.internal.lab.localhost/shop", build: "2026.11.3" }), "application/json");
    if (staging && p === "/phpinfo.php") return send(200, html("phpinfo()", "PHP Version 8.1.0 (lab)"), "text/html");
    return send(404, "Not found");
  }

  function api(req: http.IncomingMessage, url: URL, send: Send) {
    const p = url.pathname;
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const me = TOKENS[auth];
    const json = (code: number, obj: unknown) => send(code, JSON.stringify(obj), "application/json");
    let m: RegExpMatchArray | null;
    if (p === "/") return json(200, { service: "lab-api", docs: "/openapi.json" });
    if (p === "/openapi.json")
      return json(200, {
        openapi: "3.0.0",
        info: { title: "Lab API", version: "1" },
        paths: {
          "/v1/users/me": { get: {} },
          "/v1/users/{id}": { get: { parameters: [{ name: "id", in: "path" }] } },
          "/v1/orders": { get: { parameters: [{ name: "user_id", in: "query" }, { name: "status", in: "query" }] } },
          "/v1/orders/{id}": { get: {} },
          "/v1/auth/login": { post: {} },
          "/v1/auth/reset": { post: {} },
          "/v1/files/download": { get: { parameters: [{ name: "path", in: "query" }] } },
          "/v1/payments/webhook": { post: {} },
          "/v1/admin/users": { get: {} },
          "/v1/admin/export": { get: { parameters: [{ name: "format", in: "query" }] } },
        },
      });
    if (p === "/v1/auth/login" && req.method === "POST") return json(200, { token: "lab-token-alice", note: "lab: any credentials log in as alice" });
    if (p === "/v1/auth/login") return json(405, { error: "POST only" });
    if (p === "/v1/auth/reset") return json(200, { sent: true });
    // Missing authorization check: no token needed at all.
    if (p === "/v1/admin/users") return json(200, Object.values(USERS));
    if (p === "/v1/admin/export") return me ? json(403, { error: "admin only" }) : json(401, { error: "auth required" });
    if (p === "/v1/payments/webhook") return json(200, { received: true, signature_checked: false });
    if (p === "/internal/health") return json(200, { ok: true, db: "up", queue: "up" });
    if (p === "/debug/vars") return json(200, { goroutines: 12, build: "lab" });
    if (p === "/graphql") return json(200, { data: { __schema: { queryType: { name: "Query" }, types: [{ name: "User" }, { name: "Order" }, { name: "Coupon" }] } } });
    if (!p.startsWith("/v1/")) return json(404, { error: "not found" });
    if (!me) return json(401, { error: "auth required" });
    if (p === "/v1/users/me") return json(200, USERS[me]);
    // IDOR: any authenticated user can read any user or order.
    if ((m = p.match(/^\/v1\/users\/(\d+)$/))) return USERS[m[1]] ? json(200, USERS[m[1]]) : json(404, { error: "no such user" });
    if ((m = p.match(/^\/v1\/orders\/(\d+)$/))) return ORDERS[m[1]] ? json(200, ORDERS[m[1]]) : json(404, { error: "no such order" });
    if (p === "/v1/orders") {
      const uid = Number(url.searchParams.get("user_id") ?? me);
      return json(200, Object.values(ORDERS).filter((o) => o.user_id === uid));
    }
    if (p === "/v1/files/download") return json(400, { error: "path must start with invoices/", got: url.searchParams.get("path") });
    return json(404, { error: "not found" });
  }

  function admin(_req: http.IncomingMessage, url: URL, send: Send) {
    const p = url.pathname;
    if (p === "/") return send(302, "", "text/plain", { location: "/login" });
    if (p === "/login") return send(200, html("Admin login", `<form method="post"><input name="username"><input name="password" type="password"><input name="otp"></form>`), "text/html");
    if (p === "/dashboard" || p === "/users" || p === "/export") return send(302, "", "text/plain", { location: "/login" });
    return send(404, "Not found");
  }

  const HOSTS: Record<string, (req: http.IncomingMessage, url: URL, send: Send) => void> = {
    "shop.lab.localhost": shop,
    "staging.lab.localhost": (r, u, s) => shop(r, u, s, true),
    "api.lab.localhost": api,
    "admin.lab.localhost": admin,
    "lab.localhost": shop,
  };

  function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    const url = new URL(req.url ?? "/", `http://${host || "x"}`);
    const send: Send = (status, body, type = "text/plain", headers = {}) => {
      requests.push({ ts: Date.now(), host, method: req.method ?? "GET", path: url.pathname, params: [...url.searchParams.keys()], status });
      res.writeHead(status, { "content-type": type, server: "lab", ...headers });
      res.end(req.method === "HEAD" ? "" : body);
    };
    req.resume();
    req.on("end", () => {
      const app = HOSTS[host];
      if (!app) return send(421, "No such site on this lab server");
      app(req, url, send);
    });
  }

  // *.localhost resolves to ::1 or 127.0.0.1 depending on the client, so listen on both where both exist.
  const servers: http.Server[] = [];
  for (const addr of ["127.0.0.1", "::1"]) {
    const server = http.createServer(handle);
    const up = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, addr, () => resolve(true));
    });
    if (up) servers.push(server);
    else if (addr === "127.0.0.1") throw new Error(`the lab app could not listen on 127.0.0.1:${port}`);
  }

  return {
    port,
    requests,
    clear: () => void (requests.length = 0),
    stop: () =>
      Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections();
              s.close(() => resolve());
            }),
        ),
      ).then(() => undefined),
  };
}
