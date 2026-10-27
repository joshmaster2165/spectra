#!/usr/bin/env node
/**
 * Registers the Spectra hook in a Claude Code settings file.
 *
 *   node packages/server/bin/install-hooks.mjs <project-dir>   → <project>/.claude/settings.local.json
 *   node packages/server/bin/install-hooks.mjs --user          → ~/.claude/settings.json
 *   add --remove to uninstall
 *
 * Existing settings and other hooks are preserved; re-running is idempotent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SessionEnd"];
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse"]);
const MARKER = "spectra-hook.mjs";

const args = process.argv.slice(2);
const remove = args.includes("--remove");
const user = args.includes("--user");
const projectDir = args.find((a) => !a.startsWith("--"));

if (!user && !projectDir) {
  console.error("usage: install-hooks.mjs <project-dir> | --user  [--remove]");
  process.exit(1);
}

const settingsPath = user
  ? path.join(os.homedir(), ".claude", "settings.json")
  : path.join(path.resolve(projectDir), ".claude", "settings.local.json");

const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "spectra-hook.mjs");
const command = `node ${JSON.stringify(hookScript)}`;

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
} catch (err) {
  if (err.code !== "ENOENT") {
    console.error(`could not parse ${settingsPath}: ${err.message}`);
    process.exit(1);
  }
}

settings.hooks ??= {};
for (const event of EVENTS) {
  const groups = (settings.hooks[event] ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !String(h.command ?? "").includes(MARKER)) }))
    .filter((g) => g.hooks.length);
  if (!remove) {
    groups.push({
      ...(MATCHER_EVENTS.has(event) ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command, timeout: 2 }],
    });
  }
  if (groups.length) settings.hooks[event] = groups;
  else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`${remove ? "removed Spectra hooks from" : "installed Spectra hooks in"} ${settingsPath}`);
if (!remove) console.log("restart Claude Code sessions in that scope for the hooks to load");
