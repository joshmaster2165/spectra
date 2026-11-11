# Security

Spectra watches an AI agent do security testing, so it handles sensitive material — commands, URLs, file paths, your prompts — and its records may later serve as evidence of what happened. This page describes how it protects that material and where the protection stops: the hub is local-only and refuses other web origins; every event is labelled with a source that's trusted differently; scope checks flag boundary crossings but have known blind spots; and a hash-chained audit log makes after-the-fact edits detectable. It also lists what is stored where, how to clear it, and the rules for responsible use. To report a vulnerability in Spectra itself, see [SECURITY.md](../SECURITY.md).

## Local only

- **Loopback binding.** The hub listens on `127.0.0.1` only. Nothing on your network can reach it.
- **Origin checks.** Every HTTP request and every WebSocket connection carrying an `Origin` header is refused unless the origin's host is `localhost`, `127.0.0.1` or `[::1]`. A web page on any other site can't read the agent's activity from the hub or post events to it, even though your browser can reach `127.0.0.1`. Requests without an `Origin` — curl, the hook, the MCP server, the importer — are allowed.
- **What leaves your machine.** The hub makes no outbound connections. The [Navigator](navigator.md) is the only part that sends Spectra data anywhere — to the Anthropic API — and it's opt-in. The demos and the proxy importer only talk to your local hub. The dashboard's stylesheet loads its fonts from Google Fonts, so your browser fetches those.

## Observation, not control

Spectra never drives the agent: it sends no prompts and approves no tools. The hook is built so it can't interfere with Claude Code — it never writes to stdout, always exits 0, and gives up on the hub after 300 ms. Scope checks **flag**; they don't block. Staying in scope is the operator's job: treat every red flag as a stop sign.

## Trust tiers

Every event carries the source it came through, and the hub — not the caller — decides it:

| Tier | Sources | Meaning |
|---|---|---|
| Ground truth | `hook`, `observer` | What Claude Code actually ran. |
| Claims | `mcp`, `demo` | What the agent (or a script) says. Findings are shown as *agent-reported*. |
| Observed traffic | `proxy` | What crossed the wire, per imported proxy history. |
| Advice | `validator` | The Navigator's leads and verdicts. |
| Authority | `operator` | Your verdicts on findings, and scope you post to `/scope`. |
| Derived | `hub` | Scope from the config file or session directories, violations, and fix edits the hub links to findings. |

The hub keeps the channels apart: the agent's annotation channel (`POST /events`) can't produce scope changes, violations, operator verdicts, fix links, or Navigator output; the Navigator's channel (`POST /validator`) can only produce leads and verdicts. The dashboard shows the agent's claim, the Navigator's verdict and your review side by side and never merges them. The full mapping is in the [Reference](reference.md#sources-and-trust).

**The limit:** these are separate channels, not authenticated ones. Any process running as you on this machine can post to any route — including `/hooks`, whose events are treated as ground truth, `/scope` and `/review`. Source labels show *which channel* an event used, not *who* sent it.

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

- **Shell parsing is heuristic.** A path or host built at runtime — from a variable, a subshell, a script file, or a config the command reads — isn't visible in the command line and slips past. Relative paths in shell commands aren't extracted at all.
- **Some locations are never flagged** when they appear in shell commands: paths under `/dev/`, `/usr/`, `/bin/`, `/sbin/`, `/opt/homebrew/`, `/System/` and `/private/var/folders/`, which are almost always tool plumbing.
- **Loopback is always in scope.** Requests to `localhost`, `127.0.0.1` or `::1` are never flagged, including services you didn't mean to test.
- **No scope, no checks.** Until a scope exists (no configured paths and no session started yet), nothing is flagged.
- **Only tool calls are checked.** A target the agent reports with `map_target` isn't a violation, however far outside the scope; imported proxy traffic for out-of-scope hosts is skipped rather than flagged.
- **MCP tools** are treated as network access, but only URL-like inputs and path-like fields are checked; what the tool does on the far side is invisible to Spectra.
- **It flags, it doesn't stop.** The call has already happened when the flag appears.

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
- MCP annotations are recorded under their own session id (`mcp` by default), so they're in a separate log from the Claude Code session they relate to.
- With `SPECTRA_PERSIST=0`, nothing is written and there's nothing to verify.

## What is stored where

| Where | What | Cleared by |
|---|---|---|
| `~/.spectra/sessions/*.jsonl` (`SPECTRA_DATA_DIR`) | Every event, per session: file paths; each tool call's main argument — the full shell command, the full URL the agent requested **including its query string**, search patterns; your prompts; the agent's reasoning (up to 400 characters per entry); findings, reviews, leads and verdicts; parameter names and URLs (without query strings) from proxy imports. | Deleting the files. |
| The hub's memory | The current map and up to 50,000 recent events. | Restarting the hub. |
| Claude Code's settings | The hook entries, in `.claude/settings.local.json` or `~/.claude/settings.json`. | `npm run hooks:install -- … --remove`. |
| Claude Code's MCP configuration | The `spectra` server entry. | `claude mcp remove spectra`. |
| Your downloads folder | Reports you export. | You. |
| The Anthropic API | The Navigator's digests, while it runs. See [Navigator → Cost and egress](navigator.md#cost-and-egress). | Not running the Navigator. |

**Not stored:** file contents and patches (the hook strips them, and only a tool's main argument is ever recorded), the rest of a tool's input, and anything from a HAR file other than methods, URLs without query strings, status codes, content types and parameter names. The dashboard keeps nothing in the browser.

Treat the audit log like shell history: it can contain secrets that appeared on a command line or in a URL the agent requested. To clear it, stop the hub and delete `~/.spectra/sessions` (or individual session files). That can't be undone, and it destroys the evidence those logs provide — archive them first if you might need them. Claude Code's own transcripts in `~/.claude/projects` belong to Claude Code; Spectra only reads them.

## Responsible use

Spectra is for testing you're **authorized** to do: your own code and infrastructure, a contracted penetration test within its rules of engagement, or a bug bounty program within its published scope and rules.

- Set Spectra's scope to match your authorization **before** you start.
- Treat every out-of-scope flag as a stop sign: pause the agent, find out why, and don't continue against that target.
- The Navigator is built for triage — ranking where to look and checking findings against evidence. It is deliberately limited to direction and prioritization and doesn't produce exploit payloads.

[SECURITY.md](../SECURITY.md) has the full policy and explains how to report a vulnerability in Spectra privately.

---

**Next:** [Troubleshooting](troubleshooting.md)
