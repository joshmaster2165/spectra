#!/usr/bin/env node
/**
 * Registers the Spectra hook in a Claude Code settings file.
 *
 *   node packages/server/bin/install-hooks.mjs <project-dir>   → <project>/.claude/settings.local.json
 *   node packages/server/bin/install-hooks.mjs --user          → ~/.claude/settings.json
 *   add --remove to uninstall
 *
 * Existing settings and other hooks are preserved; re-running is idempotent.
 * `spectra init` uses the same function, pointed at its own copy of the hook script.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PostToolUseFailure is how Claude Code reports a tool call that failed; without it a failed
// call never gets a result and its target stays "active" on the map.
// PostToolBatch closes each batch of calls: one that has no result by then was denied and never ran.
export const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "SessionEnd"];
const MATCHER_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const MARKER = "spectra-hook.mjs";

/** The settings file for one project, or for every project when `user` is set. */
export function settingsPathFor({ projectDir, user }) {
  return user ? path.join(os.homedir(), ".claude", "settings.json") : path.join(path.resolve(projectDir), ".claude", "settings.local.json");
}

/**
 * Adds (or with `remove`, takes out) the Spectra hook in one settings file.
 * Throws if the file exists and isn't valid JSON, so a broken file is never overwritten.
 */
export function installHooks({ settingsPath, hookScript, remove = false }) {
  const command = `node ${JSON.stringify(hookScript)}`;
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`could not parse ${settingsPath}: ${err.message}`);
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
  return settingsPath;
}

// Run directly (`npm run hooks:install`): the hook is the one beside this file, in the checkout.
// The file name is checked too, because bundled into the `spectra` command this module *is* the running script.
const SELF = fileURLToPath(import.meta.url);
if (path.basename(SELF) === "install-hooks.mjs" && process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF)) {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const user = args.includes("--user");
  const projectDir = args.find((a) => !a.startsWith("--"));

  if (!user && !projectDir) {
    console.error("usage: install-hooks.mjs <project-dir> | --user  [--remove]");
    process.exit(1);
  }
  try {
    const settingsPath = installHooks({
      settingsPath: settingsPathFor({ projectDir, user }),
      hookScript: path.join(path.dirname(SELF), "spectra-hook.mjs"),
      remove,
    });
    console.log(`${remove ? "removed Spectra hooks from" : "installed Spectra hooks in"} ${settingsPath}`);
    if (!remove) console.log("restart Claude Code sessions in that scope for the hooks to load");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
