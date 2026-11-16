// The installed `spectra` command, tested the way a stranger gets it: the package is built and
// packed, the tarball is unpacked into an empty folder with no node_modules, and everything runs
// from there with its own HOME. So this proves the tarball is complete and needs nothing installed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { freePort, run, SERVER_DIR, sleep, tempDir, type RunResult } from "./helpers.ts";

const ROOT = path.resolve(SERVER_DIR, "../..");
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "SessionEnd"];

describe("the installed spectra command", () => {
  let pkg = ""; // the unpacked package
  let home = ""; // a HOME of its own: ~/.spectra and ~/.claude land here
  let project = "";
  let stubBin = ""; // holds a stand-in for Claude Code's CLI that records how it was called
  let claudeLog = "";
  let hub: ChildProcess | undefined;
  let hubUrl = "";
  let hubLog = "";
  let version = "";

  const env = (extra: Record<string, string> = {}) => {
    const e: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ANTHROPIC_|SPECTRA_)/.test(k)) e[k] = v;
    return { ...e, HOME: home, PATH: `${stubBin}${path.delimiter}${process.env.PATH}`, ...extra };
  };
  /** Runs `spectra <args>` from the unpacked package. */
  const spectra = (args: string[], extra: Record<string, string> = {}, cwd = home): Promise<RunResult> =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(pkg, "dist", "cli.js"), ...args], { cwd, env: env(extra) });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  const claudeCalls = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, "utf8").split("\n").filter(Boolean) : []);

  before(async () => {
    const built = await run(process.execPath, [path.join(ROOT, "scripts", "build-dist.mjs")], { cwd: ROOT, timeout: 180_000 });
    assert.equal(built.code, 0, built.stderr);
    const out = tempDir("pack");
    const packed = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", out], { cwd: ROOT, timeout: 120_000 });
    assert.equal(packed.code, 0, packed.stderr);
    const tarball = fs.readdirSync(out).find((f) => f.endsWith(".tgz"));
    assert.ok(tarball, "npm pack produced no tarball");
    assert.equal((await run("tar", ["-xzf", path.join(out, tarball), "-C", out])).code, 0);
    pkg = path.join(out, "package");
    version = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8")).version;

    home = tempDir("home");
    project = tempDir("target-repo");
    stubBin = tempDir("stub-bin");
    claudeLog = path.join(stubBin, "calls.log");
    fs.writeFileSync(path.join(stubBin, "claude"), `#!/bin/sh\necho "$PWD :: $*" >> "${claudeLog}"\n`, { mode: 0o755 });
  });
  after(async () => {
    if (hub && hub.exitCode === null) {
      hub.kill("SIGTERM");
      await new Promise((r) => hub!.once("exit", r));
    }
  });

  it("the tarball holds the built command and nothing that needs installing", () => {
    const top = fs.readdirSync(pkg).sort();
    assert.deepEqual(top, ["LICENSE", "README.md", "dist", "package.json"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "package.json"), "utf8"));
    assert.deepEqual(manifest.bin, { spectra: "dist/cli.js" });
    assert.equal(manifest.dependencies, undefined, "the command is bundled whole; a dependency here would have to be installed");
    for (const f of ["cli.js", "hub.js", "mcp.js", "spectra-hook.mjs", "web/index.html", "examples/acme-shop.har"]) assert.ok(fs.existsSync(path.join(pkg, "dist", f)), f);
    assert.match(fs.readFileSync(path.join(pkg, "dist", "cli.js"), "utf8"), /^#!\/usr\/bin\/env node\n/);
  });

  it("prints its version and help, and rejects a command it doesn't know", async () => {
    assert.equal((await spectra(["--version"])).stdout.trim(), version);
    const help = await spectra(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /spectra init \[project-dir\]/);
    const bad = await spectra(["frobnicate"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown command "frobnicate"/);
  });

  it("starts a hub that serves the dashboard", async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    hub = spawn(process.execPath, [path.join(pkg, "dist", "cli.js")], { cwd: home, env: env({ SPECTRA_PORT: String(port), SPECTRA_OBSERVER: "0", SPECTRA_NOTIFY: "0" }), stdio: ["ignore", "pipe", "pipe"] });
    hub.stdout!.on("data", (d) => (hubLog += d));
    hub.stderr!.on("data", (d) => (hubLog += d));
    let up = false;
    for (let i = 0; i < 150 && !up && hub.exitCode === null; i++) {
      up = await fetch(`${hubUrl}/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(100);
    }
    assert.ok(up, `the hub did not start:\n${hubLog}`);

    const page = await (await fetch(hubUrl)).text();
    assert.match(page, /<html data-install="command"/, "the page should know it is the installed command");
    const script = page.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(script, "the dashboard page names no script");
    const js = await fetch(hubUrl + script);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /spectra init/, "the dashboard should suggest spectra commands");
    // Its data lives under this HOME, not the real one.
    assert.match((await (await fetch(`${hubUrl}/health`)).json()).audit.dir, /^~\/\.spectra\/sessions$/);
    assert.ok(fs.existsSync(path.join(home, ".spectra")));
  });

  it("a second hub on the same port says so plainly", async () => {
    const r = await spectra(["start"], { SPECTRA_PORT: new URL(hubUrl).port, SPECTRA_OBSERVER: "0", SPECTRA_NOTIFY: "0" });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /port \d+ is already in use/);
    assert.doesNotMatch(r.stderr, /at .*\(node:/, "no stack trace");
  });

  it("init wires a project: hooks that outlive the package, and the MCP server", async () => {
    const r = await spectra(["init", project]);
    assert.equal(r.code, 0, r.stderr);
    const hook = path.join(home, ".spectra", "bin", "spectra-hook.mjs");
    const mcp = path.join(home, ".spectra", "bin", "spectra-mcp.mjs");
    assert.ok(fs.existsSync(hook) && fs.existsSync(mcp), "the hook and MCP server are copied to ~/.spectra/bin");

    const settings = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(Object.keys(settings.hooks).sort(), [...EVENTS].sort());
    for (const event of EVENTS) assert.deepEqual(settings.hooks[event].map((g: any) => g.hooks[0].command), [`node ${JSON.stringify(hook)}`], event);
    // Nothing points into the package, which npx may delete.
    assert.ok(!JSON.stringify(settings).includes(pkg));

    const add = claudeCalls().at(-1)!;
    assert.equal(add, `${project} :: mcp add --scope local spectra -- node ${mcp}`);
    assert.match(r.stdout, /MCP tools registered/);
  });

  it("init again replaces its own entries and leaves other settings alone", async () => {
    const file = path.join(project, ".claude", "settings.local.json");
    const settings = JSON.parse(fs.readFileSync(file, "utf8"));
    settings.permissions = { allow: ["Bash(ls:*)"] };
    settings.hooks.PreToolUse.unshift({ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] });
    fs.writeFileSync(file, JSON.stringify(settings));
    assert.equal((await spectra(["init", project, "--no-mcp"])).code, 0);
    const again = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(again.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(again.hooks.PreToolUse.map((g: any) => g.hooks[0].command.split(" ")[0]), ["echo", "node"]);
    assert.equal(again.hooks.SessionStart.length, 1);
  });

  it("starting the hub brings the copied hook back in step with the package", async () => {
    const hook = path.join(home, ".spectra", "bin", "spectra-hook.mjs");
    fs.writeFileSync(hook, "// an older version\n");
    // The port is taken, so this exits at once; the refresh happens before the hub starts.
    await spectra(["start"], { SPECTRA_PORT: new URL(hubUrl).port, SPECTRA_OBSERVER: "0", SPECTRA_NOTIFY: "0" });
    assert.equal(fs.readFileSync(hook, "utf8"), fs.readFileSync(path.join(pkg, "dist", "spectra-hook.mjs"), "utf8"));
  });

  it("reads spectra.config.json from the folder it is started in", async () => {
    const cwd = tempDir("with-config");
    fs.writeFileSync(path.join(cwd, "spectra.config.json"), JSON.stringify({ scope: { hosts: ["example-shop.test"] } }));
    const port = await freePort();
    const p = spawn(process.execPath, [path.join(pkg, "dist", "cli.js"), "start"], { cwd, env: env({ SPECTRA_PORT: String(port), SPECTRA_OBSERVER: "0", SPECTRA_NOTIFY: "0", SPECTRA_PERSIST: "0" }), stdio: "ignore" });
    try {
      let health: any;
      for (let i = 0; i < 150 && !health; i++) {
        health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json(), () => undefined);
        if (!health) await sleep(100);
      }
      assert.ok(health, "the hub did not start");
      assert.equal(health.scope.set, true);
      const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
      assert.ok(state.scope.hosts.includes("example-shop.test"), JSON.stringify(state.scope));
    } finally {
      p.kill("SIGTERM");
      await new Promise((r) => p.once("exit", r));
    }
  });

  it("the installed hook reaches the hub", async () => {
    const hook = path.join(home, ".spectra", "bin", "spectra-hook.mjs");
    const send = (payload: object) => run(process.execPath, [hook], { input: JSON.stringify({ session_id: "cli-test", cwd: project, ...payload }), env: { SPECTRA_HUB: hubUrl } });
    await send({ hook_event_name: "SessionStart" });
    await send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "curl -s http://localhost:8080/api/users?id=1" } });
    const state = await (await fetch(`${hubUrl}/state`)).json();
    assert.ok(state.nodes["endpoint:localhost/api/users"], Object.keys(state.nodes).join(" "));
    assert.ok(state.nodes["param:localhost/api/users?id"]);
  });

  it("the installed MCP server answers on its own", async () => {
    const p = spawn(process.execPath, [path.join(home, ".spectra", "bin", "spectra-mcp.mjs")], { env: env({ SPECTRA_HUB: hubUrl }), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }) + "\n");
    for (let i = 0; i < 100 && !out.includes("\n"); i++) await sleep(100);
    p.kill();
    const reply = JSON.parse(out.split("\n")[0] || "{}");
    assert.equal(reply.result?.serverInfo?.name, "spectra", `no MCP reply. stderr: ${err}`);
  });

  it("the demo and the audit check run from the package", async () => {
    const demo = await spectra(["demo", "recon"], { SPECTRA_HUB: hubUrl, SPECTRA_DEMO_PACE: "0.01" });
    assert.equal(demo.code, 0, demo.stderr);
    const state = await (await fetch(`${hubUrl}/state`)).json();
    assert.ok(Object.keys(state.nodes).length > 80, `${Object.keys(state.nodes).length} targets`);
    // (The demo imports a proxy history shipped inside the package; it exits non-zero if that file is missing.)
    await sleep(600);
    const verify = await spectra(["verify"]);
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
  });

  it("with no hub running, the demos and the importer say so plainly", async () => {
    const nowhere = `http://127.0.0.1:${await freePort()}`;
    for (const args of [["demo"], ["demo", "recon"], ["import", path.join(pkg, "dist", "examples", "acme-shop.har")]]) {
      const r = await spectra(args, { SPECTRA_HUB: nowhere });
      assert.equal(r.code, 1, args.join(" "));
      assert.equal(r.stderr.trim(), `Can't reach the hub at ${nowhere}. Start it with spectra start.`, args.join(" "));
    }
  });

  it("without Claude Code's CLI, init says what to run", async () => {
    const other = tempDir("other-repo");
    const empty = tempDir("empty-path");
    const r = await spectra(["init", other], { PATH: empty });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Claude Code's CLI wasn't found/);
    assert.match(r.stdout, /claude mcp add --scope local spectra -- node .*spectra-mcp\.mjs/);
    assert.ok(fs.existsSync(path.join(other, ".claude", "settings.local.json")));
  });

  it("init --remove takes the hooks and the MCP server out again", async () => {
    const r = await spectra(["init", project, "--remove"]);
    assert.equal(r.code, 0, r.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(settings.hooks.PreToolUse.map((g: any) => g.hooks[0].command), ["echo mine"]);
    assert.equal(settings.hooks.SessionStart, undefined);
    assert.equal(claudeCalls().at(-1), `${project} :: mcp remove --scope local spectra`);
  });

  it("refuses a folder that doesn't exist", async () => {
    const r = await spectra(["init", path.join(project, "nope")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such folder/);
  });
});
