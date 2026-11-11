# Dashboard

The dashboard at **http://127.0.0.1:4317** is a live view of the hub's state: one map built from everything the agent touched, everything it reported, and any proxy history you imported. This page tours every part of it — the top bar, the five views of the Attack Surface panel, Activity, Oversight, Chain and Coverage, replay, reports, desktop alerts and the footer — and explains what the colours and marks on the map mean. The dashboard is read-only toward the agent: nothing you do here sends anything to Claude Code.

![The Spectra dashboard: the attack-surface graph with an out-of-scope request in red, the activity stream, findings with Navigator verdicts, the attack chain and coverage](media/dashboard.png)

## Layout

| Position | Panel | Header shows |
|---|---|---|
| Left, full height | **Attack Surface** — Graph, Tree, Surface, Files, Target | *N targets · M links* |
| Top right | **Activity** — Stream, Objects | *N events* (the most recent 500 are kept on screen) |
| Middle right | **Oversight** — Findings, Navigator, Scope | *in scope*, or *N violations* in red |
| Bottom left | **Chain** | *N steps* |
| Bottom right | **Coverage** | |

Selecting a target is shared across the panels: select it in one view and it stays selected when you switch. Double-clicking a target — or clicking one in Activity, Oversight or Chain — opens it in the **Target** view.

## Top bar

