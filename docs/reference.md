# Reference

This page is the exact contract: the five MCP tools the agent can call and every parameter they take, every route on the hub's HTTP and WebSocket API with its method, body and response, the event types that flow through the hub, the node-id conventions that make different sources land on the same target, the rules behind the automatic surface tags, and the trust model — which source each event comes from and how much weight it carries. It's drawn from `packages/server/src/mcp.ts`, `packages/server/src/hub.ts` and `packages/schema/src/index.ts`. The [unread actions](interpreter.md) the hub keeps track of, and the Interpreter that reads them, have their own routes, events and source, listed here too.

## MCP tools

The MCP server (`packages/server/src/mcp.ts`) runs over stdio, launched by Claude Code. Each call is forwarded to the hub's `POST /events` as one or more events with the source `mcp`. The server sends the session id `mcp` (or `SPECTRA_SESSION`); the hub attaches events sent under the default `mcp` to the live Claude Code session, so the agent's annotations and findings land in that session's record, replay and report. Every tool returns a short text confirmation; if the hub can't be reached, the error goes to stderr and the tool still returns its confirmation. There is deliberately no tool for scope, operator verdicts, triage marks, unread actions or Navigator output.

Register it from the Spectra root:

```bash
claude mcp add spectra -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/packages/server/src/mcp.ts"
```

### `map_target`

