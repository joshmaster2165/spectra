// Reading one tool call: which calls are understood, which are flagged as unread, and what an
// MCP tool's input says about where it sends its request.
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTargets, opaqueReason, readCall } from "../src/toolmap.ts";

const A = "http://api.lab.localhost:4420";
const reason = (command: string) => readCall("Bash", { command }, "/p").reason ?? null;
const CODE = "Runs code through python3, so its targets aren't in the command";
const urls = (tool: string, input: Record<string, unknown>) =>
  extractTargets(tool, input)
    .filter((t) => t.kind === "host")
    .map((t) => t.url ?? t.value);

test("inline code that requests written-out URLs is read", () => {
  assert.equal(reason(`python3 -c "import urllib.request as u; print(u.urlopen('${A}/debug/vars').read().decode())"`), null);
  assert.equal(reason(`node -e "fetch('${A}/internal/health').then(r=>r.text()).then(console.log)"`), null);
});

test("inline code that builds its URLs stays flagged", () => {
  assert.equal(reason(`python3 -c "import urllib.request as u; [print(u.urlopen('${A}' + p).status) for p in ['/a','/b']]"`), CODE);
  assert.equal(reason(`python3 -c "import requests; b='${A}'; print(requests.get(f'{b}/x').status_code)"`), CODE);
  assert.equal(reason(`python3 -c "import sys,urllib.request as u; u.urlopen('${A}/x'); u.urlopen(sys.argv[1])" http://x`), CODE);
});

test("inline code that only handles data locally is not flagged", () => {
  assert.equal(reason(`curl -s ${A}/v1/admin/users | python3 -c "import sys, json; print(len(json.load(sys.stdin)))"`), null);
});

test("an MCP tool's URL is found at any depth of its input", () => {
  assert.deepEqual(urls("mcp__x__send", { request: { target: { url: "https://api.example-shop.test/v1/users?id=1" } } }), ["https://api.example-shop.test/v1/users?id=1"]);
  assert.deepEqual(urls("mcp__x__ask", { prompt: "open https://shop.example-shop.test/help/contact and summarise" }), ["https://shop.example-shop.test/help/contact"]);
});

test("an MCP tool's host and path in separate fields make one address", () => {
  assert.deepEqual(urls("mcp__x__req", { host: "api.example-shop.test", port: 8443, path: "/v2/orders", method: "GET" }), ["http://api.example-shop.test:8443/v2/orders"]);
  assert.deepEqual(urls("mcp__x__req", { hostname: "shop.example-shop.test", https: true, endpoint: "/login" }), ["https://shop.example-shop.test/login"]);
  // …and that path is a route on the target, not a file on this machine.
  assert.equal(extractTargets("mcp__x__req", { host: "api.example-shop.test", path: "/etc/passwd" }).filter((t) => t.kind === "path").length, 0);
});

test("an MCP tool given a whole HTTP request as text", () => {
  const content = "POST /v1/auth/login HTTP/1.1\r\nHost: api.example-shop.test\r\nContent-Type: application/json\r\n\r\n{}";
  assert.deepEqual(urls("mcp__burp__send", { content }), ["http://api.example-shop.test/v1/auth/login"]);
});

test("an MCP tool with no address in its input is flagged, never guessed", () => {
  const input = { request_id: 14 };
  assert.equal(opaqueReason("mcp__burp__send_to_repeater", input, extractTargets("mcp__burp__send_to_repeater", input)), "A tool call with no target Spectra can read");
});

test("an MCP file tool keeps its file path", () => {
  assert.deepEqual(extractTargets("mcp__fs__read_file", { path: "/work/lab/notes.md" }).map((t) => t.kind), ["path"]);
});
