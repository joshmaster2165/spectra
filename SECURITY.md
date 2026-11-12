# Security

## Responsible use

Spectra is an oversight tool for security testing you are **authorized** to perform:

- your own code and infrastructure,
- a contracted penetration test, within its rules of engagement, or
- a bug bounty program, within its published scope and rules.

Set Spectra's scope to match your authorization before you start, and treat every out-of-scope flag as a stop sign: pause the agent, find out why, and don't continue against that target. Spectra records and flags; it doesn't enforce. Staying in scope is the operator's responsibility.

The Navigator is built for triage: it ranks where to look and checks findings against their evidence. It is deliberately limited to direction and prioritization and does not produce exploit payloads.

## Reporting a vulnerability in Spectra

Please report vulnerabilities in Spectra itself privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability**. Don't open a public issue for a security problem.

Useful details include the affected component (hub, hook, MCP server, Navigator, Interpreter or dashboard), the version or commit, steps to reproduce, and the impact you see. You'll get an acknowledgement, and the fix will be credited to you unless you'd rather it wasn't.

Areas of particular interest:

- anything that lets a non-local web page read hub state or post events,
- ways for the agent's annotation channel to forge scope, operator verdicts or Navigator output,
- ways for text in a target's responses to put out-of-scope or unevidenced targets on the map through the Interpreter, or to get command output past its masking,
- audit-log tampering that `npm run verify` fails to detect,
- the hook altering, blocking or delaying a Claude Code tool call.

Known, documented limits — such as any local process being able to post events, or dynamically built shell paths escaping scope parsing — are described in the README and aren't vulnerabilities on their own.
