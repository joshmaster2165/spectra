/**
 * The `spectra` command: one entry point for the hub, project setup, the demos and the tools.
 *
 *   spectra                 start the hub and the dashboard
 *   spectra init [dir]      connect a project's Claude Code sessions to it
 *
 * Built into `dist/cli.js` by scripts/build-dist.mjs. In a checkout the npm scripts do the same jobs.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { installHooks, settingsPathFor } from "../bin/install-hooks.mjs";
import { BUNDLED, entry, HOME, HOOK_SCRIPT, VERSION } from "./paths.ts";

const HELP = `spectra ${VERSION} — a live attack-surface map for authorized, AI-assisted security testing

Usage
  spectra [start]              Start the hub and open the dashboard at http://127.0.0.1:4317
  spectra init [project-dir]   Connect a project's Claude Code sessions (default: this folder)
      --user                     …or every project you open with Claude Code
      --no-mcp                   install the hooks only, not the MCP tools
      --remove                   disconnect it again
  spectra demo [recon]         Play a scripted engagement into a running hub (nothing leaves this machine)
  spectra import <file.har>    Put a proxy history on the map
  spectra verify [session]     Check the audit logs haven't been edited
  spectra navigator            Run the Navigator as its own process
  spectra mcp                  The MCP server Claude Code starts (you don't run this yourself)

Settings such as the port are environment variables: SPECTRA_PORT, SPECTRA_HOME, SPECTRA_HUB.
Docs: https://github.com/joshmaster2165/spectra/tree/main/docs`;

const [command = "start", ...rest] = process.argv.slice(2);

/** How to run this command again: by name when it is installed, the long way when npx fetched it. */
const SELF = !BUNDLED ? "npm start" : process.env.npm_command === "exec" ? "npx github:joshmaster2165/spectra" : "spectra";

/** Hands the process over to one of Spectra's programs, with the arguments it expects. */
async function run(name: Parameters<typeof entry>[0], args: string[]) {
  const file = entry(name);
  process.argv = [process.argv[0], file, ...args];
  await import(pathToFileURL(file).href);
}

// ── spectra init ─────────────────────────────────────────────────────────────

const BIN = path.join(HOME, "bin");

/**
 * The hook script and MCP server that Claude Code will run. `npx` keeps packages in a cache it
 * may clear, so the installed command copies both into Spectra's own folder, where they stay put.
 * A checkout is already a stable place and is used as it is.
 */
function runtime(copy: boolean): { hook: string; mcp: string[] } {
  if (!BUNDLED) return { hook: HOOK_SCRIPT, mcp: [path.resolve(path.dirname(entry("mcp")), "../../../node_modules/.bin/tsx"), entry("mcp")] };
  const hook = path.join(BIN, "spectra-hook.mjs");
  const mcp = path.join(BIN, "spectra-mcp.mjs");
  if (copy) {
    fs.mkdirSync(BIN, { recursive: true });
    fs.copyFileSync(HOOK_SCRIPT, hook);
    fs.copyFileSync(entry("mcp"), mcp);
  }
  return { hook, mcp: ["node", mcp] };
}

/** After an upgrade the copies Claude Code runs should match the hub that is starting. */
function refreshRuntime() {
  if (BUNDLED && fs.existsSync(path.join(BIN, "spectra-hook.mjs"))) runtime(true);
}

const quote = (s: string) => (/^[\w./:@=+-]+$/.test(s) ? s : JSON.stringify(s));

function init(args: string[]) {
  const user = args.includes("--user");
  const remove = args.includes("--remove");
  const withMcp = !args.includes("--no-mcp");
  const unknown = args.find((a) => a.startsWith("--") && !["--user", "--remove", "--no-mcp"].includes(a));
  if (unknown) fail(`unknown option ${unknown}`);
  const projectDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  if (!user && !fs.existsSync(projectDir)) fail(`no such folder: ${projectDir}`);
  const where = user ? "every project" : projectDir;

  const files = runtime(!remove);
  let settingsPath: string;
  try {
    settingsPath = installHooks({ settingsPath: settingsPathFor({ projectDir, user }), hookScript: files.hook, remove });
  } catch (err) {
    fail((err as Error).message);
  }
  console.log(`${remove ? "Removed the Spectra hooks from" : "Hooks installed in"} ${settingsPath}`);

  if (withMcp) {
    // Claude Code keeps its MCP servers in its own config; its CLI is the supported way to change it.
    const scope = ["--scope", user ? "user" : "local"];
    const add = ["mcp", "add", ...scope, "spectra", "--", ...files.mcp];
    const claude = (argv: string[]) => spawnSync("claude", argv, { cwd: user ? undefined : projectDir, encoding: "utf8" });
    const found = !claude(["--version"]).error;
    if (!found) {
      console.log(remove ? "Claude Code's CLI wasn't found, so the MCP server was left as it is." : `Claude Code's CLI wasn't found. To give the agent Spectra's MCP tools, run this${user ? "" : ` in ${projectDir}`}:\n  claude ${add.map(quote).join(" ")}`);
    } else {
      // Replace an earlier registration, which may point at an old path.
      const removed = claude(["mcp", "remove", ...scope, "spectra"]);
      if (remove) console.log(removed.status === 0 ? "Removed the Spectra MCP server from Claude Code." : "No Spectra MCP server was registered.");
      else {
        const added = claude(add);
        if (added.status === 0) console.log("MCP tools registered with Claude Code.");
        else console.log(`Couldn't register the MCP tools (${(added.stderr || added.stdout || "").trim().split("\n")[0]}). Run this yourself${user ? "" : ` in ${projectDir}`}:\n  claude ${add.map(quote).join(" ")}`);
      }
    }
  }

  if (!remove) {
    console.log(`\nSpectra is connected to ${where}. Next:`);
    console.log(`  1. Start the hub:   ${SELF}`);
    console.log(`  2. Restart any Claude Code session ${user ? "that is already running" : "already running in that folder"}; hooks load when a session starts.`);
  }
}

function fail(message: string): never {
  console.error(`spectra: ${message}`);
  process.exit(1);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

switch (command) {
  case "start":
    refreshRuntime();
    await run("hub", rest);
    // Nothing has ever been connected from this machine: say how.
    if (BUNDLED && !fs.existsSync(BIN)) console.log(`[spectra] no project is connected yet. In another terminal: ${SELF} init /path/to/project   (or try: ${SELF} demo)`);
    break;
  case "init":
    init(rest);
    break;
  case "demo":
    await run(rest[0] === "recon" ? "demo-recon" : "demo", rest[0] === "recon" ? rest.slice(1) : rest);
    break;
  case "import":
  case "verify":
  case "navigator":
  case "mcp":
    await run(command, rest);
    break;
  case "-v":
  case "--version":
  case "version":
    console.log(VERSION);
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(HELP);
    break;
  default:
    console.error(`spectra: unknown command "${command}"\n\n${HELP}`);
    process.exit(1);
}
