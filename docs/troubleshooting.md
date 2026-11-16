# Troubleshooting

This page collects the failures you're most likely to hit, what each one looks like, and how to fix it: the hub not running or not reachable, hooks that don't fire, failed or denied commands that stay active, scope that flags everything or nothing, proxy imports that find nothing in scope, the Navigator stopping or staying quiet, actions that stay unread and an Interpreter that reads nothing, and audit logs that fail verification. Most problems come down to three things — the hub isn't where a client expects it, a Claude Code session started before its hooks were installed, or the scope isn't what you think it is. Check those first.

## Quick checks

```bash
curl -s http://127.0.0.1:4317/state | head -c 200     # is the hub up?
curl -s http://127.0.0.1:4317/health                  # what's connected?
curl -s http://127.0.0.1:4317/sessions                # what has it recorded?
npm run verify                                        # do the audit logs verify?
```

On the dashboard, open **Settings** and read the **Setup** checklist: it shows, row by row, whether the scope is set, whether hook events and MCP annotations have arrived, whether the Navigator is running or stopped on an error, how many actions Spectra couldn't read, and whether the audit log is on. Then look at the top bar (**Live** or **Offline**, and the scope badge) and **Oversight → Scope** (who set the scope, and what it contains).

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
| `npm run validator` | `[navigator] socket error: …` and `[navigator] hub connection closed; retrying in 3s`, repeating until the hub is up. |
| Settings dialog | *Can't reach the hub. Is `npm start` still running?* |
| Importer, demos | `Can't reach the hub at http://127.0.0.1:4317. Start it with npm start.` The command it names matches how you run Spectra. |

Fixes: start the hub; make sure `SPECTRA_HUB` and `SPECTRA_PORT` agree; and use `127.0.0.1`, not `localhost`, in `SPECTRA_HUB` — the hub listens on IPv4 loopback only, and `localhost` can resolve to the IPv6 address first.

## Claude Code

### Hooks aren't firing

Symptoms: the agent works but nothing appears, or activity appears without your prompts (prompts come only from hooks — if you see tool calls but no *operator prompt* entries, the activity is coming from the log observer instead). In **Settings → Setup**, the **Claude Code hooks** row stays at *No hook events yet*.

1. **Restart the session.** Hooks load when a Claude Code session starts. Sessions already running when you installed them won't report.
2. **Check where they're installed.** Project hooks go in `<project>/.claude/settings.local.json` and only apply to sessions started in that project. Open the file and look for `spectra-hook.mjs` under `hooks`. Use `--user` to cover every project.
3. **Moved or re-cloned Spectra?** The hook command holds an absolute path to `packages/server/bin/spectra-hook.mjs`. Run `npm run hooks:install` again. (Installed with `spectra init`, the path is `~/.spectra/bin/spectra-hook.mjs`; run `spectra init` again if that file is gone.)
4. **Is `node` on the path Claude Code uses?** The hook runs as `node "<path>/spectra-hook.mjs"`.
5. **Test the hook by hand** from the Spectra root (this records a small session named `hook-test` in the audit log):

   ```bash
   echo '{"hook_event_name":"SessionStart","session_id":"hook-test","cwd":"/path/to/target-repo"}' \
     | node packages/server/bin/spectra-hook.mjs
   ```

   The **Session** field should show `hook-test` and a root named `target-repo` should appear on the map. If it does, the hook and hub are fine and the problem is Claude Code's configuration.

If the settings file can't be parsed, the installer refuses to touch it: `could not parse <path>: …`. Fix the JSON and run it again.

### A failed command stays active

Symptom: a command or request that failed keeps its orange **active** colour and never settles, and the **Target** view shows *…* for that call instead of *ERR*.

Claude Code reports a failed tool call only through the `PostToolUseFailure` hook event. Hooks installed before Spectra registered that event never deliver the failure, so the call never gets a result. Run the installer again, then restart Claude Code:

```bash
npm run hooks:install -- /path/to/target-repo     # or: -- --user
```

Re-running is safe: it replaces Spectra's entries rather than adding more. To confirm, open the settings file the installer names and check that `PostToolUseFailure` is listed under `hooks`. After the restart, a failed call shows *ERR* and its target goes back to **unmapped**. Targets that were already stuck stay active until the agent touches them again or the hub restarts.

If targets stay active after calls that finished normally, the hub is running an older build: that was a bug, since fixed. Update Spectra and restart `npm start`.

### A command Claude Code denied left its targets on the map

