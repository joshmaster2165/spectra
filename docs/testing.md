# Testing

Spectra's tests check one thing above all: that what a Claude Code agent really did ends up on the map, and nothing else does. This page covers how to run them, what each suite proves, and how to add a case when you find a command Spectra reads wrongly.

```bash
npm test
```

It takes about a minute. Everything runs on your machine: the tests start their own hub on a free port with its own temporary data folder, so your real hub on port 4317, your `~/.spectra` folder and your API key are never touched, and no request leaves the machine.

## What you need installed

| | |
|---|---|
| Node.js | 22 or later for the tests |
| `zsh`, `curl`, `jq`, `python3`, `nc` | The end-to-end suites run real commands with them. On macOS they're all there already. On Debian or Ubuntu: `sudo apt-get install zsh jq netcat-openbsd`. |

If one is missing, the two end-to-end suites are skipped with a message that names it, and the rest still run. In CI a missing program is a failure, not a skip.

No scanner needs to be installed. `ffuf`, `gobuster` and `httpx` are replaced by stand-ins that make the same requests and print the same lines.

## The suites

All of them live in [`packages/server/test`](../packages/server/test).

| File | What it proves |
|---|---|
| `shell.test.ts` | The shell expander works out which addresses a command requests: variables, loops over wordlists, `xargs`, functions, scripts, heredocs, curl ranges, `Host:` headers. No hub, no network. |
| `toolmap.test.ts` | Which tool calls are understood and which are flagged as *Not read*, and how an MCP tool's input is read. |
| `results.test.ts` | Result lines, a browser's network log, and the signs that a request never left. |
| `capture.test.ts` | **The main one.** 64 ways Claude Code makes requests, each run for real against the lab app with the real hook around it. |
| `replay.test.ts` | The tool calls of one real Claude Code session, replayed in order, including the calls Claude Code denied. |
| `interpreter.test.ts` | What the hub sends to a model and what it accepts back, against a local stand-in for the API. |
| `persistence.test.ts` | A clean restart, a hard kill, a new engagement and `SPECTRA_RESUME=0`. |

To run one file, or one case by name:

```bash
cd packages/server
node --import tsx --test test/capture.test.ts
node --import tsx --test --test-name-pattern "xargs" test/capture.test.ts
```

## The lab app and ground truth

The end-to-end suites don't trust Spectra's own record. They start a small, deliberately vulnerable web app ([`test/lab/app.ts`](../packages/server/test/lab/app.ts)) with four sites — `shop`, `api`, `admin` and `staging` under `lab.localhost` — and that app records every request it receives. That record is the ground truth.

For each case the test runs the command for real, sends the hook events Claude Code would send, and then compares the lab's record with the map:

- Every route that **answered** must be on the map, or the call must be listed as *Not read*. A route that is missing with nothing saying so is a failure.
- Every probe that found **nothing** (a 404, or no such site) must be off the map.
- Every **query parameter** sent to a route that answered must be on the map, by name.
- **Nothing** may be on the map that was neither requested nor read from the command's output.
- A finished call leaves no target marked as still being worked on.

Each case starts from an empty map, so an earlier case can't cover for a later one.

Two cases are expected to end as *Not read*, and the suite checks that they are exactly those two: a browser page whose network log is never listed, and an MCP tool whose input names no address. They are the known limits described in [Interpreter](interpreter.md#what-still-isnt-read). If you remove one of those limits, its case will fail and tell you to update it.

## The model stand-in

`interpreter.test.ts` never calls a real model. It points the hub at [`test/lab/model-stub.ts`](../packages/server/test/lab/model-stub.ts), a local stand-in for the API that accepts one made-up key. Its answers are deliberately bad in known ways: some targets are right, some are invented, some are out of scope, and some obey instructions planted in a command's output. It can also refuse. So the tests check the hub's own guard rails — what it masks before sending, and what it throws away when the answer comes back — not the quality of any model.

### Trying a real model

One script does talk to a real model, and it is not part of `npm test`:

```bash
npm run test:model -- --each
```

It runs the Interpreter's real prompt and real answer checks through Claude Code's own login (`claude -p`), so you don't enter an API key, and it uses your Claude Code plan. It prints how many of the expected targets the model found, whether any wrong one was accepted, and which requests the model's safeguards stopped. It does not exercise the Interpreter's own API call, so a result here is a guide to quality, not proof that your key and model behave the same way.

## Adding a case

When Spectra misreads a command on a real engagement, add it before you fix it.

1. If the command only needs expanding (no network), add a line to `shell.test.ts` with the exact URLs it requests.
2. Otherwise add a case to the right group in `capture.test.ts`. Write the command against the lab's sites using the `SHOP`, `API`, `ADMIN` and `STG` variables. The default expectation is that everything that answers is mapped and the call is not left open.
3. Run that one case with `--test-name-pattern` and watch it fail.
4. Fix the hub, and run the whole suite.

If the lab app has no route that shows the behaviour, add one to `test/lab/app.ts`. It is test code, never deployed, and all its "secrets" are fake.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the type check, the dashboard build and `npm test` on every push to `main` and every pull request, on Ubuntu (Node 22 and 24) and macOS (Node 24).

---

**Next:** back to the [documentation index](README.md)