Add or update a target on the attack-surface map — a host, subdomain, API endpoint, parameter or module. Link it to a parent to build the tree (domain → subdomain → endpoint → parameter).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes | | Stable id. Reusing an id updates that target. See [Node ids](#node-ids). |
| `label` | string | yes | | Display name. |
| `kind` | `root` \| `category` \| `leaf` | no | `leaf` | Node kind. |
| `status` | `unexplored` \| `active` \| `complete` | no | `active` | Status, shown as grey, orange or green. |
| `parentId` | string | no | | Parent target's id. Draws a containment edge. |
| `category` | string | no | | Grouping key. The dashboard treats `hosts`, `endpoints` and `params` as attack surface (Surface table, the Graph's Surface layer, tags, always-on labels). |
| `importance` | integer 1–5 | no | | Shown as importance bars; sorts **Activity → Objects**. |
| `note` | string | no | | Why it matters. Also posted as a thought (reason `node <id>`) in the activity stream. |

Emits `node.upsert`, plus `thought` when `note` is given. Returns `mapped <id>`.

### `link_nodes`

Draw a labelled relationship between two targets (for example an endpoint → a parameter it reflects, or a subdomain → a login it exposes).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `source` | string | yes | Id of the source target. |
| `target` | string | yes | Id of the target it points to. |
| `label` | string | no | Edge label, shown on the graph above 80% zoom. |

Emits `edge.upsert` with the id `<source>=><target>`. Returns `linked <source> → <target>`.

### `update_chain`

Add a step to an attack chain: how smaller observations connect into a vulnerability.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `chainId` | string | no | `main` | Which chain the step belongs to. |
| `id` | string | yes | | Step id. Reusing it updates the step. |
| `title` | string | yes | | Short title shown in the Chain panel. |
| `detail` | string | no | | Longer text, shown on hover. |
| `nodeIds` | string[] | no | | Targets this step refers to. Clicking the step opens the first. |
| `after` | string[] | no | | Ids of the steps this one follows; draws arrows from them. |
| `confirmed` | boolean | no | | Marks the step confirmed (green bar). |

Emits `chain.step`. Returns `chain <chainId>: <id>`.

### `report_finding`

Report or update a suspected vulnerability on an in-scope target. Link the chain steps and targets that support it.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `id` | string | yes | | Stable id. Reuse it to update the same finding. |
| `title` | string | yes | | |
| `severity` | `info` \| `low` \| `medium` \| `high` \| `critical` | yes | | |
| `confidence` | number 0–1 | yes | | The agent's confidence the finding is real. |
| `status` | `suspected` \| `confirmed` \| `dismissed` \| `fixed` | no | `suspected` | The agent's own status claim. |
| `description` | string | no | | What's wrong, why it matters, how to fix it. |
| `file` | string | no | | File location. Edits to this file are linked to the finding as remediation. An absolute path matches exactly; a relative one matches any file ending in it. |
| `line` | integer | no | | Line number, used with `file`. |
| `nodeIds` | string[] | no | | Targets that support the finding. |
| `stepIds` | string[] | no | | Chain step ids that led here, in order. Shown as the evidence trail. |

Emits `finding.upsert`; the hub marks it `reportedBy: "mcp"` (shown as *agent-reported*). Returns `finding <id> recorded`.

### `log_thought`

Explain to the operator why the agent is changing direction or what it will probe next.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The note. |
| `reason` | string | no | A short tag shown before the text. |

Emits `thought`. Returns `noted`.

## Node ids

Targets are keyed by id, and an event with an existing id updates that target. The hub builds ids from the agent's traffic and from proxy history the same way, so the same endpoint is one node whichever source saw it. To have `map_target` land on the same nodes, use the same scheme:

| Target | Id | Example |
|---|---|---|
| Session root | `root:<session-id>` | `root:3f2a…` |
| Tool category | `root:<session-id>:<category>` | `root:3f2a…:files` |
| Tool-call leaf | `<category>:<main argument>` | `files:/path/to/target-repo/src/app.ts` |
| Domain | `domain:<registrable domain>` | `domain:example-shop.test` |
| Subdomain | `host:<hostname>` | `host:api.example-shop.test` |
| Endpoint | `endpoint:<hostname><normalized route>` | `endpoint:api.example-shop.test/api/users/:id` |
| Parameter | `param:<hostname><normalized route>?<name>` | `param:api.example-shop.test/api/users/:id?role` |
| Proxy-import root | `import:<file-name slug>` | `import:history.har` |

Normalized routes keep the first six path segments, replace numeric segments, UUIDs and long hex strings with `:id`, and replace token-like segments with `:token`. A fuzzer's placeholder in a shell command's URL (`FUZZ`, `FUZ2Z` and the like) is never mapped as a segment: the URL up to the placeholder is used, or the URL without its query string when the placeholder is in a query value. Targets read out of command output — by the local URL scan or the Interpreter — use the same ids, so one found in output and later requested by the agent is one node. Tool categories are `files` (Read, Edit, MultiEdit, Write, NotebookEdit, LS), `searches` (Glob, Grep), `commands` (Bash, BashOutput), `web` (WebFetch, WebSearch), `agents` (Task, Agent), `mcp` (any `mcp__…` tool) and `other`.

## Hub HTTP API

The hub listens on `http://127.0.0.1:4317` (`SPECTRA_PORT`). Every route refuses requests whose `Origin` header isn't `localhost`, `127.0.0.1` or `[::1]` (any port) with **403** `origin not allowed`; requests with no `Origin` — curl, the hook, the MCP server — are allowed. POST bodies are JSON, up to 1,000,000 characters. Methods other than GET and POST get **405**.

| Method | Path | Purpose |
|---|---|---|
| GET | [`/state`](#get-state) | Current reduced state |
| GET | [`/sessions`](#get-sessions) | Recorded sessions |
| GET | [`/history`](#get-history) | Events, for replay |
| GET | [`/verify`](#get-verify) | Check a session's audit log |
| GET | [`/files`](#get-files) | Files under the scope paths |
| GET | [`/settings`](#get-settings) | Navigator and Interpreter settings and status, without the key |
| GET | [`/health`](#get-health) | What's connected, for the setup checklist |
| GET | `/*` | The built dashboard |
| POST | [`/hooks`](#post-hooks) | Claude Code hook payloads |
| POST | [`/events`](#post-events) | Agent and demo annotations |
| POST | [`/validator`](#post-validator) | Navigator leads and verdicts |
| POST | [`/import`](#post-import) | Proxy history |
| POST | [`/scope`](#post-scope) | Set the scope |
| POST | [`/review`](#post-review) | Operator verdict on a finding |
| POST | [`/triage`](#post-triage) | Operator's triage mark on a target |
| POST | [`/actions/resolve`](#post-actionsresolve) | Dismiss an unread action, or all of them |
| POST | [`/engagement/new`](#post-engagementnew) | Clear the live map and start a new engagement |
| POST | [`/settings`](#post-settings) | Change the Navigator's key, model or on/off, or the Interpreter's mode |
| POST | [`/navigator/test`](#post-navigatortest) | Check the saved key and model |
| WS | [`/ws`](#ws-ws) | Live state stream |

### GET /state

Returns the current `GraphState`:

```ts
{
  sessionId?: string;                     // most recent session to start
  nodes: Record<string, MapNode>;         // { id, label, kind, status, category?, parentId?, importance?, outOfScope?, meta? }
  edges: Record<string, MapEdge>;         // { id, source, target, label? }
  chain: Record<string, ChainStep>;       // { id, chainId, title, detail?, nodeIds?, after?, confirmed? }
  findings: Record<string, Finding>;      // includes review?, assessment?, edits?, reportedBy?, sessionId?
  assessments: Record<string, Assessment>;// Navigator leads, keyed "nav:<nodeId>"
  triage: Record<string, Triage>;         // operator's marks, keyed by node id: { state, note?, ts }
  actions: Record<string, OpaqueAction>;  // tool calls the hub couldn't read, keyed by tool-use id
  scope?: { paths: string[]; hosts: string[]; origin: "config" | "session" };
  violations: ScopeViolation[];           // { id, ts, sessionId, toolUseId, tool, nodeId?, target, severity, summary }
  files: Record<string, { reads: number; writes: number; lastTs: number }>;
  counts: { toolCalls: number; failed: number; firstTs?: number; lastTs?: number };
  timeline: SpectraEvent[];               // the most recent 500 events
}
```

A triage `state` is `queued` (shown as *To test*), `testing`, `tested` or `skipped` (*Skip*). [Surface tags](#surface-tags) aren't part of the state; they're computed from names when shown.

An `OpaqueAction` is one [unread action](interpreter.md#what-spectra-can-read-on-its-own):

```ts
{
  toolUseId: string;
  sessionId: string;
  ts: number;
  tool: string;
  summary: string;        // the command or call, as shown in Activity
  nodeId?: string;        // the call's node on the map
  reason: string;         // why the hub couldn't read it
  resolution?: "interpreted" | "nothing" | "dismissed" | "failed";  // absent while it's open
  resolvedBy?: string;    // the source of the event that settled it: "interpreter" or "operator"
  resolvedTs?: number;
  note?: string;          // one line from whoever settled it
  added?: number;         // targets the Interpreter put on the map
  ignored?: number;       // candidates it left off: out of scope, or not shown by the material
}
```

The state holds only this record. The action's output is kept in the hub's memory and isn't part of the state, the history or the audit log.

Targets read out of command output are ordinary nodes with these `meta` properties: `seen in: "command output"`, `read by: "url scan"` or `"interpreter"`, and for an endpoint `host`, `example`, and — from the Interpreter — `methods`, `status codes` and `evidence` when it had them.

### GET /sessions

Returns the recorded sessions from the audit log, most recently updated first:

```json
[{ "id": "3f2a…", "events": 0, "bytes": 21761, "updated": 1794430185300.36 }]
```

`events` isn't counted here and is always `0`; `GET /verify` returns the count. Returns `[]` when the audit log is off.

### GET /history

| Query | Returns |
|---|---|
| `?session=<id>` | Every event in that session's audit log, in order, with the chain fields removed. With the audit log off, the matching events from memory. |
| (none) | Every event the hub has seen since it started (the most recent 50,000), across all sessions. |

### GET /verify

`?session=<id>` checks that session's hash-chained log and returns:

```json
{ "ok": true, "events": 52, "head": "c5a9a562…" }
{ "ok": false, "events": 12, "head": "…", "badLine": 13, "reason": "hash mismatch (line contents were changed)" }
```

Without a session: `{ "ok": false, "events": 0, "reason": "no session given" }`. With the audit log off: `reason: "audit log disabled"`. See [Security → The audit log](security.md#the-audit-log) for the failure reasons.

### GET /files

Lists the files under each scope path, for the Files view:

```json
[{ "root": "/path/to/target-repo", "files": ["/path/to/target-repo/src/app.ts"], "truncated": false }]
```

Skips `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, `__pycache__`, `.venv`, `venv`, `target` and `coverage`, doesn't follow symlinks, and stops at 20,000 files per root (`truncated: true`).

### GET /settings

The Navigator's and the Interpreter's settings as the dashboard may see them, and the status of each in the hub. The API key itself is never returned — only whether one is available, where it comes from, and its last four characters.

```json
{
  "navigator": {
    "enabled": true,
    "model": "claude-opus-5-5",
    "hasKey": true,
    "keySource": "settings",
    "keyHint": "…abcd",
    "status": { "state": "idle", "model": "claude-opus-5-5", "runs": 3, "lastRun": 1794430185300, "lastPosted": 7 }
  },
  "interpreter": {
    "mode": "unread",
    "status": { "state": "idle", "model": "claude-opus-5-5", "read": 12, "queued": 0, "lastRun": 1794430185300 },
    "waiting": 0
  }
}
```

| Field | Meaning |
|---|---|
| `enabled` | Whether **Run the Navigator in the hub** is on. |
| `model` | The saved model, else `SPECTRA_VALIDATOR_MODEL` in the hub's environment, else `claude-opus-5-5`. |
| `hasKey` | A key is saved, or `ANTHROPIC_API_KEY` is set in the hub's environment. |
| `keySource` | `"settings"`, `"environment"` or `null`. |
| `keyHint` | `…` and the key's last four characters, or `null`. |
| `status.state` | `off`, `idle` (shown as *Running*), `assessing` or `error` (shown as *Stopped*). See [Navigator → States](navigator.md#states). |
| `status.runs`, `lastRun`, `lastPosted` | Assessments completed since the Navigator last started, the time of the last one, and how many leads and verdicts it posted. |
| `status.lastError` | The most recent error, when there is one. |

The `interpreter` object:

| Field | Meaning |
|---|---|
| `mode` | `off`, `unread` (actions Spectra can't read) or `all` (those, and any output that lists paths). It's the saved setting: it can say `unread` while `status.state` is `off`, when no key is available. |
| `status.state` | `off` (not running), `idle` (shown as *Running*), `reading` (a model call is in flight) or `error` (shown as *Stopped*). See [Interpreter → States and failures](interpreter.md#states-and-failures). |
| `status.model` | The model it uses — the Navigator's. |
| `status.read`, `queued`, `lastRun` | Actions read since the Interpreter last started, actions waiting in its queue, and the time of the last successful request. |
| `status.lastError` | The most recent error, when there is one. |
| `waiting` | Open unread actions whose output the hub still holds — what turning the Interpreter on would read. |

### GET /health

What has reached the hub, for the [setup checklist](dashboard.md#setup-checklist):

```json
{
  "hub": { "startedAt": 1794430100000, "events": 84 },
  "scope": { "set": true, "origin": "config", "paths": 1, "hosts": 4 },
  "hooks": { "lastSeen": 1794430185300, "sessions": 1 },
  "observer": { "enabled": true },
  "mcp": { "lastSeen": null },
  "proxy": { "lastImport": 1794430170000 },
  "navigator": { "enabled": true, "model": "claude-opus-5-5", "hasKey": true, "keySource": "settings", "keyHint": "…abcd", "status": { "state": "idle", "model": "claude-opus-5-5", "runs": 1 }, "externalLastSeen": null },
  "interpreter": { "mode": "off", "status": { "state": "off", "model": "claude-opus-5-5", "read": 0, "queued": 0 }, "waiting": 2 },
  "actions": { "total": 41, "unread": 5, "open": 2 },
  "audit": { "enabled": true, "dir": "~/.spectra/sessions" },
  "engagement": { "started": 1794420000000, "sessions": 2, "restored": { "events": 84, "sessions": 2 } }
}
```

- `scope` is `{ "set": false }` before any scope exists; `paths` and `hosts` are counts.
- `hooks.lastSeen`, `mcp.lastSeen` and `proxy.lastImport` are the times of the last hook payload, the last `mcp`-sourced post to `/events`, and the last `POST /import` since the hub started, or `null`. `hooks.sessions` counts the sessions that have reported through hooks.
- `engagement` is when the current [engagement](dashboard.md#engagement) began, how many sessions are in it, and what was restored from the audit logs when the hub started (`restored` is `null` if nothing was). The whole field is `null` with the audit log off.
- `navigator` is the same object as in `GET /settings`, plus `externalLastSeen`: the last time anything was accepted on `POST /validator` — a separate `npm run validator` process, or a demo.
- `interpreter` is the same object as in `GET /settings`.
- `actions.total` is every tool call recorded on the live map; `unread` is how many of them the hub couldn't read on its own, settled or not; `open` is how many of those are still unsettled.
- `audit.dir` is `null` when the audit log is off; your home directory is shortened to `~`.

### GET /*

Any other GET path serves the built dashboard from `packages/web/dist`, falling back to `index.html`. If the dashboard hasn't been built, it returns **404** `dashboard not built: run npm run build`.

### POST /hooks

A Claude Code hook payload, as sent by `packages/server/bin/spectra-hook.mjs`:

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "3f2a…",
  "cwd": "/path/to/target-repo",
  "tool_name": "Read",
  "tool_use_id": "toolu_…",
  "tool_input": { "file_path": "/path/to/target-repo/src/app.ts" },
  "ok": true
}
```

`prompt` is included for `UserPromptSubmit` and `reason` for `SessionEnd`.

`output` is included on `PostToolUse` and `PostToolUseFailure` for `Bash`, `BashOutput`, `WebFetch` and MCP tools other than Spectra's own: the call's output as one string, capped by the hook at the first 8,000 and last 4,000 characters, and never sent for any other tool. `SPECTRA_HOOK_OUTPUT=0` in Claude Code's environment leaves it out. The hub reads at most 20,000 characters of it, scans it for in-scope URLs, and keeps it in memory only while the call is an open unread action — see [Interpreter → Tool output](interpreter.md#tool-output). It's never recorded as an event.

Handled events: `SessionStart`, `UserPromptSubmit` (the prompt becomes a thought tagged *operator prompt*), `PreToolUse` (a tool call), `PostToolUse` (its result) and `PostToolUseFailure` (its result, always a failure), `SessionEnd`. These are the six events `npm run hooks:install` registers. The hub turns them into events with the source `hook` — including an `action.open` for a tool call it can't read. Targets the local scan finds in `output` are recorded with the source `hub`. A payload without `session_id` is ignored. Responds **202**.

### POST /events

One event or an array of events (see [Events](#events)) from the MCP server or a script:

```json
[{ "type": "node.upsert", "sessionId": "mcp", "node": { "id": "host:api.example-shop.test", "label": "api.example-shop.test", "kind": "category", "status": "unexplored", "category": "hosts" } }]
```

- The source is forced to `mcp`, unless the event says `"source": "demo"`. Any other source is replaced.
- Events of the hub-only types (`scope.set`, `scope.violation`, `finding.review`, `finding.edit`, `target.triage`, `action.open`, `action.resolve`) and the Navigator-only types (`assessment.upsert`, `finding.assessment`) are silently dropped.
- `ts` defaults to the time of receipt.
- A `finding.upsert` is stamped `reportedBy` with the source.

Responds **202**, including when events were dropped.

### POST /validator

One event or an array, from a Navigator running as a separate process (`npm run validator`). The Navigator in the hub doesn't use this route; it publishes the same two event types directly. Only `assessment.upsert` and `finding.assessment` are accepted; anything else is dropped. Events are stamped with the source `validator`; `ts` defaults to the time of receipt.

```json
[
  { "type": "assessment.upsert", "sessionId": "3f2a…", "assessment": { "id": "nav:endpoint:api.example-shop.test/api/users/:id", "nodeId": "endpoint:api.example-shop.test/api/users/:id", "title": "User profile by id", "bugClass": "idor", "confidence": 0.71, "recommendation": "pursue", "rationale": "…", "ts": 1794430185300 } },
  { "type": "finding.assessment", "sessionId": "3f2a…", "findingId": "F-1", "assessment": { "verdict": "corroborated", "confidence": 0.86, "rationale": "…", "ts": 1794430185300 } }
]
```

Responds **202**.

### POST /import

Proxy history, already reduced by the client:

```json
{
  "entries": [{ "method": "GET", "url": "https://api.example-shop.test/api/cart", "status": 200, "mime": "application/json", "params": ["coupon"] }],
  "label": "history.har",
  "includeStatic": false
}
```

| Field | Notes |
|---|---|
| `entries` | Required array. Up to 5,000 per request; entries without an `http(s)` URL, or with a URL over 4,096 characters, are skipped. Query strings and fragments are stripped. Up to 40 `params` names of up to 80 characters. |
| `label` | Shown on the import's root node and in the summary. Default `proxy history`. |
| `includeStatic` | `true` keeps static assets. |

Responds **200** with an `ImportSummary`:

```json
{
  "requests": 10, "imported": 7, "endpoints": 6, "newEndpoints": 6, "params": 6,
  "skippedStatic": 1, "skippedOutOfScope": 2,
  "outOfScopeHosts": ["www.googletagmanager.com", "api.segment.io"],
  "hint": "…only when nothing was in scope…"
}
```

**400** `expected { entries: [...] }` if `entries` isn't an array. See [Proxy import](proxy-import.md).

### POST /scope

Sets the scope:

```json
{ "paths": ["/path/to/target-repo"], "hosts": ["example-shop.test"] }
```

Paths are expanded (`~`) and resolved; hosts are lowercased and loopback is added. A list you leave out keeps its current value, so `{ "hosts": [...] }` alone changes only the hosts. Posting `paths` makes the scope's origin `config`, so sessions no longer add their working directories; leaving them out keeps the current origin. Recorded as a `scope.set` event (source `operator`) in every open session's audit log. Responds **202**.

### POST /review

Your verdict on a finding:

```json
{ "findingId": "F-1", "verdict": "verified", "note": "Reproduced with a second account." }
```

`verdict` is `verified`, `rejected` or `needs-info`; `note` is optional (up to 2,000 characters). Recorded as a `finding.review` event with the source `operator`. Responds **202**, or **400** `unknown finding or verdict`.

### POST /triage

Your triage mark on a target:

```json
{ "nodeId": "endpoint:api.example-shop.test/api/users/:id", "state": "queued", "note": "Try with a second account." }
```

| Field | Notes |
|---|---|
| `nodeId` | Required. The id of a target on the map. |
| `state` | `queued`, `testing`, `tested` or `skipped`. `null`, or leaving it out, clears the mark and its note. |
| `note` | Optional, up to 2,000 characters. Each post replaces the whole mark, so send the note again to keep it. |

Recorded as a `target.triage` event with the source `operator`, under the most recent session (or the id `operator` if no session has started). Responds **202**, or **400** `unknown target or state`.

### POST /actions/resolve

Dismisses an open [unread action](dashboard.md#actions), or all of them:

```json
{ "toolUseId": "toolu_…", "note": "Local build, nothing to map." }
{ "all": true }
```

| Field | Notes |
|---|---|
| `toolUseId` | The tool-use id of one open action — a key of `actions` in [`GET /state`](#get-state). |
| `all` | `true` dismisses every open action. When it's set, `toolUseId` is ignored. |
| `note` | Optional, up to 500 characters. Applied to each action dismissed. |

Each one is recorded as an `action.resolve` event with the resolution `dismissed` and the source `operator`, in the action's own session, and its output is dropped from the hub's memory. Responds **200** with the number dismissed:

```json
{ "resolved": 1 }
```

An id that's unknown or already settled isn't an error: the response is `{ "resolved": 0 }`.

### POST /engagement/new

Clears the live map and starts a new [engagement](dashboard.md#engagement). Takes an empty JSON object (`{}`). Every connected dashboard receives a fresh snapshot; the scope goes back to the config file's. Audit logs aren't touched. Responds **202**.

### POST /settings

Changes the Navigator's settings, the Interpreter's mode, or both. Send only the fields you want to change:

```json
{ "navigator": { "apiKey": "sk-ant-...", "model": "claude-opus-5-5", "enabled": true }, "interpreter": { "mode": "unread" } }
```

| Field | Notes |
|---|---|
| `apiKey` | A string of up to 400 characters with no whitespace. An empty string clears the saved key. |
| `model` | Up to 80 characters: letters, digits, `_`, `.`, `:` and `-`. An empty string clears the saved model, going back to the default. |
| `enabled` | `true` or `false`. The Navigator only runs when it's enabled **and** a key is available. |
| `interpreter.mode` | `off`, `unread` or `all`. The Interpreter only runs when a mode other than `off` is set **and** a key is available. It uses `navigator.apiKey` and `navigator.model`. |

A field that fails its check is ignored, not rejected. The settings are written to the [settings file](configuration.md#the-settings-file). A change to any `navigator` field restarts the Navigator in the hub; a change to the key, the model or the mode restarts the Interpreter, which then reads any unread actions whose output the hub still holds. Responds **200** with the same body as [`GET /settings`](#get-settings) — the key is never echoed back.

### POST /navigator/test

Sends one tiny request to the Anthropic API with the saved key and model (or the ones in the hub's environment). The body is ignored, but must be valid JSON — send `{}`. Responds **200**:

```json
{ "ok": true }
{ "ok": false, "error": "The API key was rejected." }
```

Without a key it answers `{ "ok": false, "error": "Add an API key first." }` and makes no request.

### Errors

| Status | When |
|---|---|
| 400 | The body isn't valid JSON (the response is the parse error), is over the size limit (`body too large`), or fails a route's checks. |
| 403 | `origin not allowed`. |
| 404 | Unknown POST path. |
| 405 | Any method other than GET or POST. |

### WS /ws

Connect to `ws://127.0.0.1:4317/ws`. The same origin rule applies. On connect the hub sends a snapshot, then one message per event:

```ts
{ kind: "snapshot", state: GraphState }
{ kind: "event", event: SpectraEvent }
```

Apply each event to the snapshot with `applyEvent` from `@spectra/schema` to keep the same state the dashboard and Navigator see. The socket is read-only; messages sent to it are ignored.

## Events

Every event has `ts` (milliseconds since the epoch), `sessionId`, `source` and `type`.

| Type | Fields | Produced by |
|---|---|---|
| `session.start` | `cwd?`, `title?` | Hooks, observer, demos |
| `session.end` | `reason?` | Hooks |
| `node.upsert` | `node` (merged into an existing node with the same id; a `parentId` adds a containment edge) | Hooks, observer, MCP, demos, proxy import, the local URL scan, the Interpreter |
| `edge.upsert` | `edge` | Hooks, observer, MCP, demos, the local URL scan, the Interpreter |
| `chain.step` | `step` | MCP, demos |
| `thought` | `text`, `reason?` | Hooks (prompts), observer (reasoning), MCP, proxy import |
| `tool.call` | `toolUseId`, `tool`, `summary`, `nodeId?`, `targets?` | Hooks, observer, demos |
| `tool.result` | `toolUseId`, `ok` | Hooks, observer |
| `finding.upsert` | `finding` (merged by id) | MCP, demos |
| `scope.set` | `scope` | Hub only |
| `scope.violation` | `violation` | Hub only |
| `finding.edit` | `findingId`, `edit` | Hub only |
| `finding.review` | `findingId`, `review` | Hub only, from `POST /review` |
| `target.triage` | `nodeId`, `triage` (`{ state, note?, ts }`, or `null` to clear the mark) | Hub only, from `POST /triage` |
| `action.open` | `action` (`{ toolUseId, tool, summary, nodeId?, reason }`) | Hub only: written as a tool call arrives through hooks or the observer and can't be read, or by the hub itself when the Interpreter's `all` mode picks up a call's output |
| `action.resolve` | `toolUseId`, `resolution` (`interpreted`, `nothing`, `dismissed` or `failed`), `note?`, `added?`, `ignored?` | Hub only: the Interpreter in the hub, or `POST /actions/resolve` |
| `assessment.upsert` | `assessment` | Navigator only: the Navigator in the hub, or `POST /validator` |
| `finding.assessment` | `findingId`, `assessment` | Navigator only: the Navigator in the hub, or `POST /validator` |

A `tool.call`'s `targets` are what scope checks run on: `{ kind: "path" | "host", value, access: "read" | "write" | "exec" | "network", heuristic?, url? }`. `heuristic: true` marks a target pattern-matched out of a shell command.

The hub de-duplicates `tool.call` and `tool.result` by `toolUseId`, and drops the observer's tool events for any session that reports through hooks (keeping its reasoning).

An `action.open` for a tool-use id that already has an action is ignored: the first reason stands, and a settled action isn't reopened. An `action.resolve` for an unknown id does nothing. A `node.upsert` from hooks or the observer on a node marked `seen in: "command output"` removes its `seen in` and `read by` properties: the agent has now requested it.

## Surface tags

Tags are labels for hosts and endpoints, computed from names by `surfaceTags(route, host)` in `@spectra/schema`. They aren't events and aren't stored in the state or the audit log: the dashboard and the report work them out each time, so a change to the rules applies to old sessions too.

The eleven tags are `api`, `graphql`, `auth`, `admin`, `internal`, `exposed`, `docs`, `files`, `payments`, `webhook` and `object-id`. Each has a pattern for the route, the hostname, or both; a target gets every tag whose pattern matches, compared in lower case.

| Target | Tagged from |
|---|---|
| Endpoint | Its route (the node's label) and its host (its parent's label). |
| Domain or subdomain | Its hostname only. |
| Parameter | Nothing of its own; it takes its endpoint's tags. |

[Dashboard → Tags](dashboard.md#tags) lists what each tag matches. Tags are heuristics for sorting and filtering, not findings.

## Sources and trust

Every event carries the source it arrived through, and the hub decides the source — a caller can't claim a more trusted one.

| Source | Arrives through | Provides | Trust |
|---|---|---|---|
| `hook` | `POST /hooks`, from Claude Code's hooks | Tool calls and results, your prompts, session start and end | **Ground truth** — what actually ran |
| `observer` | The hub reading Claude Code's transcripts | Tool calls and results, the agent's reasoning | **Ground truth** |
| `mcp` | `POST /events` (default) | Discoveries, links, chain steps, findings, thoughts | **Claims** — the agent's word; findings are labelled *agent-reported* |
| `demo` | `POST /events` with `"source": "demo"` | Scripted sessions | **Claims** — a script's word |
| `proxy` | `POST /import` | Hosts, endpoints and parameter names | **Observed traffic** — what crossed the wire, not what the agent did |
| `validator` | The Navigator in the hub, or `POST /validator` | Leads and finding verdicts | **Advice** — a second model's read |
| `interpreter` | The Interpreter in the hub; no route | Targets read out of command output, and the settling of the actions it read | **Inference** — a model's reading of what a command printed, checked in code; not observed traffic |
| `operator` | `POST /review`, `POST /scope`, `POST /triage`, `POST /actions/resolve`, `POST /engagement/new` | Finding verdicts, scope changes, triage marks, dismissed actions and clearing the map | **Authority** — yours |
| `hub` | The hub itself | Scope from the config file or session directories, scope violations, linked fix edits, actions opened in the Interpreter's `all` mode | **Derived** — the hub's own records |
| `hub` | The hub's local URL scan of forwarded output | In-scope URLs printed in command output: hosts, endpoints and parameter names | **Inference** — found in output, not in a request; marked `read by: url scan` |

Channel rules the hub enforces:

- `/events` can't produce scope, violations, reviews, triage marks, fix links, unread-action records, leads or verdicts.
- `/validator` can only produce leads and verdicts.
- `/hooks` can only produce what the hook translator emits from a hook payload, plus the unmapped targets the local scan finds in its `output`.
- No route produces `interpreter` events. The Interpreter can only add unmapped, in-scope targets and settle the actions it read.

These rules separate the channels; they don't authenticate the caller. Any local process can post to any route. See [Security](security.md#trust-tiers).

---

**Next:** [Security](security.md)
