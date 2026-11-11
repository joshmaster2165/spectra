# Configuration

Spectra is configured with one optional file, `spectra.config.json`, which holds the scope, and a set of environment variables. This page lists every variable the code reads, which process reads it, and its default. The hub reads its settings once at startup, so restart `npm start` after changing them; client processes (the hook, MCP server, Navigator, importer and demos) read theirs each time they start.

## The config file

```json
{
  "scope": {
    "paths": ["/path/to/target-repo"],
    "hosts": ["example-shop.test"]
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `scope.paths` | array of strings | Directories the agent may touch. Everything beneath each one is in scope. Use absolute paths; `~` is expanded. |
| `scope.hosts` | array of strings | Hostnames the agent may contact. Each includes its subdomains. Lowercased; no wildcards, no ports. |

- **Location.** `spectra.config.json` in the root of the Spectra checkout (it's git-ignored). `SPECTRA_CONFIG` points the hub at another file. `spectra.config.example.json` is a template.
- **When it's read.** Once, when the hub starts. To change the scope while the hub runs, use [`POST /scope`](reference.md#post-scope).
- **Errors.** A missing file, or one that isn't valid JSON, is ignored without an error: the hub starts with no configured scope. Check the startup line `[spectra] scope: …`.
- **No paths.** If no paths are configured, each session's working directory becomes the path scope as the session starts. Configured hosts are in scope from startup; with no hosts configured either, there is no scope at all until the first session starts. See [Setup → With no config, or hosts only](setup.md#with-no-config-or-hosts-only).
- **Loopback.** `localhost`, `127.0.0.1` and `::1` are always added to the hosts.

Other keys in the file are ignored.

## Environment variables

### Hub (`npm start`, `npm run dev`)

| Variable | Default | Effect |
|---|---|---|
| `SPECTRA_PORT` | `4317` | Port for the hub and the dashboard. The hub always binds to `127.0.0.1`. |
| `SPECTRA_CONFIG` | `spectra.config.json` in the Spectra root | Path to the scope config file. |
| `SPECTRA_SCOPE_PATHS` | | Comma-separated scope paths. When set, replaces the config file's `paths`. |
| `SPECTRA_SCOPE_HOSTS` | | Comma-separated scope hosts. When set, replaces the config file's `hosts`. |
| `SPECTRA_DATA_DIR` | `~/.spectra/sessions` | Where the hash-chained audit logs are written. Created with owner-only permissions. |
| `SPECTRA_PERSIST` | | `0` turns the audit log off: nothing is written to disk, the footer shows *audit log disabled*, and replay has no sessions. |
| `SPECTRA_OBSERVER` | | `0` turns the log observer off (no reading of Claude Code transcripts). |
| `SPECTRA_PROJECTS_DIR` | `~/.claude/projects` | Where the log observer looks for Claude Code transcripts. |
| `SPECTRA_REPLAY` | | `1` makes the log observer read existing Claude Code transcripts from the beginning — including old sessions — instead of only new activity. It doesn't load Spectra's own audit logs; use [Replay](dashboard.md#replay) for those. |
| `SPECTRA_NOTIFY` | | `0` turns desktop alerts for scope violations off. |

### Clients

| Variable | Default | Read by | Effect |
|---|---|---|---|
| `SPECTRA_HUB` | `http://127.0.0.1:4317` | Hook, MCP server, Navigator, importer, demos | The hub's base URL. Set it whenever you change `SPECTRA_PORT`. Use `127.0.0.1`, not `localhost`: the hub only listens on IPv4 loopback. |
| `SPECTRA_SESSION` | `mcp` | MCP server | The session id the MCP server sends. With the default, the hub attaches annotations to the live Claude Code session; any other value records them under that id. |
| `ANTHROPIC_API_KEY` | | Navigator | API key for the Navigator's model calls. Read by the Anthropic SDK. |
| `SPECTRA_VALIDATOR_MODEL` | `claude-opus-5-5` | Navigator | Model id. |
| `SPECTRA_VALIDATOR_IDLE_MS` | `2500` | Navigator | How long the map must be quiet, in milliseconds, before an assessment. |
| `SPECTRA_DEMO_PACE` | `1` | `npm run demo:recon` | Multiplies the recon demo's pauses. Below 1 is faster. |
| `SPECTRA_DEMO_PHASES` | `all` | `npm run demo:recon` | `map` runs the engagement without the Navigator's leads; `navigator` posts only the leads and verdicts, for a map that's already there. |

The hook runs inside Claude Code, so it sees Claude Code's environment: set `SPECTRA_HUB` in the shell you start Claude Code from. The MCP server is started by Claude Code too; give it variables when you register it, for example `claude mcp add spectra -e SPECTRA_HUB=http://127.0.0.1:4400 -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/packages/server/src/mcp.ts"`.

`npm run verify` also reads `SPECTRA_DATA_DIR`, so set it the same way as for the hub.

## Fixed limits

These aren't configurable, but they're useful to know:

| Limit | Value |
|---|---|
| Request body to the hub | 1,000,000 characters |
| Entries per `POST /import` request | 5,000 (the importers send 1,500 per request) |
| Events kept in the hub's memory for `GET /history` | 50,000 |
| Events kept in the dashboard's timeline (Activity, Target activity) | 500 |
| Files listed for the Files view | 20,000 per scope path |
| Hook timeout to the hub | 300 ms (and a 2-second hook timeout in Claude Code's settings) |
| Desktop alerts | At most one every 5 seconds |
| Audit-log check in the footer | Every 30 seconds |
| Navigator | At most one assessment every 15 seconds; 200 targets per digest (attack surface first); 4,000 output tokens |

## Development

```bash
npm run dev         # hub with reload + Vite dashboard on http://localhost:5173
npm run typecheck
```

`npm run dev` runs the hub with `tsx watch` and the dashboard on Vite's dev server at port 5173. The dev server proxies the dashboard's API calls to `http://127.0.0.1:4317`; that address is fixed in `packages/web/vite.config.ts`, so `SPECTRA_PORT` doesn't apply to it.

---

**Next:** [Reference](reference.md)
