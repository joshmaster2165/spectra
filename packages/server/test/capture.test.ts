// End to end: the ways Claude Code actually makes requests while bug hunting, each one run for
// real against the lab app with the real Spectra hook around it. The lab's own request log is the
// ground truth — what answered must be on the map or the call must be listed as not read, what
// wasn't there must stay off it, and nothing may appear that was never requested.
//
// The Interpreter is off here: this is what the hub captures by itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { subagentsOf } from "@spectra/schema";
import { startLab, type Lab } from "./lab/app.ts";
import { copyLabProject, freePort, missingPrograms, nodeIdOf, onMap, run, settled, sleep, startHub, tempDir, truthOf, type LabProject, type TestHub } from "./helpers.ts";

type Verdict =
  /** Everything that answered is on the map and no call is left open. */
  | "mapped"
  /** Something that answered is not on the map, and the call is listed as not read. A known limit, never silent. */
  | "flagged"
  /** Nothing answered and nothing was added. */
  | "clean"
  /** The call was stopped as out of scope. */
  | "violation";

interface Case {
  name: string;
  cmd?: string;
  tool?: string;
  input?: Record<string, unknown>;
  /** Files the driver writes with the Write tool before running the command. */
  files?: Record<string, string>;
  /** What actually happens when the tool isn't Bash (a stand-in for the tool's own traffic). */
  effect?: string;
  /** Claude Code asked for permission and the call never ran. */
  denied?: boolean;
  background?: boolean;
  /** The command is not run at all (an out-of-scope host). */
  noexec?: boolean;
  /** A second call the driver makes afterwards (reading a browser's network log, say), with the output it gets. */
  then?: { tool: string; input: Record<string, unknown>; output: string };
  /** Pretend the command ended this way instead of running it (a failure that can't be produced against a local lab). */
  fake?: { code: number; stderr: string };
  expect?: Verdict;
  /** Probes that weren't there but are mapped anyway: a small hand-written loop is mapped up front. */
  deadMapped?: number;
  /** The call is made by a subagent: Claude Code tags every hook event of the call with its id and kind. */
  agent?: { id: string; type: string };
}

const NEEDS = ["zsh", "curl", "jq", "python3", "nc"];
const missing = await missingPrograms(NEEDS);
if (missing.length && process.env.CI) throw new Error(`the capture tests need ${missing.join(", ")} installed`);

