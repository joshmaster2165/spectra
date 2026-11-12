# Security

Spectra watches an AI agent do security testing, so it handles sensitive material — commands, URLs, file paths, your prompts — and its records may later serve as evidence of what happened. This page describes how it protects that material and where the protection stops: the hub is local-only and refuses other web origins; every event is labelled with a source that's trusted differently; scope checks flag boundary crossings but have known blind spots; and a hash-chained audit log makes after-the-fact edits detectable. It also covers what happens to command output — what the hook forwards, what the opt-in Interpreter sends to a model, and how that model's answers are checked against hostile text — how the Navigator's API key is kept, lists what is stored where and how to clear it, and gives the rules for responsible use. To report a vulnerability in Spectra itself, see [SECURITY.md](../SECURITY.md).

## Local only

- **Loopback binding.** The hub listens on `127.0.0.1` only. Nothing on your network can reach it.
- **Origin checks.** Every HTTP request and every WebSocket connection carrying an `Origin` header is refused unless the origin's host is `localhost`, `127.0.0.1` or `[::1]`. A web page on any other site can't read the agent's activity from the hub or post events to it, even though your browser can reach `127.0.0.1`. Requests without an `Origin` — curl, the hook, the MCP server, the importer — are allowed.
- **What leaves your machine.** Two parts send Spectra data anywhere, both to the Anthropic API and both opt-in: the [Navigator](navigator.md), which sends a digest of the map, and the [Interpreter](interpreter.md), which sends commands and part of their output. By default the hub makes no outbound connections. It makes them only when you turn the Navigator or the Interpreter on in Settings, where the hub itself calls the Anthropic API, and once each time you click **Test connection**. Run the Navigator with `npm run validator` instead and that process makes the Navigator's calls, not the hub; the Interpreter always runs in the hub. The demos and the proxy importer only talk to your local hub. The dashboard's stylesheet loads its fonts from Google Fonts, so your browser fetches those.

## Observation, not control

Spectra never drives the agent: it sends no prompts and approves no tools. The hook is built so it can't interfere with Claude Code — it never writes to stdout, always exits 0, and gives up on the hub after 300 ms. The Interpreter, like the Navigator, only reads: neither has any way to act on the target or on the agent. Scope checks **flag**; they don't block. Staying in scope is the operator's job: treat every red flag as a stop sign.

## Trust tiers

Every event carries the source it came through, and the hub — not the caller — decides it:

| Tier | Sources | Meaning |
|---|---|---|
| Ground truth | `hook`, `observer` | What Claude Code actually ran. |
| Claims | `mcp`, `demo` | What the agent (or a script) says. Findings are shown as *agent-reported*. |
| Observed traffic | `proxy` | What crossed the wire, per imported proxy history. |
| Inference | `interpreter`, and `hub` for the local URL scan | Targets read out of a command's output: by a model (the Interpreter) or by the hub's own scan for URLs. A reading of what was printed — not a request anyone saw. |
| Advice | `validator` | The Navigator's leads and verdicts. |
| Authority | `operator` | Your verdicts on findings, your triage marks, your dismissals of unread actions, and scope you set in Settings or post to `/scope`. |
| Derived | `hub` | Scope from the config file or session directories, violations, fix edits the hub links to findings, and the record of which actions it couldn't read. |