Symptom: Claude Code refused a call — a permission rule, you saying no, its own check for unsafe commands — yet the hosts and endpoints the call named are on the map, **active**, as if they'd been reached.

Claude Code sends `PreToolUse` before it decides, and a denied call gets no `PostToolUse` or `PostToolUseFailure`. Spectra learns that the call never ran from `PostToolBatch`, which hooks installed before Spectra registered that event don't deliver. Run the installer again, as above, and restart Claude Code. To confirm, check that `PostToolBatch` is listed under `hooks` in the settings file.

After the restart, a denied call is tagged *did not run* in **Activity → Stream**, the targets only it had named come off the map, and its row under **Oversight → Actions**, if it had one, reads **Never ran**. A scope violation the attempt raised stays. On a Claude Code version that doesn't send `PostToolBatch`, such a call simply stays without a result. See [Interpreter → Calls that never ran](interpreter.md#calls-that-never-ran).

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
| Badge says *unset*; nothing is flagged | Nothing configured (no paths or hosts), and no session has started. | Configure paths or hosts, set them in **Settings → Scope**, `POST /scope`, or start a session. |
| Every file access is flagged | The scope's paths don't match where the agent works — a typo, a different checkout, a relative path, or a scope saved from Settings with **Paths** empty. | Check **Oversight → Scope** for the exact paths, and set the right ones in **Settings → Scope** or with `POST /scope`. |
| Every host is flagged | No hosts are configured, so only loopback is in scope. | Add `hosts` to the config, or `SPECTRA_SCOPE_HOSTS`, or set them in **Settings → Scope** or with `POST /scope`. |
| Your config seems ignored | The file isn't valid JSON, isn't where the hub looks, or has relative paths. | The startup line `[spectra] scope: …` shows the loaded paths. Fix the JSON, set `SPECTRA_CONFIG`, use absolute paths. Restart the hub. |
| The scope changed by itself | A demo ran. Each demo posts its own scope. | Set your scope again in **Settings**, or start a new engagement, which goes back to the config file's scope. |
| The scope you set in Settings is gone | `spectra.config.json` sets paths, which win at startup; or you started a new engagement; or the audit log is off. | Put the scope in `spectra.config.json`. |
| Sessions stopped adding their working directory | You saved a scope from Settings, or posted `paths`. The scope then counts as set by you. | Add the directory to **Paths**. |
| A subdomain isn't flagged | Hosts include their subdomains. | Expected. List exactly the hosts you're authorized for. |
| A local service isn't flagged | Loopback is always in scope. | Expected. |
| A shell command touched something but wasn't flagged | The path or host was built in a way the hub couldn't expand, is relative, or is under an ignored system prefix. | See [Security → Limits](security.md#limits). |
| A violation is listed for a call that never ran | Claude Code denied the call, or it failed before making the request. The scope check runs on what the call names, as it arrives. | Expected. The attempt is worth seeing. |

## Proxy import

### "Nothing in this file is in scope"

The dashboard shows *Nothing in scope to import*; the CLI prints the hint *Nothing in this file is in scope. Add the target's hosts to your scope (spectra.config.json or POST /scope) and import again.* Either no scope exists yet, or the target's hosts aren't in it. The summary lists the most frequent out-of-scope hosts — add the right ones and import again. Remember that with no paths configured, there's no scope at all until a session starts.

### Other import problems

| Symptom | Fix |
|---|---|
| *Not a HAR file: expected log.entries* | Export as HAR, not the proxy's own format. |
| Most requests skipped as static | Add `--include-static` (CLI only). |
| Request counts doubled | You imported the same file twice. Start a new engagement in **Settings** for a clean map, and import once. |
| An endpoint shows *agent and proxy traffic* | Both the agent and your imported history touched it. The imported request count and methods are kept when the agent requests it later. |

See [Proxy import → Troubleshooting](proxy-import.md#troubleshooting) for every message.

## Navigator

### Settings shows Stopped

The Navigator in the hub hit an error it can't recover from, and it stays stopped until its settings change. The reason is shown under the checkbox in **Settings** and in the **Navigator** row of the Setup checklist:

| Reason shown | Fix |
|---|---|
| *The API key was rejected.* | Save a valid key: paste it into **API key** and click **Save key**. |
| *This key isn't allowed to use that model.* | Change **Model** to one the key can use, or save a different key. |
| *That model wasn't found.* | Correct the model id in **Model**. |

Saving a new key or model restarts the Navigator, and the pill goes back to **Running**. Click **Test connection** first to check the key and model without waiting for an assessment. If the reason was a key from the hub's environment, save a working key in Settings (it takes the environment key's place), or restart the hub with a valid `ANTHROPIC_API_KEY`.

### Other Navigator problems

The `[navigator]` lines below appear in the hub's terminal when the Navigator runs in the hub, and in its own terminal under `npm run validator`.

| Symptom | Cause and fix |
|---|---|
| The **Run the Navigator in the hub** box is greyed out | No key is available. Save one in **API key**, or start the hub with `ANTHROPIC_API_KEY` set. |
| The pill says **Off**, and the box is ticked but greyed out | The Navigator was turned on with a key from the hub's environment, and the hub was restarted without it. Save a key in Settings, or restart the hub with `ANTHROPIC_API_KEY` set. |
| **Test connection** fails | The message says why: a rejected key, a model the key can't use, an unknown model, rate limiting, or *Couldn't reach the Anthropic API* (check your network). It tests the *saved* key and model, so save a new key before testing it. |
| `npm run validator` prints `` [navigator] The API key was rejected. Set ANTHROPIC_API_KEY (or run `ant auth login`). Exiting. `` and exits with code 1 | The API rejected the credentials, or there were none (*No API key is set.*). Export a valid `ANTHROPIC_API_KEY` in the same shell and start it again. It also exits with *That model wasn't found. Check SPECTRA_VALIDATOR_MODEL.* or *This key isn't allowed to use that model.* — fix the model id. |
| `[navigator] model call failed: …` | The reason follows. For a rejected key, a forbidden model or an unknown model, see the rows above. Anything else — rate limiting, a network problem, another API error — doesn't stop it: it keeps running and tries again after the next change. In Settings it appears as *Last error: …*. |
| `[navigator] model declined to assess this state; skipping cycle.` | The model refused that assessment. It tries again after the next change. |
| No leads appear | The map is empty, or it hasn't been quiet long enough: it waits for 2.5 s without events (`SPECTRA_VALIDATOR_IDLE_MS`) and runs at most every 15 s. Check Settings for *N assessments · last …*, or the terminal for `posted N assessment(s)`. |
| Leads keep being rewritten, and both terminals log `posted N assessment(s)` | The Navigator is on in Settings **and** `npm run validator` is running, so every change is assessed twice. Stop one of them. |
| Leads change when you mark triage or edit the scope | Expected: any change to the map, including triage marks and scope changes, makes the Navigator reassess. |
| Some targets never get a lead | The digest holds 200 targets, attack surface first; on a bigger map the oldest files and commands drop out first, then the oldest surface. Out-of-scope targets never get leads. |
| Stale leads | Leads persist until the Navigator assesses that target again; stopping the Navigator leaves them in place. |
| The key is gone after a restart | The hub was started with a different `SPECTRA_SETTINGS`, or as a different user. The key lives in that one file. |

## Actions and the Interpreter

`GET /health` has the numbers behind this section: `actions` (`total`, `unread`, `open`) and `interpreter` (`mode`, `status`, `waiting`).

```bash
curl -s http://127.0.0.1:4317/health
```

### An action says Not read

The hub recorded the call and couldn't tell, from the call or its output, everything it touched: a script it couldn't open or one in another language, a scanner or a sweep whose output it couldn't read in full, a URL built from a value it couldn't resolve, a program it doesn't know. The row in **Oversight → Actions** gives the reason. It stays *Not read* until one of three things happens:

- **Spectra reads its result lines.** When the output pairs statuses with addresses and every such line can be placed, the row turns to *Read* by itself. See [Interpreter → Result lines](interpreter.md#result-lines).
- **You dismiss it.** Click **Dismiss** when nothing in it needs mapping — `docker ps`, a local script. **Dismiss all** settles every open one.
- **The Interpreter reads it.** Turn it on in **Settings → Interpreter**. See [Interpreter](interpreter.md) for what that sends off your machine.

If commands you'd expect Spectra to read are flagged, check the reason against [what Spectra can read on its own](interpreter.md#what-spectra-can-read-on-its-own):

| Reason | Likely cause |
|---|---|
| *A URL is built from a value Spectra couldn't resolve*, or *curl was given a target Spectra couldn't resolve* | The value comes from something the hub can't know — another command's output, an environment variable set outside the command — or from a file it couldn't open. `curl "$BASE/api"` is read when `BASE=…` is assigned in the same command or in a script the hub read. |
| *Runs a script …* or *Runs code through sh …* for a shell script | The hub couldn't open the script: it's outside the scope's directories, over 512 KB, on another machine from the hub, or `SPECTRA_READ_FILES=0` is set in the hub's environment. |
| *Runs code through python3 …* | The code builds its addresses, or the hub couldn't read all of it. It stays *Not read* unless its output has result lines. Code whose addresses are all written out in full is read. |
| *Works a page in a browser …*, and it stays open | The driver hasn't listed the browser's network requests since it last worked a page. Ask it to, or [import the proxy history](proxy-import.md) and dismiss the item. |
| *A tool call with no target Spectra can read*, for a tool that never touches the target | It's an MCP tool the hub knows nothing about. Click **Local tool** on the row and its server's calls stop being listed. |
| *Sweeps N addresses …*, still open after the command returned | The output had no status lines, some of them couldn't be tied to one address, or it was cut short. What was read is on the map. |

### Nothing is interpreted

The Interpreter is on, but actions stay *Not read*. It can only read an action whose output reached the hub and is still held there. Check, in this order:

| Cause | How to tell | Fix |
|---|---|---|
| No key | The **Read** menu is greyed out with *Add an API key above first*. The pill may still say **Running**. | Save a key under **Navigator** in Settings, or start the hub with `ANTHROPIC_API_KEY` set. |
| Output forwarding is off | `SPECTRA_HOOK_OUTPUT=0` is set in the environment Claude Code runs in. | Unset it and start Claude Code again. |
| The session reports through the log observer, not hooks | The **Claude Code hooks** row in the Setup checklist says *No hook events yet*. | Install the hooks and restart the session — see [Hooks aren't firing](#hooks-arent-firing). The observer doesn't carry output. |
| The hub was restarted | The actions are from before the restart. `interpreter.waiting` in `GET /health` is `0`. | Output is held in memory only, so it's gone. Dismiss those actions; new ones will be read. |
| The command ran in the background | The reason is *Runs in the background; read when the driver checks its output*. | Its output arrives when the driver reads the task's output — the output file, `BashOutput` or `TaskOutput` — and is then read like any other. If the driver never reads it, or the hub was restarted in between, dismiss the action. |
| The command printed nothing | An action with no output is never queued for the Interpreter. If it wrote its results to a file inside the scope (`>`, `tee`, a scanner's `-o`), the hub reads that file instead; otherwise there is nothing to read. | Dismiss it. |
| More than 300 unread actions piled up while it was off | Only the newest 300 keep their output. | Dismiss the older ones. |
| It's waiting its turn | Settings shows *N queued*. It reads up to five actions per request, at least four seconds apart. | Wait. |

### An action says Nothing to map, or Couldn't read

| State | Meaning |
|---|---|
| *Nothing to map* | The Interpreter read it and reported no targets, or every target it reported was dropped — out of scope, already on the map, or not shown by the output. *N left out* on the row counts the dropped ones. With a note that starts *Spectra:*, the hub read the result lines itself and no address answered. |
| *Couldn't read* | Three model calls failed — rate limiting, a network problem, another API error — or the model declined to read it or left it out of its answer. The note says which. It still counts as not read: dismiss it, or change the key, model or mode in Settings, which restarts the Interpreter and reads it again while the hub still holds its output. |

Neither is a statement that the command touched nothing. If the action matters, open it in **Target** and look at what the command did.

### The Interpreter shows Stopped

It hit an error it can't recover from, and stays stopped until its settings change. The reason is under the **Read** menu in **Settings**:

| Reason shown | Fix |
|---|---|
| *The API key was rejected.* | Save a valid key under **Navigator**. |
| *This key isn't allowed to use that model.* | Change **Model** under **Navigator** to one the key can use, or save a different key. |
| *That model wasn't found.* | Correct the model id. |

The key and model are the Navigator's, so fix them there and use **Test connection** to check. Saving restarts the Interpreter, and it reads the actions that were waiting: nothing is lost while it's stopped.

### Other problems

| Symptom | Cause and fix |
|---|---|
| A target shows **output** as its source and you can't find the request | There wasn't one. It was read out of a command's output by the local URL scan or the Interpreter. Open it in **Target**: *read by* says which, and the *found* edge leads to the command. |
| A target the Interpreter added doesn't exist | The model read the output wrongly, or the output was written to mislead it. The checks keep such a target in scope and unmapped, not correct. See [What can still go wrong](interpreter.md#what-can-still-go-wrong). |
| URLs a command printed aren't on the map | The local scan adds only absolute `http(s)` URLs on in-scope hosts, and nothing when no scope is set. Relative paths are read only from the result lines of an unread action, where a status is printed beside them; otherwise they need the Interpreter. |
| Most of a wordlist isn't on the map | Expected. A sweep's addresses are mapped only when the output shows they answered; 404, 410, 421 and 000 stay off. The action's note gives the counts. |
| A target shows **output** and *read by: result lines* | The hub read it from a status line in a command's output, and the command wasn't known to request it. The *evidence* property is the line. |
| An out-of-scope URL in a command's output wasn't flagged | Expected. Printing a URL isn't contacting it, so it's ignored rather than flagged. |
| `[interpreter] model call failed: …` in the hub's terminal | The reason follows. Fatal ones stop it (see above); anything else is retried after 30 seconds. |
| **Dismiss** is missing | You're replaying a recorded session. Go **Back to live**. |
| The Setup checklist's **Actions** row shows a warning | At least one action is unread. It clears when they're all dismissed or read. |
| Everything gets flagged as *Spectra doesn't know the … command* | The hub recognizes local text utilities, common build and test tools, HTTP clients and scanners. Anything else is flagged so that nothing goes unaccounted for. Dismiss them. |

## Audit log fails verification

The footer shows *Audit log FAILED at line N: reason*, or `npm run verify` prints `FAIL`.

| Message | What to do |
|---|---|
| *line is not valid JSON* | Usually a line cut off when the hub was killed mid-write, or an edit. Compare against a backup. |
| *hash mismatch (line contents were changed)* | That line was edited after it was written. Treat everything from that line on as untrusted. |
| *sequence number is …* / *previous-hash link is broken …* | Lines were removed, inserted or reordered. The same applies. |
| *line has no hash …* | A log from before hash chaining, or a hand-added line. |
| *recorded head … is not in the log (log was rewritten)* | The log was rewritten since you recorded that head, even though its chain is consistent. |
| *log file not found* / footer *Audit log: log file not found* | No log for that session id. MCP annotations are in the live session's log, or under `mcp` if they arrived before any session started. |
| `no audit logs in <dir>` | `npm run verify` is looking in a different directory from the hub. Set `SPECTRA_DATA_DIR` the same for both. |
| Footer *Audit log: audit log disabled* | The hub runs with `SPECTRA_PERSIST=0`. |

A failure means the file no longer matches what was written; it doesn't say who changed it or how. Keep the failing file as it is for investigation. See [Security → The audit log](security.md#the-audit-log).

## Dashboard odds and ends

| Symptom | Cause and fix |
|---|---|
| **Replay** shows no sessions | The audit log is off (`SPECTRA_PERSIST=0`), or nothing has been recorded yet. |
| The graph stopped following new targets | You zoomed or panned. Click **⤢** to fit and follow again. |
| Most of the graph is faded and can't be clicked | A filter is set, possibly from the Surface view — the two share one filter. Click **Clear** in the filter bar at the top left of the graph. |
| The graph shows only session roots, or the attack surface is missing | A layer is switched off. Click **Surface** or **Activity** at the top left of the graph. |
| Surface says *Nothing matches these filters* | The same filter. Click **Clear** in the filter bar. Tag chips combine: a target must carry every selected tag. |
| A target has no tags, or a tag looks wrong | Tags come from the hostname and route alone. They're a sorting aid, not a finding. See [Dashboard → Tags](dashboard.md#tags). |
| The map and triage marks are gone after a restart | The hub restores the engagement from the audit log, so this means the log is off (`SPECTRA_PERSIST=0`), the hub was started with `SPECTRA_RESUME=0`, or it's using a different `SPECTRA_DATA_DIR`. Look for `[spectra] restored the engagement: …` in the startup output. The marks are still in the session's log — open it in **Replay**. |
| Triage controls are greyed out | You're replaying a recorded session, where marks are read-only. Go **Back to live**. |
| A triage menu snaps back, or Target says *Couldn't reach the hub* | The hub is down, or the target isn't on the live map any more (for example after a new engagement). |
| **Export CSV** is greyed out | No rows match the filter. |
| **Files** says *No scope paths set* | The scope has no paths. |
| A file the agent clearly read shows *never opened* | It was read through a shell command (`cat`, `sed`, …). Only structured tools count toward file coverage. |
| No desktop alerts | `SPECTRA_NOTIFY=0`; on Linux, `notify-send` isn't installed; or your system's notification settings block them. Alerts are also collapsed to one every 5 seconds. |
| The map is cluttered with old sessions, or still shows a demo | The hub keeps the engagement across restarts. Click **Settings → New engagement** for a clean map; recorded sessions stay available in Replay. |

---

**Next:** back to the [documentation index](README.md)
