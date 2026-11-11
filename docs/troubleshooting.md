# Troubleshooting

This page collects the failures you're most likely to hit, what each one looks like, and how to fix it: the hub not running or not reachable, hooks that don't fire, scope that flags everything or nothing, proxy imports that find nothing in scope, the Navigator exiting or staying quiet, and audit logs that fail verification. Most problems come down to three things — the hub isn't where a client expects it, a Claude Code session started before its hooks were installed, or the scope isn't what you think it is. Check those first.

## Quick checks

```bash
curl -s http://127.0.0.1:4317/state | head -c 200     # is the hub up?
curl -s http://127.0.0.1:4317/sessions                # what has it recorded?
npm run verify                                        # do the audit logs verify?
```

On the dashboard, look at the top bar (**Live** or **Offline**, and the scope badge) and **Oversight → Scope** (who set the scope, and what it contains).

## The hub

### The dashboard says Offline, or won't load

The hub isn't running, or it's on another port. Start it with `npm start` and reload. While the hub is down, the dashboard retries every second and reconnects on its own.

If the page returns `dashboard not built: run npm run build`, the hub is running but the dashboard hasn't been built. `npm start` builds it first; if you started the hub another way, run `npm run build`.

### `EADDRINUSE` when starting the hub

Something is already listening on port 4317 — often another Spectra hub. Stop it, or start this one on another port and point every client at it:

```bash
SPECTRA_PORT=4400 npm start
export SPECTRA_HUB=http://127.0.0.1:4400    # in every shell that runs a client
```

