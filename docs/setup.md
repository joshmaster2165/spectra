# Setup

This is the full setup guide, in the order you'll do it: define the scope you're authorized for, connect Claude Code so every tool call reaches the hub, optionally register the MCP server so the agent can annotate the map, optionally start the Navigator, and import proxy history. It ends with a checklist to confirm everything works and the steps to remove Spectra again. It assumes you've installed Spectra and can run `npm start` — see [Getting started](getting-started.md) if not.

Throughout, `/path/to/target-repo` is the code you're testing and `example-shop.test` is the target host. Replace both with your own.

## 1. Set your scope

The scope is the set of directories and hosts you're authorized to touch. Spectra compares every file read, write, shell command and network request against it and flags anything outside it. It flags; it doesn't block.

### The config file

```bash
cp spectra.config.example.json spectra.config.json
```

```json
{
  "scope": {
    "paths": ["/path/to/target-repo"],
    "hosts": ["example-shop.test"]
  }
}
```

- The hub reads `spectra.config.json` from the root of the Spectra checkout when it starts. Point `SPECTRA_CONFIG` at another file to use that instead. Restart `npm start` after editing it.
- Use absolute paths. A leading `~` is expanded to your home directory; any other relative path is resolved against the hub's working directory (`packages/server` under `npm start`), which is rarely what you want.
- If the file is missing or isn't valid JSON, the hub silently falls back to having no config. The startup line `[spectra] scope: …` tells you which paths it loaded; if it says *each session's working directory*, your paths weren't read.

### Environment variables

`SPECTRA_SCOPE_PATHS` and `SPECTRA_SCOPE_HOSTS` take comma-separated lists. Each one, when set, replaces the matching list from the config file:

```bash
SPECTRA_SCOPE_PATHS=/path/to/target-repo SPECTRA_SCOPE_HOSTS=example-shop.test,example-api.test npm start
```

### Changing it live

Post a new scope to the running hub:

```bash
curl -X POST http://127.0.0.1:4317/scope -H 'content-type: application/json' \
  -d '{"paths":["/path/to/target-repo"],"hosts":["example-shop.test"]}'
```

- This **replaces** the whole scope. Send both lists every time: if you leave out `paths`, no directory is in scope and every file access is flagged.
- The change is recorded in the audit log of every open session.
- It lasts until the hub restarts; then the config file applies again.

### How scope is matched

| Rule | Detail |
|---|---|
| Hosts include their subdomains | `example-shop.test` covers `api.example-shop.test` and `a.b.example-shop.test`, but not `badexample-shop.test`. |
| Hosts are exact names | No wildcards and no ports. Matching is case-insensitive. |
| Loopback is always in scope | `localhost`, `127.0.0.1` and `::1` are added to every scope, because local test targets are the normal case. |
| Paths cover everything under them | A file is in scope if it is a scope directory or anywhere beneath one. |
| Severity | Reads outside scope are *medium*. Writes, shell execution and network access are *high*. |

### With no config, or hosts only

If no paths are configured (no config file, or a config with only `hosts`), the scope comes from the sessions themselves:

- When a Claude Code session starts, its working directory is added to the path scope. The Scope tab shows **Set by: Session working directory**. A second session in another directory adds that directory too.
- The host scope is whatever hosts you configured, plus loopback. With no hosts configured, every non-local host is flagged.
- With hosts configured, those hosts (plus loopback) are in scope as soon as the hub starts, so you can import proxy history before the agent runs. With nothing configured there's **no scope at all** until the first session starts: nothing is flagged, and an import finds nothing in scope.

Check what's in force on the dashboard: the scope badge in the top bar shows *N paths · M hosts* (or *unset*), and **Oversight → Scope** lists them.

## 2. Connect Claude Code

### Hooks (recommended)

Hooks report every tool call the moment it happens. Install them for one project:

```bash
npm run hooks:install -- /path/to/target-repo
```

or for every project you open with Claude Code:

```bash
npm run hooks:install -- --user
```

| | Writes to |
|---|---|
| A project directory | `/path/to/target-repo/.claude/settings.local.json` |
| `--user` | `~/.claude/settings.json` |

The installer merges Spectra's hook into the `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `SessionEnd` events (matcher `*` for the tool events), with a 2-second timeout. It keeps your existing settings and other hooks, and re-running it is safe: it replaces its own entry rather than adding another. Pass the project directory as an absolute path.

**Restart any running Claude Code sessions** in that project (or all of them, for `--user`). Hooks load when a session starts.

To remove them, run the same command with `--remove`:

```bash
npm run hooks:install -- /path/to/target-repo --remove
npm run hooks:install -- --user --remove
```

The hook command contains the absolute path to `packages/server/bin/spectra-hook.mjs` in your Spectra checkout. If you move or re-clone Spectra, run the installer again.

**What the hook does and doesn't do.** It's strictly observational:

- It never prints to stdout (hook output can steer Claude Code) and always exits 0 (a non-zero exit can block a tool call).
- It gives up on the hub after 300 ms, so a stopped hub never slows the agent down.
- It sends the event name, session id, working directory, tool name and id, the tool input, the prompt text for `UserPromptSubmit`, and whether the call succeeded. It strips file contents and patches (`content`, `new_string`, `old_string`, `edits`, `new_source`) before sending.

### The log observer (fallback)

Without hooks, Spectra still sees the agent: the hub tails Claude Code's session transcripts under `~/.claude/projects/`. It's on by default.

