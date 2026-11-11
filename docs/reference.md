# Reference

This page is the exact contract: the five MCP tools the agent can call and every parameter they take, every route on the hub's HTTP and WebSocket API with its method, body and response, the event types that flow through the hub, the node-id conventions that make different sources land on the same target, and the trust model — which source each event comes from and how much weight it carries. It's drawn from `packages/server/src/mcp.ts`, `packages/server/src/hub.ts` and `packages/schema/src/index.ts`.

## MCP tools

The MCP server (`packages/server/src/mcp.ts`) runs over stdio, launched by Claude Code. Each call is forwarded to the hub's `POST /events` as one or more events with the source `mcp`. The server sends the session id `mcp` (or `SPECTRA_SESSION`); the hub attaches events sent under the default `mcp` to the live Claude Code session, so the agent's annotations and findings land in that session's record, replay and report. Every tool returns a short text confirmation; if the hub can't be reached, the error goes to stderr and the tool still returns its confirmation. There is deliberately no tool for scope, operator verdicts or Navigator output.

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
| `category` | string | no | | Grouping key. The dashboard treats `hosts`, `endpoints` and `params` as attack surface (Surface table, always-on labels). |
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

Normalized routes keep the first six path segments, replace numeric segments, UUIDs and long hex strings with `:id`, and replace token-like segments with `:token`. Tool categories are `files` (Read, Edit, MultiEdit, Write, NotebookEdit, LS), `searches` (Glob, Grep), `commands` (Bash, BashOutput), `web` (WebFetch, WebSearch), `agents` (Task, Agent), `mcp` (any `mcp__…` tool) and `other`.

## Hub HTTP API

The hub listens on `http://127.0.0.1:4317` (`SPECTRA_PORT`). Every route refuses requests whose `Origin` header isn't `localhost`, `127.0.0.1` or `[::1]` (any port) with **403** `origin not allowed`; requests with no `Origin` — curl, the hook, the MCP server — are allowed. POST bodies are JSON, up to 1,000,000 characters. Methods other than GET and POST get **405**.

| Method | Path | Purpose |
|---|---|---|
| GET | [`/state`](#get-state) | Current reduced state |
| GET | [`/sessions`](#get-sessions) | Recorded sessions |
| GET | [`/history`](#get-history) | Events, for replay |
| GET | [`/verify`](#get-verify) | Check a session's audit log |
| GET | [`/files`](#get-files) | Files under the scope paths |
| GET | `/*` | The built dashboard |
| POST | [`/hooks`](#post-hooks) | Claude Code hook payloads |
| POST | [`/events`](#post-events) | Agent and demo annotations |
| POST | [`/validator`](#post-validator) | Navigator leads and verdicts |
| POST | [`/import`](#post-import) | Proxy history |
| POST | [`/scope`](#post-scope) | Set the scope |
| POST | [`/review`](#post-review) | Operator verdict on a finding |
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
  scope?: { paths: string[]; hosts: string[]; origin: "config" | "session" };
  violations: ScopeViolation[];           // { id, ts, sessionId, toolUseId, tool, nodeId?, target, severity, summary }
  files: Record<string, { reads: number; writes: number; lastTs: number }>;
  counts: { toolCalls: number; failed: number; firstTs?: number; lastTs?: number };
  timeline: SpectraEvent[];               // the most recent 500 events
}
```

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

Handled events: `SessionStart`, `UserPromptSubmit` (the prompt becomes a thought tagged *operator prompt*), `PreToolUse` (a tool call), `PostToolUse` and `PostToolUseFailure` (its result), `SessionEnd`. The hub turns them into events with the source `hook`. A payload without `session_id` is ignored. Responds **202**.

### POST /events

One event or an array of events (see [Events](#events)) from the MCP server or a script:

```json
[{ "type": "node.upsert", "sessionId": "mcp", "node": { "id": "host:api.example-shop.test", "label": "api.example-shop.test", "kind": "category", "status": "unexplored", "category": "hosts" } }]
```

- The source is forced to `mcp`, unless the event says `"source": "demo"`. Any other source is replaced.
- Events of the hub-only types (`scope.set`, `scope.violation`, `finding.review`, `finding.edit`) and the Navigator-only types (`assessment.upsert`, `finding.assessment`) are silently dropped.
- `ts` defaults to the time of receipt.
- A `finding.upsert` is stamped `reportedBy` with the source.

Responds **202**, including when events were dropped.

### POST /validator

One event or an array, from the Navigator. Only `assessment.upsert` and `finding.assessment` are accepted; anything else is dropped. Events are stamped with the source `validator`; `ts` defaults to the time of receipt.

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
| `node.upsert` | `node` (merged into an existing node with the same id; a `parentId` adds a containment edge) | Hooks, observer, MCP, demos, proxy import |
| `edge.upsert` | `edge` | Hooks, observer, MCP, demos |
| `chain.step` | `step` | MCP, demos |
| `thought` | `text`, `reason?` | Hooks (prompts), observer (reasoning), MCP, proxy import |
| `tool.call` | `toolUseId`, `tool`, `summary`, `nodeId?`, `targets?` | Hooks, observer, demos |
| `tool.result` | `toolUseId`, `ok` | Hooks, observer |
| `finding.upsert` | `finding` (merged by id) | MCP, demos |
| `scope.set` | `scope` | Hub only |
| `scope.violation` | `violation` | Hub only |
| `finding.edit` | `findingId`, `edit` | Hub only |
| `finding.review` | `findingId`, `review` | Hub only, from `POST /review` |
| `assessment.upsert` | `assessment` | Navigator only, via `POST /validator` |
| `finding.assessment` | `findingId`, `assessment` | Navigator only, via `POST /validator` |

A `tool.call`'s `targets` are what scope checks run on: `{ kind: "path" | "host", value, access: "read" | "write" | "exec" | "network", heuristic?, url? }`. `heuristic: true` marks a target pattern-matched out of a shell command.

The hub de-duplicates `tool.call` and `tool.result` by `toolUseId`, and drops the observer's tool events for any session that reports through hooks (keeping its reasoning).

## Sources and trust

Every event carries the source it arrived through, and the hub decides the source — a caller can't claim a more trusted one.

| Source | Arrives through | Provides | Trust |
|---|---|---|---|
| `hook` | `POST /hooks`, from Claude Code's hooks | Tool calls and results, your prompts, session start and end | **Ground truth** — what actually ran |
| `observer` | The hub reading Claude Code's transcripts | Tool calls and results, the agent's reasoning | **Ground truth** |
| `mcp` | `POST /events` (default) | Discoveries, links, chain steps, findings, thoughts | **Claims** — the agent's word; findings are labelled *agent-reported* |
| `demo` | `POST /events` with `"source": "demo"` | Scripted sessions | **Claims** — a script's word |
| `proxy` | `POST /import` | Hosts, endpoints and parameter names | **Observed traffic** — what crossed the wire, not what the agent did |
| `validator` | `POST /validator` | Leads and finding verdicts | **Advice** — a second model's read |
| `operator` | `POST /review`, `POST /scope` | Finding verdicts and scope changes | **Authority** — yours |
| `hub` | The hub itself | Scope from the config file or session directories, scope violations, linked fix edits | **Derived** — the hub's own records |

Channel rules the hub enforces:

- `/events` can't produce scope, violations, reviews, fix links, leads or verdicts.
- `/validator` can only produce leads and verdicts.
- `/hooks` can only produce what the hook translator emits from a hook payload.

These rules separate the channels; they don't authenticate the caller. Any local process can post to any route. See [Security](security.md#trust-tiers).

---

**Next:** [Security](security.md)