describe("capture, end to end", { skip: missing.length ? `needs ${missing.join(", ")} installed` : false }, () => {
  let lab: Lab;
  let hub: TestHub;
  let proj: LabProject;
  let SHOP = "", API = "", ADMIN = "", STG = "", PORT = 0;
  const SID = "capture";
  let n = 0;
  const open: string[] = [];

  before(async () => {
    PORT = await freePort();
    lab = await startLab(PORT);
    proj = copyLabProject(PORT);
    hub = await startHub({ dir: tempDir("capture-hub"), scope: { paths: [proj.dir], hosts: ["lab.localhost"] } });
    [SHOP, API, ADMIN, STG] = ["shop", "api", "admin", "staging"].map((h) => `http://${h}.lab.localhost:${PORT}`);
    await hook({ hook_event_name: "SessionStart" });
  });
  after(async () => {
    await hub?.stop();
    await lab?.stop();
  });

  /** Who is making the calls right now: empty for the main agent. */
  let who: { agent_id?: string; agent_type?: string } = {};
  const hook = (payload: object) => hub.hook({ session_id: SID, cwd: proj.dir, ...who, ...payload });

  /** Runs one case the way Claude Code would, and checks the map against what the lab received. */
  async function check(c: Case) {
    const id = `c${++n}`;
    who = c.agent ? { agent_id: c.agent.id, agent_type: c.agent.type } : {};
    // Each case starts from an empty map, so nothing an earlier case mapped can cover for it.
    await hub.post("/engagement/new", {});
    for (const [rel, content] of Object.entries(c.files ?? {})) {
      const file_path = path.join(proj.dir, rel);
      const wid = `${id}-w-${rel}`;
      await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: wid, tool_input: { file_path, content } });
      fs.writeFileSync(file_path, content);
      await hook({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: wid, tool_input: { file_path, content }, tool_response: { filePath: file_path, type: "create" } });
    }
    const beforeState = await hub.state();
    lab.clear();
    const tool = c.tool ?? "Bash";
    const input = c.input ?? { command: c.cmd, ...(c.background ? { run_in_background: true } : {}) };
    const call = { tool_name: tool, tool_use_id: id, tool_input: input };

    await hook({ hook_event_name: "PreToolUse", ...call });
    if (c.denied) {
      // What Claude Code 2.1 sends for a denied call: a permission request, then the batch, and no result.
      await hook({ hook_event_name: "PermissionRequest", tool_name: tool, tool_input: input });
      await hook({ hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: "A variable in this command can't be checked before it runs" }] });
    } else {
      const exec = c.fake
        ? { code: c.fake.code, stdout: "", stderr: c.fake.stderr }
        : c.noexec
          ? { code: 6, stdout: "", stderr: "curl: (6) Could not resolve host" }
          : await run("zsh", ["-c", c.effect ?? c.cmd!], { cwd: proj.dir, env: { PATH: proj.path } });
      const task = `bg${n}`;
      const shown = c.background ? { stdout: "", stderr: "" } : exec;
      if (exec.code === 0 || c.background)
        await hook({ hook_event_name: "PostToolUse", ...call, tool_response: tool === "Bash" ? { stdout: shown.stdout, stderr: shown.stderr, interrupted: false, isImage: false, ...(c.background ? { backgroundTaskId: task } : {}) } : shown.stdout });
      else await hook({ hook_event_name: "PostToolUseFailure", ...call, error: `Exit code ${exec.code}\n${exec.stdout}${exec.stderr}`, is_interrupt: false });
      await hook({ hook_event_name: "PostToolBatch", tool_calls: [{ ...call, tool_response: c.background ? `Command running in background with ID: ${task}.` : shown.stdout.slice(0, 200) }] });
      if (c.background) {
        // Later the driver reads the finished task's output file, which is how Claude Code delivers it.
        const file_path = `/tmp/claude/tasks/${task}.output`;
        const numbered = exec.stdout.split("\n").map((l, i) => `${i + 1}\t${l}`).join("\n");
        await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `${id}-read`, tool_input: { file_path } });
        await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: `${id}-read`, tool_input: { file_path }, tool_response: { type: "text", file: { filePath: file_path, content: numbered } } });
      }
    }
    if (c.then) {
      const tid = `${id}-then`;
      await hook({ hook_event_name: "PreToolUse", tool_name: c.then.tool, tool_use_id: tid, tool_input: c.then.input });
      await hook({ hook_event_name: "PostToolUse", tool_name: c.then.tool, tool_use_id: tid, tool_input: c.then.input, tool_response: c.then.output });
    }
    await sleep(200);

    const state = await hub.state();
    const truth = truthOf(lab.requests);
    const action = state.actions[id];
    const where = `${c.name}${action ? ` [${action.resolution ?? "open"}: ${action.reason}${action.note ? " — " + action.note : ""}]` : ""}`;
    const fresh = Object.keys(state.nodes).filter((k) => !beforeState.nodes[k] && /^(endpoint|host|param):/.test(k));
    const liveOff = [...truth.live].filter((k) => !onMap(state, k));
    const deadOn = [...truth.dead].filter((k) => onMap(state, k) && !beforeState.nodes[nodeIdOf(k)]);
    const paramsOff = [...truth.params].filter((p) => !state.nodes[p]);

    // Nothing on the map that was neither requested nor read from the command's own output.
    const touched = new Set([...truth.live, ...truth.dead].map(nodeIdOf));
    const hosts = new Set([...truth.live, ...truth.dead].map((k) => `host:${k.split("/")[0]}`));
    const phantom = fresh.filter((k) => !touched.has(k) && !hosts.has(k) && !truth.params.has(k) && state.nodes[k].meta?.["seen in"] !== "command output");
    assert.deepEqual(phantom, [], `${where}: on the map but never requested`);
    // What wasn't there stays off the map.
    assert.equal(deadOn.length, c.deadMapped ?? 0, `${where}: probes that weren't there are on the map: ${deadOn.join("  ")}`);
    // A finished call leaves no target marked as still being worked on.
    assert.deepEqual(fresh.filter((k) => state.nodes[k].status === "active"), [], `${where}: targets left "active"`);

    // A subagent's call is recorded as its own, and so is everything the call put on the map. Nobody else's is.
    const recorded = state.timeline.find((e: any) => e.type === "tool.call" && e.toolUseId === id);
    assert.deepEqual(recorded?.agent, c.agent, `${where}: who made the call`);
    const marked = fresh.filter((k) => subagentsOf(state.nodes[k]).length > 0);
    if (c.agent) assert.deepEqual(fresh.filter((k) => !subagentsOf(state.nodes[k]).includes(c.agent!.type)), [], `${where}: on the map without the subagent's name`);
    else assert.deepEqual(marked, [], `${where}: marked as a subagent's, but the main agent made the call`);
    if (action) assert.deepEqual(action.agent, c.agent, `${where}: who made the unread call`);

    const expect = c.expect ?? "mapped";
    if (expect === "violation") {
      assert.ok(state.violations.length > 0, `${where}: no scope violation raised`);
      return;
    }
    assert.equal(state.violations.length, 0, `${where}: unexpected scope violation`);
    if (expect === "flagged") {
      // The known limits. If one of these starts passing as "mapped", the limit is gone: update the case.
      assert.ok(liveOff.length > 0, `${where}: expected something unmapped, but everything is on the map`);
      assert.ok(action && !settled(action), `${where}: ${liveOff.join("  ")} not mapped and the call is not listed as not read`);
      open.push(c.name);
      return;
    }
    assert.deepEqual(liveOff, [], `${where}: answered but not on the map`);
    assert.deepEqual(paramsOff, [], `${where}: parameters not on the map`);
    assert.ok(!action || settled(action), `${where}: everything is mapped but the call is still listed as not read`);
    if (expect === "mapped") assert.ok(truth.live.size > 0, `${where}: the command reached nothing in the lab, so the case proves nothing`);
    else assert.equal(truth.live.size, 0, `${where}: expected no traffic`);
  }

  const group = (title: string, cases: () => Case[]) =>
    describe(title, () => {
      // Built lazily: the URLs aren't known until the lab has a port.
      const names = cases().map((c) => c.name);
      names.forEach((name, i) => it(name, () => check(cases()[i])));
    });

  group("single requests", (): Case[] => [
    { name: "plain GET", cmd: `curl -s ${SHOP}/login` },
    { name: "GET with a query", cmd: `curl -s "${SHOP}/search?q=mug&sort=price"` },
    { name: "headers and a bearer token", cmd: `curl -s -H "Authorization: Bearer lab-token-alice" -H 'Accept: application/json' ${API}/v1/users/me` },
    { name: "POST json", cmd: `curl -s -X POST -H 'content-type: application/json' -d '{"email":"a@lab.localhost","password":"x"}' ${API}/v1/auth/login` },
    { name: "-G with -d params", cmd: `curl -s -G -H "Authorization: Bearer lab-token-alice" -d user_id=3 -d status=open ${API}/v1/orders` },
    { name: "HEAD and OPTIONS", cmd: `curl -sI ${SHOP}/robots.txt; curl -s -X OPTIONS -i ${API}/v1/auth/login | head -3` },
    { name: "several URLs in one curl", cmd: `curl -s ${SHOP}/robots.txt ${SHOP}/sitemap.xml ${API}/openapi.json | head -c 300` },
    { name: "chained with && and ;", cmd: `curl -s ${SHOP}/.env && curl -s ${SHOP}/backup/; curl -s -o /dev/null -w "%{http_code}\\n" ${ADMIN}/dashboard` },
    { name: "piped to inline python", cmd: `curl -s ${API}/v1/admin/users | python3 -c "import sys, json; print([u['email'] for u in json.load(sys.stdin)])"` },
    { name: "piped to jq", cmd: `curl -s ${API}/openapi.json | jq -r '.paths | keys[]'` },
    { name: "output to a file, then read", cmd: `curl -s ${API}/v1/admin/users -o users.json; jq length users.json` },
    { name: "wrappers (nice, env, command)", cmd: `nice curl -s ${STG}/debug; env FOO=1 curl -s -o /dev/null ${STG}/phpinfo.php; command curl -s -o /dev/null ${STG}/robots.txt` },
    { name: "following a redirect with -L", cmd: `curl -sL -o /dev/null -w "%{url_effective} %{http_code}\\n" ${SHOP}/account/orders` },
    { name: "curl URL globbing [1-3]", cmd: `curl -s -H "Authorization: Bearer lab-token-alice" "${API}/v1/users/[1-3]"` },
    { name: "curl brace list {a,b}", cmd: `curl -s -o /dev/null -w "%{http_code}\\n" "${SHOP}/{login,products,help/contact}"` },
    { name: "shell brace hosts", cmd: `curl -s -o /dev/null -w "%{http_code}\\n" http://{shop,staging}.lab.localhost:${PORT}/.env` },
  ]);

  group("virtual hosts", (): Case[] => [
    { name: "Host header on an IP", cmd: `curl -s -H "Host: admin.lab.localhost" http://127.0.0.1:${PORT}/login` },
    { name: "--resolve", cmd: `curl -s --resolve staging.lab.localhost:${PORT}:127.0.0.1 ${STG}/debug` },
    { name: "a raw request through nc", cmd: `printf 'GET /internal/health HTTP/1.1\\r\\nHost: api.lab.localhost\\r\\nConnection: close\\r\\n\\r\\n' | nc 127.0.0.1 ${PORT}` },
  ]);

  group("variables", (): Case[] => [
    { name: "base variable", cmd: `B=${SHOP}; curl -s $B/login; curl -s "$B/products?id=2"` },
    { name: "token from an earlier response", cmd: `T=$(curl -s -X POST ${API}/v1/auth/login | jq -r .token); curl -s -H "Authorization: Bearer $T" ${API}/v1/orders/1001` },
    { name: "export and ${VAR}", cmd: `export API=${API}; curl -s "\${API}/v1/payments/webhook" -X POST` },
  ]);

  group("loops", (): Case[] => [
    { name: "for over literals", cmd: `for p in robots.txt sitemap.xml static/app.js; do curl -s -o /dev/null -w "$p %{http_code}\\n" ${SHOP}/$p; done` },
    { name: "for over ids", cmd: `for i in 1 2 3; do curl -s -H "Authorization: Bearer lab-token-alice" ${API}/v1/users/$i; echo; done` },
    { name: "seq and a brace range", cmd: `for i in $(seq 1001 1003); do curl -s -o /dev/null -w "$i %{http_code}\\n" -H "Authorization: Bearer lab-token-bob" ${API}/v1/orders/$i; done; for i in {1..2}; do curl -s -o /dev/null "${SHOP}/products?id=$i"; done` },
    { name: "for over $(cat wordlist)", cmd: `for p in $(cat wordlists/paths.txt); do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${SHOP}/$p)"; done` },
    { name: "while read < wordlist", cmd: `while read -r s; do echo "$s $(curl -s -m3 -o /dev/null -w '%{http_code}' "http://$s.lab.localhost:${PORT}/")"; done < wordlists/subdomains.txt` },
    { name: "cat wordlist | while read", cmd: `cat wordlists/paths.txt | while read p; do code=$(curl -s -o /dev/null -w '%{http_code}' ${STG}/$p); [ "$code" != 404 ] && echo "$code /$p"; done` },
    { name: "xargs -I", cmd: `cat wordlists/paths.txt | xargs -I{} curl -s -o /dev/null -w "%{http_code} /{}\\n" ${API}/{}` },
    { name: "nested hosts x paths", cmd: `for h in shop staging; do for p in login debug .env; do echo "$h /$p $(curl -s -o /dev/null -w '%{http_code}' http://$h.lab.localhost:${PORT}/$p)"; done; done`, deadMapped: 1 },
    { name: "a list taken from a live response", cmd: `for p in $(curl -s ${API}/openapi.json | jq -r '.paths | keys[]' | grep -v '{'); do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${API}$p)"; done` },
    { name: "shell function", cmd: `probe(){ curl -s -o /dev/null -w "%{http_code} $1\\n" "${ADMIN}$1"; }; probe /login; probe /users; probe /export` },
    { name: "background jobs and wait", cmd: `for p in login search; do curl -s -o /dev/null ${SHOP}/$p & done; wait; echo done` },
    { name: "loop over absolute URLs in a file", files: { "urls.txt": `${SHOP}/help/contact\n${API}/graphql\n${STG}/robots.txt\n` }, cmd: `while read u; do echo "$(curl -s -o /dev/null -w '%{http_code}' "$u") $u"; done < urls.txt` },
  ]);

  group("scripts", (): Case[] => [
    { name: "a python script already in the project", cmd: `python3 check.py` },
    { name: "a shell script already in the project", cmd: `./list-routes.sh` },
    {
      name: "a script written with Write, run with sh",
      files: { "scan_paths.sh": `#!/bin/sh\nfor h in shop api; do\n  for p in $(cat wordlists/paths.txt) products "search?q=mug"; do\n    echo "$h /$p $(curl -s -m3 -o /dev/null -w '%{http_code} %{size_download}B' "http://$h.lab.localhost:${PORT}/$p")"\n  done\ndone\n` },
      cmd: `sh scan_paths.sh | grep -v ' 404 '`,
    },
    {
      name: "a script with method and path pairs",
      files: { "scan_api.sh": `#!/bin/sh\nAPI=${API}\nTOKEN=lab-token-alice\nfor r in "GET /v1/users/me" "GET /v1/orders?user_id=1&status=open" "POST /v1/auth/reset" "GET /v1/admin/users" "GET /v1/admin/export?format=csv"; do\n  m=\${r%% *}; p=\${r#* }\n  a=$(curl -s -m3 -o /dev/null -w '%{http_code}' -X "$m" "$API$p")\n  b=$(curl -s -m3 -o /dev/null -w '%{http_code}' -X "$m" -H "Authorization: Bearer $TOKEN" "$API$p")\n  echo "$r | anon=$a | token=$b"\ndone\n` },
      cmd: `sh scan_api.sh`,
    },
    { name: "a script written by heredoc, then run", cmd: `cat > probe-tmp.sh <<'EOF'\nfor p in dashboard users export login; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${ADMIN}/$p)"; done\nEOF\nbash probe-tmp.sh` },
    { name: "python -c one-liner", cmd: `python3 -c "import urllib.request as u; print(u.urlopen('${API}/debug/vars').read().decode())"` },
    { name: "python heredoc", cmd: `python3 - <<'EOF'\nimport urllib.request, urllib.error\nbase = "${STG}"\nfor p in ["/debug", "/phpinfo.php", "/backup/", "/nope"]:\n    try:\n        print(p, urllib.request.urlopen(base + p).status)\n    except urllib.error.HTTPError as e:\n        print(p, e.code)\nEOF` },
    {
      name: "a python script reading a wordlist",
      files: { "fuzz.py": `import urllib.request, urllib.error\nBASE = "${ADMIN}"\nfor w in open("wordlists/paths.txt").read().split():\n    try:\n        r = urllib.request.urlopen(f"{BASE}/{w}")\n        print(r.status, "/" + w)\n    except urllib.error.HTTPError as e:\n        if e.code != 404:\n            print(e.code, "/" + w)\n` },
      cmd: `python3 fuzz.py`,
    },
    { name: "node -e fetch", cmd: `node -e "fetch('${API}/internal/health').then(r=>r.text()).then(console.log)"` },
  ]);

  // Stand-ins that make the same requests and print the same lines as the real tools.
  group("scanners", (): Case[] => [
    { name: "ffuf", cmd: `ffuf -u ${SHOP}/FUZZ -w wordlists/paths.txt -mc 200,301,302,403` },
    { name: "gobuster dir", cmd: `gobuster dir -u ${STG} -w wordlists/paths.txt -q` },
    { name: "httpx over subdomains", cmd: `sed 's/$/.lab.localhost:${PORT}/' wordlists/subdomains.txt | httpx -silent -sc -title` },
    { name: "a scanner writing its results to a file", cmd: `ffuf -u ${API}/FUZZ -w wordlists/paths.txt -mc 200,401 > ffuf-api.txt; wc -l ffuf-api.txt` },
  ]);

  group("other tools", (): Case[] => [
    { name: "WebFetch", tool: "WebFetch", input: { url: `${SHOP}/help/contact`, prompt: "What fields does the form have?" }, effect: `curl -s ${SHOP}/help/contact` },
    {
      name: "a browser page whose network log is never listed",
      tool: "mcp__playwright__browser_navigate",
      input: { url: `${SHOP}/` },
      effect: `curl -s ${SHOP}/; curl -s -o /dev/null ${SHOP}/static/app.js`,
      expect: "flagged",
    },
    {
      name: "a browser page, then its network log",
      tool: "mcp__playwright__browser_navigate",
      input: { url: `${SHOP}/` },
      effect: `curl -s ${SHOP}/; curl -s -o /dev/null ${SHOP}/static/app.js; curl -s -o /dev/null "${API}/v1/orders?user_id=2"`,
      then: {
        tool: "mcp__playwright__browser_network_requests",
        input: {},
        output: `[GET] ${SHOP}/ => [200] OK\n[GET] ${SHOP}/static/app.js => [200] OK\n[GET] ${API}/v1/orders?user_id=2 => [401] Unauthorized\n[GET] https://cdn.thirdparty-example.com/analytics.js => [200] OK\n[GET] ${SHOP}/favicon.ico => [404] Not Found`,
      },
    },
    {
      name: "a browser click, then a JSON network log",
      tool: "mcp__chrome-devtools__click",
      input: { uid: "1_4" },
      effect: `curl -s -o /dev/null -X POST ${API}/v1/auth/reset`,
      then: { tool: "mcp__chrome-devtools__list_network_requests", input: {}, output: JSON.stringify({ requests: [{ url: `${API}/v1/auth/reset`, method: "POST", status: 200 }, { url: "https://partner-api.example.net/v2/track", method: "POST", status: 204 }] }, null, 2) },
    },
    {
      name: "an MCP tool given a raw request",
      tool: "mcp__burp__send_http1_request",
      input: { content: `GET /v1/admin/users HTTP/1.1\r\nHost: api.lab.localhost:${PORT}\r\n\r\n`, targetHostname: "api.lab.localhost", targetPort: PORT, usesHttps: false },
      effect: `curl -s ${API}/v1/admin/users`,
    },
    { name: "an MCP tool given a host and a path", tool: "mcp__httpclient__request", input: { host: "admin.lab.localhost", port: PORT, path: "/login", method: "GET" }, effect: `curl -s ${ADMIN}/login` },
    { name: "an MCP tool with no address in its input", tool: "mcp__burp__send_to_repeater", input: { request_id: 14 }, effect: `curl -s "${API}/v1/files/download?path=invoices/1.pdf"`, expect: "flagged" },
    { name: "Bash in the background", cmd: `for p in login search; do curl -s -o /dev/null -w "%{http_code} $p\\n" ${STG}/$p; done`, background: true },
  ]);

  group("commands that fail before (some of) their requests", (): Case[] => [
    { name: "a program that isn't installed", cmd: `no-such-wrapper 5 curl -s ${STG}/debug; curl -s -o /dev/null ${STG}/phpinfo.php` },
    { name: "the shell rejecting an unquoted ?", cmd: `curl -s ${SHOP}/products?id=7; curl -s -o /dev/null ${SHOP}/login` },
    { name: "connection refused, message shown", cmd: `curl -sS http://staging.lab.localhost:1/admin; curl -s -o /dev/null ${STG}/robots.txt` },
    { name: "connection refused, silent curl", cmd: `curl -s http://staging.lab.localhost:1/users`, expect: "clean" },
    { name: "a host that doesn't resolve", cmd: `curl -s http://ghost.lab.localhost:${PORT}/internal/secrets`, fake: { code: 6, stderr: "curl: (6) Could not resolve host: ghost.lab.localhost" }, expect: "clean" },
  ]);

  group("calls that must leave no mark", (): Case[] => [
    { name: "local commands only", cmd: `ls wordlists | head -3; wc -l wordlists/paths.txt; jq -r .openapi <<< '{"openapi":"3"}'`, expect: "clean" },
    { name: "grep for a URL in a file", cmd: `grep -n "lab.localhost" README.md | head -3`, expect: "clean" },
    { name: "denied by permissions, never runs", cmd: `curl -s ${SHOP}/never-requested-one; curl -s ${ADMIN}/never-requested-two`, denied: true, expect: "clean" },
    { name: "an out-of-scope host", cmd: `curl -s https://partner-api.example.net/v2/track`, noexec: true, expect: "violation" },
  ]);

  const EXPLORE = { id: "agent-explore-1", type: "Explore" };
  const GENERAL = { id: "agent-general-1", type: "general-purpose" };
  group("subagents", (): Case[] => [
    { name: "a subagent's request", agent: EXPLORE, cmd: `curl -s "${SHOP}/search?q=mug"` },
    { name: "a subagent's sweep, read from its output", agent: EXPLORE, cmd: `for p in $(cat wordlists/paths.txt); do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${STG}/$p)"; done` },
    { name: "a subagent's script, read from its output", agent: GENERAL, cmd: `python3 check.py` },
    { name: "a subagent's background command", agent: GENERAL, cmd: `for p in login search; do curl -s -o /dev/null -w "%{http_code} $p\\n" ${SHOP}/$p; done`, background: true },
    { name: "a subagent's WebFetch", agent: EXPLORE, tool: "WebFetch", input: { url: `${SHOP}/help/contact`, prompt: "What fields does the form have?" }, effect: `curl -s ${SHOP}/help/contact` },
    { name: "a subagent's call that is denied", agent: EXPLORE, cmd: `curl -s ${SHOP}/never-requested-three`, denied: true, expect: "clean" },
    { name: "a subagent's MCP call that can't be read", agent: GENERAL, tool: "mcp__burp__send_to_repeater", input: { request_id: 15 }, effect: `curl -s ${API}/v1/payments/webhook -X POST`, expect: "flagged" },
  ]);

  it("three agents at once: each result goes to the call that made it", async () => {
    who = {};
    await hub.post("/engagement/new", {});
    lab.clear();
    const calls = [
      { id: "par-main", who: {}, cmd: `curl -s ${ADMIN}/login` },
      { id: "par-explore", who: { agent_id: EXPLORE.id, agent_type: EXPLORE.type }, cmd: `curl -s ${SHOP}/login; curl -s ${API}/openapi.json` },
      // Its second request never leaves: nothing listens on port 1.
      { id: "par-general", who: { agent_id: GENERAL.id, agent_type: GENERAL.type }, cmd: `curl -s ${API}/openapi.json; curl -sS http://staging.lab.localhost:1/admin` },
    ];
    const payload = (c: (typeof calls)[number]) => ({ ...c.who, tool_name: "Bash", tool_use_id: c.id, tool_input: { command: c.cmd } });
    // All three start before any of them finishes…
    for (const c of calls) await hook({ hook_event_name: "PreToolUse", ...payload(c) });
    const results = await Promise.all(calls.map((c) => run("zsh", ["-c", c.cmd], { cwd: proj.dir, env: { PATH: proj.path } })));
    // …and they come back in a different order.
    for (const i of [2, 0, 1]) {
      const [c, r] = [calls[i], results[i]];
      if (r.code === 0) await hook({ hook_event_name: "PostToolUse", ...payload(c), tool_response: { stdout: r.stdout, stderr: r.stderr, interrupted: false, isImage: false } });
      else await hook({ hook_event_name: "PostToolUseFailure", ...payload(c), error: `Exit code ${r.code}\n${r.stdout}${r.stderr}`, is_interrupt: false });
      await hook({ hook_event_name: "PostToolBatch", ...c.who, tool_calls: [{ tool_name: "Bash", tool_use_id: c.id, tool_input: { command: c.cmd }, tool_response: r.stdout.slice(0, 200) }] });
    }
    await sleep(200);
    const state = await hub.state();
    const by = (id: string) => subagentsOf(state.nodes[id] ?? {});
    for (const id of ["endpoint:admin.lab.localhost/login", "endpoint:shop.lab.localhost/login", "endpoint:api.lab.localhost/openapi.json"]) assert.ok(state.nodes[id], `${id} is not on the map`);
    assert.deepEqual(by("endpoint:admin.lab.localhost/login"), [], "the main agent's request");
    assert.deepEqual(by("endpoint:shop.lab.localhost/login"), ["Explore"]);
    assert.deepEqual(by("endpoint:api.lab.localhost/openapi.json"), ["Explore", "general-purpose"], "reached by both subagents");
    // The request that never left is taken off again, without disturbing the other calls' targets.
    assert.ok(!state.nodes["endpoint:staging.lab.localhost/admin"], "an address that was never requested is on the map");
    assert.deepEqual(Object.values(state.nodes).filter((x: any) => /^(endpoint|host|param):/.test(x.id) && x.status === "active").map((x: any) => x.id), []);
    const agents = Object.fromEntries(state.timeline.filter((e: any) => e.type === "tool.call").map((e: any) => [e.toolUseId, e.agent?.type ?? "main"]));
    assert.deepEqual(agents, { "par-main": "main", "par-explore": "Explore", "par-general": "general-purpose" });
  });

  it("exactly the known limits are left listed as not read", () => {
    assert.deepEqual(open, ["a browser page whose network log is never listed", "an MCP tool with no address in its input", "a subagent's MCP call that can't be read"]);
  });
});