| Item | What it does |
|---|---|
| **Session** | The id of the most recent session to start, or *Awaiting agent*. |
| **Scope badge** | *N paths · M hosts*, or *unset* before any scope exists. A red *N out of scope* pill appears with the first violation. Click it to open **Oversight → Scope**. |
| **Import HAR** | Import proxy history from a HAR file. Parsing happens in the browser; only names reach the hub. A status pill reports the result (hover for the full summary, click to dismiss). Hidden during replay. See [Proxy import](proxy-import.md). |
| **Report** | Download a Markdown report of what's on screen. See [Report](#report). |
| **Replay** | Switch to replaying a recorded session. See [Replay](#replay). |
| **Live / Offline** | Whether the dashboard's WebSocket to the hub is connected. It reconnects every second while offline. Shows **Replay** instead during replay. |
| Clock | The current time in UTC. |

The browser tab title also counts violations — *(3) Spectra* — so you can see them from another tab.

## Reading the map

Every target has a **status**, shown as the colour of its outline and icon:

| Colour | Status | Meaning |
|---|---|---|
| Grey | `unexplored` — shown as **unmapped** throughout the dashboard | Known but not touched: seen only in proxy history, mapped by the agent but not yet probed, or a tool call on it failed. |
| Orange (leaves pulse) | `active` | Being worked on: a tool call touched it and hasn't returned yet, or the agent mapped it as active. |
| Green | `complete` — shown as **confirmed** throughout the dashboard | The tool call that touched it returned successfully, or the agent marked it complete. It's not a security verdict. |
| Blue | Session root | One per Claude Code session (or demo, or proxy import). |

Marks layered on top:

| Mark | Meaning |
|---|---|
| **Red** outline, red label, red-filled leaf, pulsing dashed red ring | A tool call on this target went **out of scope**. |
| Pulsing dashed **orange halo** | The [Navigator](navigator.md) recommends **pursue** for this target. |
| Dashed white ring | The selected target. |

## Attack Surface panel

The panel has five views, in this order: **Graph, Tree, Surface, Files, Target**.

The map has two kinds of structure. Each session has a root with a category per kind of tool — `files`, `searches`, `commands`, `web`, `agents`, `mcp`, `other` — holding one leaf per thing the agent touched. Network targets also build an attack-surface tree under `hosts`: **domain → subdomain → endpoint → parameter**. Numeric ids, UUIDs and long hex strings in URL paths collapse to `:id`, and token-like segments to `:token`, so `/api/users/42/orders` and `/api/users/97/orders` are one endpoint, `/api/users/:id/orders`. A labelled *request* edge links each tool call to the host or endpoint it hit.

### Graph

A force-directed node-link map that grows as the agent works.

| Control | Action |
|---|---|
| Scroll | Zoom toward the cursor (25% to 600%). |
| Drag the background | Pan. |
| **+** / **–** | Zoom in or out around the centre. The current zoom is shown between them. |
| **⤢** (fit) | Frame the whole map and re-engage **auto-follow**. |
| **?** | Show or hide the icon legend. |
| Click a node | Select it. |
| Double-click a node | Open it in **Target**. |

**Auto-follow.** While following, the graph keeps re-framing itself as new targets arrive, so discoveries never land off-screen. Zooming or panning turns following off so the view stays where you put it; the fit button turns it back on.

**Labels.** Session roots, categories, endpoints, parameters, out-of-scope targets and the selected node are always labelled. Other leaves (files, commands, searches) get labels above 170% zoom; below that, hover for the name. Edge labels appear above 80% zoom.

**Icons.** Each node carries an icon for its type. The **?** legend lists them:

| Icon | Type |
|---|---|
| Session | A session root |
| Files | A file the agent read or wrote |
| Search | A `Grep` or `Glob` |
| Shell | A shell command |
| Web | A `WebFetch` or `WebSearch` |
| Subagent | A `Task` or `Agent` call |
| MCP | A call to an MCP tool |
| Domain | A registrable domain, such as `example-shop.test` |
| Host | A subdomain, such as `api.example-shop.test` |
| Endpoint | A normalized route on a host |
| Param | A parameter name on an endpoint |
| Proxy import | The root of an imported proxy history |

Category nodes (`files`, `commands`, …) use their category's icon, the `hosts` category uses a server icon, and anything else gets a generic one.

### Tree

<img src="media/tree.webp" alt="The Tree view: expanding a session root into its categories, and the hosts category into domains, subdomains, endpoints and parameters, with status chips and an out-of-scope row in red" width="100%">

<sub>Walking the Tree view after the recon demo.</sub>

The same map as a collapsible outline: roots, then their categories, then leaves.

- Click the caret to collapse or expand a branch. Everything starts expanded.
- Within a branch, containers sort before leaves, then alphabetically.
- Container rows show how many leaves sit beneath them.
- The right-hand columns show the tool that touched a leaf (or the node's kind for containers) and its status chip.
- Out-of-scope rows have a red bar and an *out of scope* tag.
- Click a row to select it; double-click to open it in **Target**.

### Surface

<img src="media/surface.webp" alt="The Surface view: a sortable table of endpoints filling in as the recon demo runs, sorted and filtered by status and by Navigator lead" width="100%">

<sub>Sorting and filtering the Surface table while the attack surface comes in.</sub>

A live, sortable table of the attack surface — the view to use when the graph gets too big to read.

**Show** switches between three tables (default **Endpoints**):

| Show | Columns |
|---|---|
| **Endpoints** | `#` (discovery order), **Endpoint**, **Host**, **Status**, **Source**, **Params**, **Requests**, **Lead**, **Findings** |
| **Hosts** | `#`, **Host**, **Domain**, **Status**, **Endpoints**, **Source**, **Best lead** (the highest-scored lead among its endpoints) |
| **Params** | `#`, **Param**, **Endpoint**, **Host**, **Status**, **Source** |

What the columns mean:

| Column | Meaning |
|---|---|
| `#` | The order the target first appeared on the map. |
| **Status** | *unmapped*, *active* or *confirmed* — see [Reading the map](#reading-the-map). |
| **Source** | **agent** — touched or reported by the agent (hooks, observer or MCP); **proxy** — seen only in imported proxy history; **both** — the agent touched it and the proxy saw it. |
| **Params** / **Endpoints** | How many parameters sit under the endpoint, or endpoints under the host. |
| **Requests** | How many requests the imported proxy history had for it. |
| **Lead** | The Navigator's recommendation (*pursue*, *watch* or *skip*) and confidence. Hover for its rationale. |
| **Best lead** | The strongest lead on the host or any of its endpoints. |
| **Findings** | How many findings reference it. |
| **Domain** | The domain a subdomain belongs to; empty for a domain itself. |

**Sorting.** Click a column header to sort by it; click it again to reverse. Numeric columns sort highest first on the first click. **Lead** ranks *pursue* above *watch* above *skip*, then by confidence. The default sort is newest first (`#` descending), so new discoveries appear at the top as they come in, and new rows briefly highlight.

**Filters.**

- A search box, matching the target and its host.
- Status chips: **All**, **Unmapped**, **Active**, **Confirmed**.
- **Leads only**: just the rows the Navigator has scored.

The count on the right shows how many rows match, for example *12 of 87 endpoints*.

Click a row to select it; double-click to open it in **Target**.

### Files

Review coverage of the in-scope code: every file under the scope paths, marked by how the agent touched it.

- The header reads *X of Y files opened (Z%) · N edited*.
- Each directory shows a coverage bar with *opened/total*.
- Files are marked **read**, **edited** or **never opened**, with read and write counts (`3r 1w`) and the time of the last touch.
- **Unopened only** hides everything the agent has already opened — a list of what it hasn't looked at.
- **Refresh** re-lists the files from disk. The list also reloads when the scope changes.

Only files touched through structured tools (`Read`, `Edit`, `Write` and similar) count; paths pattern-matched out of shell commands don't. The listing skips `node_modules`, `.git`, `dist`, `build`, `.next`, `vendor`, `__pycache__`, `.venv`, `venv`, `target` and `coverage`, doesn't follow symlinks, and stops at 20,000 files. With no scope paths set, the view says so.

### Target

One target in detail. It shows the selected target, or the first session root if nothing is selected.

- **Header**: its kind, label, status, and an *out of scope* tag if it went out of scope.
- **Ego graph**: the target in the middle with up to 16 neighbours around it (*+N* for the rest). Click a neighbour to move to it.
- **Properties**: id, kind, category, parent (click to move to it), importance, and anything else recorded about it — for example the tool and key for a tool-call leaf, the host and an example URL for an endpoint, or *seen in*, *requests*, *methods* and *status codes* from proxy history.
- **Scope violations**: time, access, target and tool for each violation on this target.
- **Connections**: every edge in and out, with its label (*contains*, *parent*, *request*, or the agent's own label) and the other end's status.
- **Activity**: the last 30 tool calls on this target with their result (*OK*, *ERR*, or *…* while running), and the chain steps that reference it.

## Activity

**Stream** shows the agent's reasoning and tool calls, newest first (the last 120).

- Reasoning comes from the log observer (the agent's thinking and replies, up to 400 characters each), from your prompts via hooks (tagged *operator prompt*), from `log_thought`, and from proxy imports (tagged *proxy import*).
- Tool calls show the tool and its main argument. Out-of-scope calls have a red bar and an *out of scope* tag.
- Click a tool call to open its target.

**Objects** lists every leaf on the map as a card with its category and importance. Sort by **Importance**, **Category** or **Status**; click a card to open it.

## Oversight

### Findings

Findings sorted by status (confirmed, suspected, fixed, dismissed), then severity, then confidence. Each row shows:

- severity, title, and the reporter's confidence as a bar and percentage;
- the finding's id and file location;
- the reporter's own status claim;
- *agent-reported* if it came through the MCP server — a claim to check;
- the Navigator's verdict and confidence, if it has given one (hover for its rationale);
- your verdict, or *Unreviewed*.

Click a finding to expand it:

- the description;
- **Evidence trail**: the chain steps that led to it, in order (click one to open its target);
- **Remediation**: edits the agent made to the finding's file, linked automatically by the hub. If the finding has no file location, edits can't be linked;
- **Objects**: the targets that support it;
- **Your review**: a notes box and **Verified**, **Rejected** and **Needs info** buttons. Your verdict is recorded by the hub as an operator event, separate from the agent's claim and the Navigator's verdict.

### Navigator

The Navigator's leads, sorted pursue, watch, skip, then by confidence. Each shows the recommendation, a title, the confidence, the suspected bug class, the target, and a one-line rationale. Click one to open its target. Before the Navigator has posted anything, this tab tells you how to start it. See [Navigator](navigator.md#reading-its-output).

### Scope

- **Set by**: *Operator config* (the config file, environment or `POST /scope`), *Session working directory*, or *Not set*.
- **Paths** and **Hosts** in force.
- **Violations**, newest first: time, severity (*high* or *med*), access (read, write, exec or network), the target, the tool, and *parsed from shell* when the target was pattern-matched out of a shell command. Click one to open its target.

## Chain

The attack chain the agent built with `update_chain`, drawn left to right: each step sits one column after the steps it follows. Confirmed steps have a green bar. Hover a step for its detail; click it to open the first target it references.

## Coverage

A spectrum bar and counts of **unmapped**, **active** and **confirmed** targets, the share that's confirmed (*coverage*), and the stage of the engagement: **Discovery** (targets on the map), **Linking steps** (chain steps exist), **Confirmed paths** (a chain step is confirmed).

## Replay

Click **Replay** to load a recorded session from the audit log and play it back through the same reducer the live view uses. It opens the current session if it has been recorded, otherwise the most recent one.

| Control | Action |
|---|---|
| Session list | Pick any recorded session. |
| Step back / Play / Step forward | Move one event at a time, or play. |
| Scrubber | Drag to any point. Markers show scope violations and findings. |
| Position | *event/total* and the event's time. |
| **1× 4× 16× 64×** | Playback speed (default 4×). Playback follows the recorded gaps between events, sped up, with no gap longer than 0.8 s. |
| **Back to live** | Return to the live view. |

While replaying, every panel shows the session as of the scrubber position, **Report** exports that state, and the footer verifies the replayed session's log. Replay needs the audit log, so it has nothing to show if the hub runs with `SPECTRA_PERSIST=0`.

## Report

**Report** downloads `spectra-report-<session>.md`, a Markdown summary of what's on screen:

- the session id, time span, tool-call count (and failures) and files opened and edited;
- the scope and who set it;
- a summary table of findings by severity and your verdicts, and the number of violations;
- each finding with its severity, the agent's confidence and status, your verdict and note, location, description, evidence trail and remediation;
- a table of scope violations;
- the files edited;
- the audit log's verification result and **head hash**, with the `npm run verify` command to check it later. See [Security](security.md#the-audit-log).

Navigator leads and verdicts aren't included in the report.

## Desktop alerts

Each scope violation raises a desktop notification — *Spectra: out-of-scope network*, with the target — through `osascript` on macOS and `notify-send` on Linux. Bursts are collapsed: at most one alert every 5 seconds, and the next one says how many were held back (*+3 more*). If nothing appears, check your system's notification settings. Turn alerts off with `SPECTRA_NOTIFY=0`.

## Footer

| Item | Meaning |
|---|---|
| **Hub** | The address the dashboard is connected to. |
| **Hooks · Observer · MCP** | The three ways the agent's activity reaches the hub. |
| **Audit log** | The session's audit-log status, rechecked every 30 seconds. See below. |
| **Last event** | The time of the most recent event. |

The audit-log status reads one of:

| Status | Meaning |
|---|---|
| *Audit log verified · N events · head 1a2b3c4d5e6f* | The hash chain is intact. Click to copy the full head hash — record it somewhere else to detect a later rewrite. |
| *Audit log FAILED at line N: reason* | The chain is broken at that line. Click to check again. See [Troubleshooting](troubleshooting.md#audit-log-fails-verification). |
| *Audit log: audit log disabled* | The hub runs with `SPECTRA_PERSIST=0`. |
| *Audit log: log file not found* | Nothing has been recorded for this session. |
| *Audit log —* | No session yet. |

---

**Next:** [Navigator](navigator.md)