The hook and MCP server need `SPECTRA_HUB` too — see [Configuration](configuration.md#clients).

### Clients can't reach the hub

Each client fails differently:

| Client | What you see |
|---|---|
| Hook | Nothing. It gives up silently after 300 ms so Claude Code is never affected; the session simply doesn't appear. |
| MCP server | The tools still report success to the agent. The server's stderr says `[spectra-mcp] hub unreachable: …`. |
| Navigator | `[navigator] socket error: …` and `[navigator] hub connection closed; retrying in 3s`, repeating until the hub is up. |
| Importer | `Can't reach the hub at http://127.0.0.1:4317. Start it with npm start.` |
| Demos | The script stops with a fetch error. |

Fixes: start the hub; make sure `SPECTRA_HUB` and `SPECTRA_PORT` agree; and use `127.0.0.1`, not `localhost`, in `SPECTRA_HUB` — the hub listens on IPv4 loopback only, and `localhost` can resolve to the IPv6 address first.

## Claude Code

### Hooks aren't firing

Symptoms: the agent works but nothing appears, or activity appears without your prompts (prompts come only from hooks — if you see tool calls but no *operator prompt* entries, the activity is coming from the log observer instead).

1. **Restart the session.** Hooks load when a Claude Code session starts. Sessions already running when you installed them won't report.
2. **Check where they're installed.** Project hooks go in `<project>/.claude/settings.local.json` and only apply to sessions started in that project. Open the file and look for `spectra-hook.mjs` under `hooks`. Use `--user` to cover every project.
3. **Moved or re-cloned Spectra?** The hook command holds an absolute path to `packages/server/bin/spectra-hook.mjs`. Run `npm run hooks:install` again.
4. **Is `node` on the path Claude Code uses?** The hook runs as `node "<path>/spectra-hook.mjs"`.
5. **Test the hook by hand** from the Spectra root (this records a small session named `hook-test` in the audit log):

   ```bash
   echo '{"hook_event_name":"SessionStart","session_id":"hook-test","cwd":"/path/to/target-repo"}' \
     | node packages/server/bin/spectra-hook.mjs
   ```

   The **Session** field should show `hook-test` and a root named `target-repo` should appear on the map. If it does, the hook and hub are fine and the problem is Claude Code's configuration.

If the settings file can't be parsed, the installer refuses to touch it: `could not parse <path>: …`. Fix the JSON and run it again.

### The observer shows sessions you didn't expect

The log observer reads every Claude Code transcript under `~/.claude/projects` that changes while the hub runs — not just your target's. Close unrelated sessions, or run the hub with `SPECTRA_OBSERVER=0` and rely on project hooks. Hooks installed with `--user` also report every project. When no scope paths are configured, every session's working directory is also added to the scope.

### The observer misses a session

Sessions whose transcript hadn't changed for more than a minute before the hub started are skipped until they write again; new activity in them is still picked up. To load whole transcripts from the start, run the hub with `SPECTRA_REPLAY=1`. Check that `SPECTRA_OBSERVER` isn't `0`, and that `SPECTRA_PROJECTS_DIR` (if set) points at Claude Code's projects directory.

### The MCP server doesn't start

Check `claude mcp list`. The registration command must be run from the Spectra root so that `$(pwd)` expands to the right paths, and it should point at the `tsx` in your Spectra checkout (Claude Code starts the server from the target repo's directory, where `npx tsx` may not resolve). If you registered it another way, re-register it:

```bash
claude mcp remove spectra
claude mcp add spectra -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/packages/server/src/mcp.ts"
```

### MCP findings are missing from replay or a report

With the default session id, the hub attaches MCP annotations to the live Claude Code session. If they're missing, check whether the server was registered with `SPECTRA_SESSION` set — those are recorded under that id, so pick it in the replay session list — or whether the findings were reported before any Claude Code session started, in which case they're recorded under `mcp`.

## Scope

| Symptom | Cause | Fix |
|---|---|---|
| Badge says *unset*; nothing is flagged | Nothing configured (no paths or hosts), and no session has started. | Configure paths or hosts, `POST /scope`, or start a session. |
| Every file access is flagged | The scope's paths don't match where the agent works — a typo, a different checkout, or a relative path. | Check **Oversight → Scope** for the exact paths, and post the right ones with `POST /scope`. |
| Every host is flagged | No hosts are configured, so only loopback is in scope. | Add `hosts` to the config, or `SPECTRA_SCOPE_HOSTS`, or `POST /scope`. |
| Your config seems ignored | The file isn't valid JSON, isn't where the hub looks, or has relative paths. | The startup line `[spectra] scope: …` shows the loaded paths. Fix the JSON, set `SPECTRA_CONFIG`, use absolute paths. Restart the hub. |
| The scope changed by itself | A demo ran. Each demo posts its own scope. | Restart the hub or post your scope again. |
| A subdomain isn't flagged | Hosts include their subdomains. | Expected. List exactly the hosts you're authorized for. |
| A local service isn't flagged | Loopback is always in scope. | Expected. |
| A shell command touched something but wasn't flagged | The path or host was built at runtime, is relative, or is under an ignored system prefix. | See [Security → Limits](security.md#limits). |

## Proxy import

### "Nothing in this file is in scope"

The dashboard shows *Nothing in scope to import*; the CLI prints the hint *Nothing in this file is in scope. Add the target's hosts to your scope (spectra.config.json or POST /scope) and import again.* Either no scope exists yet, or the target's hosts aren't in it. The summary lists the most frequent out-of-scope hosts — add the right ones and import again. Remember that with no paths configured, there's no scope at all until a session starts.

### Other import problems

| Symptom | Fix |
|---|---|
| *Not a HAR file: expected log.entries* | Export as HAR, not the proxy's own format. |
| Most requests skipped as static | Add `--include-static` (CLI only). |
| Request counts doubled | You imported the same file twice. Restart the hub for a clean map. |
| An endpoint lost its *seen in* / requests / methods | The agent requested it after the import, which replaced its properties. Import again. |

See [Proxy import → Troubleshooting](proxy-import.md#troubleshooting) for every message.

## Navigator

| Symptom | Cause and fix |
|---|---|
| `` [navigator] auth failed — set ANTHROPIC_API_KEY (or run `ant auth login`). Exiting. `` and exit code 1 | The API rejected the credentials. Export a valid `ANTHROPIC_API_KEY` in the same shell and start it again. |
| `[navigator] model call failed: …` | Any other API error — often an unknown model id in `SPECTRA_VALIDATOR_MODEL`, a network problem or rate limiting. The Navigator keeps running and tries again on the next change. |
| `[navigator] model declined to assess this state; skipping cycle.` | The model refused that assessment. It tries again after the next change. |
| No leads appear | The map is empty, or it hasn't been quiet long enough: it waits for 2.5 s without events (`SPECTRA_VALIDATOR_IDLE_MS`) and runs at most every 15 s. Check its terminal for `posted N assessment(s)`. |
| Some targets never get a lead | The digest holds 200 targets, attack surface first; on a bigger map the oldest files and commands drop out first, then the oldest surface. Out-of-scope targets never get leads. |
| Stale leads | Leads persist until the Navigator assesses that target again; stopping the Navigator leaves them in place. |

## Audit log fails verification

The footer shows *Audit log FAILED at line N: reason*, or `npm run verify` prints `FAIL`.

| Message | What to do |
|---|---|
| *line is not valid JSON* | Usually a line cut off when the hub was killed mid-write, or an edit. Compare against a backup. |
| *hash mismatch (line contents were changed)* | That line was edited after it was written. Treat everything from that line on as untrusted. |
| *sequence number is …* / *previous-hash link is broken …* | Lines were removed, inserted or reordered. The same applies. |
| *line has no hash …* | A log from before hash chaining, or a hand-added line. |
| *recorded head … is not in the log (log was rewritten)* | The log was rewritten since you recorded that head, even though its chain is consistent. |
| *log file not found* / footer *Audit log: log file not found* | No log for that session id. MCP annotations are under `mcp`. |
| `no audit logs in <dir>` | `npm run verify` is looking in a different directory from the hub. Set `SPECTRA_DATA_DIR` the same for both. |
| Footer *Audit log: audit log disabled* | The hub runs with `SPECTRA_PERSIST=0`. |

A failure means the file no longer matches what was written; it doesn't say who changed it or how. Keep the failing file as it is for investigation. See [Security → The audit log](security.md#the-audit-log).

## Dashboard odds and ends

| Symptom | Cause and fix |
|---|---|
| **Replay** shows no sessions | The audit log is off (`SPECTRA_PERSIST=0`), or nothing has been recorded yet. |
| The graph stopped following new targets | You zoomed or panned. Click **⤢** to fit and follow again. |
| **Files** says *No scope paths set* | The scope has no paths. |
| A file the agent clearly read shows *never opened* | It was read through a shell command (`cat`, `sed`, …). Only structured tools count toward file coverage. |
| No desktop alerts | `SPECTRA_NOTIFY=0`; on Linux, `notify-send` isn't installed; or your system's notification settings block them. Alerts are also collapsed to one every 5 seconds. |
| The map is cluttered with old sessions | The hub keeps everything since it started. Restart it for a clean map; recorded sessions stay available in Replay. |

---

**Next:** back to the [documentation index](README.md)
