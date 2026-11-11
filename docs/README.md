# Spectra documentation

Spectra is a live attack-surface map for authorized, AI-assisted bug hunting. A local hub records what a Claude Code agent does — every file it reads, command it runs and URL it requests — and draws it as a map of hosts, endpoints and parameters, flags anything outside the scope you authorized, and keeps a tamper-evident log of the whole engagement. These pages cover installing it, connecting a real session, reading the dashboard and the Navigator, and the details behind each part. Read them in this order:

1. [Getting started](getting-started.md) — requirements, install, `npm start`, the two demos, and what you're looking at.
2. [Setup](setup.md) — the full setup guide: scope, Claude Code hooks, the MCP server, the Navigator, proxy import, checking it all works, uninstalling.
3. [Dashboard](dashboard.md) — a tour of every panel and view, the graph controls, and what the colours mean.
4. [Navigator](navigator.md) — the read-only second model that scores leads and gives verdicts on findings.
5. [Proxy import](proxy-import.md) — putting HAR proxy history on the same map, and what is kept and dropped.
6. [Configuration](configuration.md) — every environment variable and the config file format.
7. [Reference](reference.md) — the MCP tools, the hub's HTTP API, and the event and trust model.
8. [Security](security.md) — local-only binding, trust tiers, scope checks and their limits, the hash-chained audit log, what is stored where.
9. [Troubleshooting](troubleshooting.md) — common failures and how to fix them.

New here? Start with [Getting started](getting-started.md). To report a vulnerability in Spectra itself, see [SECURITY.md](../SECURITY.md).

---

**Next:** [Getting started](getting-started.md)
