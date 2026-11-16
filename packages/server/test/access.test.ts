// Who may talk to the hub. It listens on loopback only, but a browser on this machine can be pointed
// at loopback by a hostile page, so every request is checked for where it says it comes from (Origin)
// and which machine it says it is talking to (Host).
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { startHub, tempDir } from "./helpers.ts";

type Hub = Awaited<ReturnType<typeof startHub>>;
interface Reply { status: number; body: string; upgraded: boolean }

describe("who may talk to the hub", () => {
  let hub: Hub;
  let port = 0;
  before(async () => {
    hub = await startHub({ dir: tempDir("access") });
    port = Number(new URL(hub.url).port);
  });
  after(() => hub.stop());

  /** One request with exactly the headers given, as a browser or a tool would send it. */
  const request = (path: string, headers: Record<string, string>, method = "GET", body?: string) =>
    new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers, setHost: false }, (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, upgraded: false }));
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, body: "", upgraded: true });
      });
      req.on("error", reject);
      req.end(body);
    });
  const socket = (headers: Record<string, string>) =>
    request("/ws", { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "c3BlY3RyYS10ZXN0LWtleQ==", ...headers });

  const local = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost", "LOCALHOST:5173"];
  // A page on a hostile site whose name now resolves to 127.0.0.1: the browser treats it as the
  // same site, sends no foreign Origin on a read, and still names the hostile site in Host.
  const foreign = () => [`attacker.example:${port}`, "attacker.example", `127.0.0.1.attacker.example:${port}`, `localhost.attacker.example:${port}`, `10.0.0.5:${port}`, "[2001:db8::1]"];

  it("answers a request that names this machine", async () => {
    for (const host of local()) {
      const r = await request("/state", { host });
      assert.equal(r.status, 200, host);
      assert.ok(JSON.parse(r.body).nodes, host);
    }
  });

  it("refuses a request that names no machine at all", async () => {
    assert.notEqual((await request("/state", {})).status, 200);
  });

  it("refuses to be read under another name, whatever the route", async () => {
    for (const host of foreign()) {
      for (const path of ["/state", "/history", "/settings", "/", "/assets/anything.js"]) {
        const r = await request(path, { host });
        assert.equal(r.status, 403, `${host} ${path}`);
        assert.equal(r.body, "host not allowed", `${host} ${path}`);
      }
    }
  });

  it("refuses a write under another name", async () => {
    const before = (await hub.state()).timeline.length;
    const event = JSON.stringify({ type: "thought", text: "planted", sessionId: "s-planted", source: "hook" });
    const r = await request("/events", { host: `attacker.example:${port}`, "content-type": "application/json" }, "POST", event);
    assert.equal(r.status, 403);
    assert.equal((await hub.state()).timeline.length, before, "nothing was recorded");
  });

  it("refuses a nonsense Host", async () => {
    for (const host of ["", " ", "a b", "http://127.0.0.1", "127.0.0.1:notaport", "127.0.0.1@attacker.example"]) {
      assert.equal((await request("/state", { host })).status, 403, JSON.stringify(host));
    }
  });

  it("refuses a page on another site, by Origin", async () => {
    const host = `127.0.0.1:${port}`;
    for (const origin of ["https://attacker.example", `http://attacker.example:${port}`, "null"]) {
      assert.equal((await request("/state", { host, origin })).status, 403, origin);
    }
    for (const origin of [`http://127.0.0.1:${port}`, "http://localhost:5173", `http://[::1]:${port}`]) {
      assert.equal((await request("/state", { host, origin })).status, 200, origin);
    }
  });

  it("opens the live feed only to this machine's own pages", async () => {
    const host = `127.0.0.1:${port}`;
    assert.ok((await socket({ host })).upgraded, "a local tool");
    assert.ok((await socket({ host, origin: `http://localhost:${port}` })).upgraded, "the dashboard");
    const refused: Record<string, string>[] = [
      { host: `attacker.example:${port}` },
      { host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` },
      { host, origin: "https://attacker.example" },
    ];
    for (const headers of refused) {
      const r = await socket(headers);
      assert.equal(r.upgraded, false, JSON.stringify(headers));
      assert.ok(r.status === 401 || r.status === 403, `${JSON.stringify(headers)} got ${r.status}`);
    }
  });
});