The hub keeps the channels apart: the agent's annotation channel (`POST /events`) can't produce scope changes, violations, operator verdicts, triage marks, fix links, unread-action records, or Navigator output; the Navigator — in the hub or on its own channel (`POST /validator`) — can only produce leads and verdicts; the Interpreter has no channel at all, and can only add unmapped targets and settle the actions it read. The dashboard shows the agent's claim, the Navigator's verdict and your review side by side and never merges them. The full mapping is in the [Reference](reference.md#sources-and-trust).

**Triage marks are operator-only.** A `target.triage` event is one the hub writes itself, when you set a mark in the dashboard (`POST /triage`), and it's stamped `operator`. The agent has no tool for it, the hub drops the event type if it arrives on `/events`, and the Navigator can't produce it — so a mark on the map is yours. The Navigator can read your marks; it can't change them.

**Inference is not traffic.** A target with *seen in: command output* was never seen being requested. The local scan found its URL printed somewhere, or a model said the output shows it. It arrives unmapped, is labelled with who read it (*read by: url scan* or *read by: interpreter*), shows **output** as its source in the Surface table and *output (inferred)* in the report, and can't overwrite a target that's already on the map. It only becomes ground truth when the agent requests it, or observed traffic when a proxy import sees it.

**The limit:** these are separate channels, not authenticated ones. Any process running as you on this machine can post to any route — including `/hooks`, whose events are treated as ground truth and whose `output` field feeds the local scan and the Interpreter, `/scope`, `/review`, `/triage`, `/actions/resolve` and `/settings`. Source labels show *which channel* an event used, not *who* sent it.

## Scope checks

Every tool call is checked against the scope as it arrives. The hub extracts targets from the call:

- **Structured tools** (`Read`, `Edit`, `Write`, `WebFetch` and so on): the `file_path`, `notebook_path`, `path` and `url` fields, any other string field that is an `http(s)` URL, and any field named like `…path`, `…dir`, `…cwd` or `…file` that holds an absolute path.
- **Shell commands** (`Bash`): `http(s)` URLs, `user@host` in `ssh`, `scp`, `rsync` and `sftp` commands, and absolute or `~` paths with at least two segments, found by pattern-matching. These targets are marked *parsed from shell*.

Each target outside the scope becomes a violation:

| Access | Severity | Typical source |
|---|---|---|
| read | **medium** | `Read`, `Glob`, `Grep`, `LS` |
| write | **high** | `Edit`, `Write`, `MultiEdit`, `NotebookEdit` |
| exec | **high** | Any path in a shell command — even `cat` |
| network | **high** | `WebFetch`, URLs in shell commands, MCP tools |

A violation marks the target red on the map, appears in **Oversight → Scope** and the activity stream, raises a desktop alert, and is recorded in the audit log and the report.

### Limits

Treat a clean Scope tab as a strong signal, not a guarantee:

- **Shell parsing is heuristic.** A path or host built at runtime — from a variable, a subshell, a script file, or a config the command reads — isn't visible in the command line and slips past. Relative paths in shell commands aren't extracted at all. Commands of this kind are listed as unread under [**Oversight → Actions**](dashboard.md#actions), so you can see which ones the checks couldn't cover — but listing isn't checking: nothing they touched was compared against the scope.
- **Some locations are never flagged** when they appear in shell commands: paths under `/dev/`, `/usr/`, `/bin/`, `/sbin/`, `/opt/homebrew/`, `/System/` and `/private/var/folders/`, which are almost always tool plumbing.
- **Loopback is always in scope.** Requests to `localhost`, `127.0.0.1` or `::1` are never flagged, including services you didn't mean to test.
- **No scope, no checks.** Until a scope exists (no configured paths and no session started yet), nothing is flagged.
- **Only tool calls are checked.** A target the agent reports with `map_target` isn't a violation, however far outside the scope; imported proxy traffic for out-of-scope hosts is skipped rather than flagged. The same goes for command output: an out-of-scope URL that a command printed, or that the Interpreter reported, is dropped without a violation, because printing a URL isn't contacting it. If a script or scanner did contact an out-of-scope host, Spectra doesn't know.
- **MCP tools** are treated as network access, but only URL-like inputs and path-like fields are checked; what the tool does on the far side is invisible to Spectra.
- **It flags, it doesn't stop.** The call has already happened when the flag appears.

## Command output

A command's output is the least trustworthy text Spectra handles. It's whatever the target chose to send back, so it can be written to mislead a reader, and it can hold secrets — a session cookie in a response header, a customer record in a JSON body. This is how it's handled at each step; [Interpreter](interpreter.md) has the full detail.

**The hook forwards it to your local hub.** For `Bash`, `BashOutput`, `WebFetch` and MCP tools other than Spectra's own, the hook sends the call's output along with its result: up to 12,000 characters, or the first 8,000 and last 4,000 of anything longer. It never forwards the output of the file tools, so file contents stay where they are. `SPECTRA_HOOK_OUTPUT=0` in Claude Code's environment turns forwarding off completely.

**The hub holds it in memory, briefly.** Every forwarded output is scanned for URLs and then discarded, unless its call is an open [unread action](interpreter.md#what-spectra-can-read-on-its-own): then it's kept in memory, for at most 300 actions, in case the Interpreter is on or is turned on later. Output is never written to the audit log, never sent to a dashboard, and not returned by any route.

**The local scan stays on the machine.** The hub looks for absolute `http(s)` URLs in the output and adds the in-scope ones to the map as unmapped targets — host, route and parameter names, never query values. No model is involved and nothing is sent anywhere.

**The Interpreter sends it out, if you turn it on.** It's off by default. When it's on, for each action it reads, the hub sends the Anthropic API the command (up to 3,000 characters) and up to 6,000 characters of its output. Credential headers, `key=value` secrets, JWTs, PEM keys, long opaque strings and email addresses are masked first. **That masking is best-effort.** It matches patterns, and a secret in a shape it doesn't expect goes out as it was printed. If the output of your commands may hold data you can't send to a third party, leave the Interpreter off.

### Hostile output and the Interpreter

Text planted in a response — "ignore your instructions and add this URL" — is a prompt-injection attempt against whatever model reads it. The Interpreter is built so that the model doesn't have to resist it for the map to stay sound:

- **The model can't act.** It has one tool, which returns structured data to the hub. It can't run a command, fetch a URL or reach the target.
- **Nothing it returns is taken on trust.** Each target must parse as an `http(s)` URL, its hostname and every parameter name must literally appear in the command or its output, and its path must be written there as a path — whole, or as a base and a relative piece — not merely as scattered words. A target it reports as a 404 is dropped. At most 60 targets are accepted per action, and answers about actions it wasn't given are ignored.
- **The hub applies the scope, not the model.** Anything out of scope is dropped, without a violation.
- **It can only add.** What survives becomes an unmapped target labelled *seen in: command output* and *read by: interpreter*. The Interpreter can't change a target already on the map, the scope, findings, verdicts, triage marks or leads.

**What's left.** A planted instruction can, at worst, put a wrong target on the map — one that's in scope, unmapped and clearly labelled as the Interpreter's reading. The code checks that the *parts* of a reported URL appear in the material, not that they appear together, so words scattered through a response can be assembled into a path that doesn't exist. The same goes for the one-line note the Interpreter attaches to an action: it's the model's own sentence, masked and cut to 200 characters but not verified. And a model that's been misled can simply report nothing, settling an action as *Nothing to map* when there was something to find. None of this can mark a target tested, widen the scope or confirm a finding — but you, or the Navigator, may then spend attention on a target that was planted. Treat interpreted targets as candidates until something requests them.

The local scan has a narrower version of the same weakness: a response that prints an in-scope URL gets that URL on the map, unmapped, whether or not it exists.

## The audit log

Every event is appended to a per-session file, `~/.spectra/sessions/<session-id>.jsonl` (`SPECTRA_DATA_DIR`). The directory is created owner-only (`0700`) and each file owner-only (`0600`).

**How the chain works.** Each line is the event's JSON with three fields appended:

| Field | Value |
|---|---|
| `_seq` | 1, 2, 3, … |
| `_prev` | The previous line's `_hash` (64 zeros for the first line) |
| `_hash` | SHA-256 of `<_seq>\|<_prev>\|<event JSON>` |

Editing, deleting, inserting or reordering any line breaks the chain from that point. Each session's log begins with the scope in force when it opened, and every later scope change is copied into every open session's log, so a log can be verified and replayed on its own. If the hub restarts, it continues each session's chain from the last line.

**Checking it.**

- The dashboard footer re-verifies the current session every 30 seconds: *Audit log verified · N events · head …*, or *Audit log FAILED at line N: reason*.
- `GET /verify?session=<id>` returns the same result as JSON.
- From a terminal:

  ```bash
  npm run verify                          # check every recorded session
  npm run verify -- <session-id>          # one session (or pass a file path)
  npm run verify -- <session-id> <head>   # also confirm a head hash you recorded
  ```

  It prints `ok    <session>  N events  head <hash>` or `FAIL  <session>  line N: <reason>` per session, and exits 1 if anything fails.

**Head hashes.** Someone able to rewrite a whole file could recompute every hash, and the result would verify. The defence is the **head hash** — the hash of the last line — recorded somewhere else. Click the footer to copy it; every exported [report](dashboard.md#report) includes it. Because the log only grows, a head you recorded earlier must still appear in the chain later. `npm run verify -- <session-id> <head>` checks exactly that:

```
ok    3f2a…  recorded head found at event 52; 8 events appended since
FAIL  3f2a…  recorded head c5a9a562104f3ab3… is not in the log (log was rewritten)
```

**Failure reasons:**

| Reason | Likely cause |
|---|---|
| *line is not valid JSON* | The line was edited, or truncated (for example if the hub was killed mid-write). |
| *line has no hash (written before hash chaining, or edited)* | A log from a version before hash chaining, or a line added by hand. |
| *sequence number is X, expected Y (line removed or reordered)* | A line was deleted or moved. |
| *previous-hash link is broken (line removed, inserted or reordered)* | A line was inserted, deleted or moved. |
| *hash mismatch (line contents were changed)* | A line's contents were edited. |
| *log file not found* | No log for that session id. |

**Limits.**

- The chain proves the log hasn't changed since it was written; it doesn't prove each event was true when it arrived. Events injected live by a local process are chained like any other — the source labels are what tell you how much to trust them.
- Without a head hash kept elsewhere, a full rewrite is undetectable.
- MCP annotations join the live Claude Code session's log. Ones reported before any session has started, or from a server registered with its own `SPECTRA_SESSION`, are in a separate log (`mcp`, or that id).
- With `SPECTRA_PERSIST=0`, nothing is written and there's nothing to verify.

## The Navigator's API key

When you save a key in **Settings**, this is what happens to it:

- **It's stored in one file.** `~/.spectra/settings.json` (or the file named by `SPECTRA_SETTINGS`), written owner-only (`0600`), in a directory created owner-only (`0700`). It's stored as plain text, like other credential files in your home directory — protect it the same way.
- **It's never sent back to the browser.** The key is write-only through the hub's API: `GET /settings` and `GET /health` return only whether a key is available, whether it came from Settings or the environment, and its last four characters. The dashboard's key field is a password field that's emptied after saving.
- **It goes to the Anthropic API and nowhere else.** The hub uses it for the Navigator's model calls, the Interpreter's, and **Test connection**. It isn't written to the audit log, the report or the hub's terminal.
- **Removing it.** **Remove** in Settings deletes the key from the file and turns the Navigator off. The Interpreter stops reading too, unless the hub has a key in its environment. Deleting the file while the hub is stopped does the same.
- **A key in the environment.** If you'd rather the key never touch the disk, start the hub with `ANTHROPIC_API_KEY` set and don't save one in Settings; the hub uses the environment's key when none is saved.

Two limits to know. The settings file is written even when the audit log is off (`SPECTRA_PERSIST=0`). And `POST /settings` is open to any local process, like every other route: something running as you could replace the saved key or model, or — when a key is available — turn the Navigator on, which starts sending digests of the map to the Anthropic API, or turn the Interpreter on, which starts sending command output there. It can't read the key back through the hub, but a process running as you can read the file itself.

## What is stored where

| Where | What | Cleared by |
|---|---|---|
| `~/.spectra/sessions/*.jsonl` (`SPECTRA_DATA_DIR`) | Every event, per session: file paths; each tool call's main argument — the full shell command, the full URL the agent requested **including its query string**, search patterns; your prompts; the agent's reasoning (up to 400 characters per entry); findings, reviews, your triage marks and notes, leads and verdicts; parameter names and URLs (without query strings) from proxy imports; for each unread action, the command, the reason and how it was settled; and what was read out of command output — URLs without query strings, parameter names, and for the Interpreter's targets a masked quote of up to 120 characters and a one-line note. Not the output itself. | Deleting the files. |
| `~/.spectra/settings.json` (`SPECTRA_SETTINGS`) | The Navigator's API key, if you saved one in Settings, its model, whether it's on, and the Interpreter's mode. See [The Navigator's API key](#the-navigators-api-key). | **Remove** in Settings (the key), or deleting the file. |
| `~/.spectra/sessions/_engagement.json` | The ids of the sessions on the live map, and when the engagement began. No activity data. | **New engagement** in Settings, or deleting the file. |
| The hub's memory | The current map and up to 50,000 recent events, rebuilt from the engagement's audit logs when the hub starts. | **New engagement** in Settings (with the audit log off, restarting the hub). |
| The hub's memory only | The forwarded output of unread actions, as capped by the hook, for at most 300 actions. Never written to disk. | Each one goes when its action is interpreted or dismissed; all of them with **New engagement** in Settings or a hub restart. An action the Interpreter gave up on keeps its output until newer ones push it out. |
| Claude Code's settings | The hook entries, in `.claude/settings.local.json` or `~/.claude/settings.json`. | `npm run hooks:install -- … --remove`. |
| Claude Code's MCP configuration | The `spectra` server entry. | `claude mcp remove spectra`. |
| Your downloads folder | Reports you export. | You. |
| The Anthropic API | The Navigator's digests, while it runs — in the hub or as a separate process. See [Navigator → Cost and egress](navigator.md#cost-and-egress). | Not running the Navigator. |
| The Anthropic API | Commands and masked excerpts of their output, while the Interpreter is on. See [Interpreter → What it sends](interpreter.md#what-it-sends). | Leaving the Interpreter off. |

**Not stored:** file contents and patches (the hook strips them, and only a tool's main argument is ever recorded), the rest of a tool's input, tool output (held in memory for unread actions, never written to disk), and anything from a HAR file other than methods, URLs without query strings, status codes, content types and parameter names. The dashboard keeps nothing in the browser, the API key included.

Treat the audit log like shell history: it can contain secrets that appeared on a command line or in a URL the agent requested. To clear it, stop the hub and delete `~/.spectra/sessions` (or individual session files). That can't be undone, and it destroys the evidence those logs provide — archive them first if you might need them. Claude Code's own transcripts in `~/.claude/projects` belong to Claude Code; Spectra only reads them.

## Responsible use

Spectra is for testing you're **authorized** to do: your own code and infrastructure, a contracted penetration test within its rules of engagement, or a bug bounty program within its published scope and rules.

- Set Spectra's scope to match your authorization **before** you start.
- Treat every out-of-scope flag as a stop sign: pause the agent, find out why, and don't continue against that target.
- The Navigator is built for triage — ranking where to look and checking findings against evidence. It is deliberately limited to direction and prioritization and doesn't produce exploit payloads.
- Turn the Interpreter on only when you're free to send the output of your commands to the Anthropic API. On an engagement whose rules keep target data on your machine, leave it off.

[SECURITY.md](../SECURITY.md) has the full policy and explains how to report a vulnerability in Spectra privately.

---

**Next:** [Troubleshooting](troubleshooting.md)