- It checks for new lines every 400 ms. It picks up sessions whose transcript changed within a minute before the hub started, and anything after; older sessions are skipped unless you start the hub with `SPECTRA_REPLAY=1`.
- It's the only source of the agent's **reasoning** (its thinking and replies), which hooks don't carry. With hooks installed, the hub takes tool calls from the hooks and only reasoning from the observer, so running both doesn't double-count.
- It watches **every** Claude Code session on the machine, not just the one in your target repo. Close unrelated sessions while you test, or turn it off with `SPECTRA_OBSERVER=0` and rely on project hooks.
- The transcript format isn't a public API. Hooks are the more reliable source; use the observer as a fallback.

| | Hooks | Observer |
|---|---|---|
| Tool calls | Yes, as they happen | Yes, from the transcript |
| Agent reasoning | No | Yes |
| Your prompts | Yes | No |
| Setup | Install, restart sessions | None |
| Depends on | Claude Code's hook API | The transcript format |

## 3. Register the MCP server (optional)

Hooks and the observer map what the agent *touches*. To also map what it *discovers* — a subdomain in scanner output, a parameter in a JS bundle — give it Spectra's MCP tools. From the root of your Spectra checkout:

```bash
claude mcp add spectra -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/packages/server/src/mcp.ts"
```

The agent gets five tools:

| Tool | Use |
|---|---|
| `map_target` | Add a discovered target (host, subdomain, endpoint, parameter, module) to the map |
| `link_nodes` | Connect two targets with a labelled edge |
| `update_chain` | Add a step to the attack chain behind a finding |
| `report_finding` | Report a vulnerability: severity, confidence, status, file/line, supporting steps |
| `log_thought` | Explain a change of direction |

Every parameter is listed in the [Reference](reference.md#mcp-tools).

Things to know:

- Anything sent this way is labelled **agent-reported** — a claim to check, not ground truth. There is deliberately no tool for scope, operator verdicts or Navigator output, and the hub drops those event types if they arrive on this channel.
- Annotations are attached to the live Claude Code session, so the agent's findings appear in that session's audit log, replay and report. (Set `SPECTRA_SESSION` in the server's environment to record them under a session id of your own instead.)
- If the hub isn't running, the tools still return success to the agent; the error goes to the server's stderr.
- To have a discovered endpoint land on the same node as the agent's real requests, use the hub's id conventions — see [Node ids](reference.md#node-ids).

Adding a line like this to the target project's `CLAUDE.md` helps the agent use the tools:

> Record discovered hosts, subdomains, endpoints and parameters with `map_target`, and report suspected vulnerabilities with `report_finding`, linking the attack-chain steps that support them.

## 4. Start the Navigator (optional)

The Navigator is a second model that reads the same map and scores where to dig. It needs an Anthropic API key and is the only part of Spectra that sends data off your machine.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run validator
```

It prints `[navigator] watching ws://127.0.0.1:4317/ws with claude-opus-5-5` and then posts leads and verdicts whenever the map has been quiet for a moment. `SPECTRA_VALIDATOR_MODEL` picks the model. [Navigator](navigator.md) explains what it sends, what comes back and how to read it.

## 5. Import proxy history (optional)

If you run the agent (or yourself) through an intercepting proxy, export its history as HAR and put it on the same map — from the dashboard's **Import HAR** button, or:

```bash
npm run import -- /path/to/history.har
```

Only in-scope hosts are imported, and only parameter names, never values. See [Proxy import](proxy-import.md).

## 6. Check that it works

With the hub running and your scope set:

1. **Dashboard connected.** The top bar shows **Live**.
2. **Scope loaded.** The scope badge shows your path and host counts; **Oversight → Scope** says *Set by: Operator config* (or *Session working directory* if you're relying on session scope).
3. **A session arrives.** Start Claude Code in the target (`cd /path/to/target-repo && claude`) and ask it to read a file. A session root and a `files` node appear on the graph, the **Session** field shows the session id, and **Activity → Stream** shows your prompt (tagged *operator prompt*) and the `Read` call.
4. **Violations are flagged.** Ask the agent to read a harmless file outside your scope paths. The node turns red, the badge shows *1 out of scope*, **Oversight → Scope** lists the violation (*med* for a read with the `Read` tool, *high* if the agent used the shell), and a desktop alert appears.
5. **MCP tools work** (if registered). Ask the agent to call `log_thought`; the note appears in the stream.
6. **The Navigator answers** (if running). Its terminal shows `[navigator] posted N assessment(s) for session …` and **Oversight → Navigator** fills with leads.
7. **The audit log verifies.** The footer reads *Audit log verified · N events · head …*. From a terminal:

   ```bash
   npm run verify
   curl -s http://127.0.0.1:4317/sessions
   ```

If any step fails, see [Troubleshooting](troubleshooting.md).

## Uninstall

1. Remove the hooks from every place you installed them:

   ```bash
   npm run hooks:install -- /path/to/target-repo --remove
   npm run hooks:install -- --user --remove
   ```

2. Remove the MCP server: `claude mcp remove spectra`.
3. Stop `npm start` and `npm run validator`.
4. Delete the audit logs if you don't need them as evidence: `rm -rf ~/.spectra/sessions` (or your `SPECTRA_DATA_DIR`). This can't be undone.
5. Delete the Spectra checkout, including your `spectra.config.json`.

---

**Next:** [Dashboard](dashboard.md)
