import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Scope, Target, ViolationSeverity } from "@spectra/schema";

/** Loopback is always in scope: local test targets are the normal case. */
const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

export interface ScopeConfig {
  paths?: string[];
  hosts?: string[];
}

/**
 * Operator-defined scope. Sources, highest priority first:
 *   SPECTRA_SCOPE_PATHS / SPECTRA_SCOPE_HOSTS (comma-separated)
 *   spectra.config.json → { "scope": { "paths": [...], "hosts": [...] } }
 * With no paths configured, each session's cwd becomes its scope.
 */
export function loadScopeConfig(configPath: string): ScopeConfig {
  let file: ScopeConfig = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8")).scope ?? {};
  } catch {
    // No config file: fall back to env / session defaults.
  }
  const list = (v?: string) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    paths: list(process.env.SPECTRA_SCOPE_PATHS) ?? file.paths,
    hosts: list(process.env.SPECTRA_SCOPE_HOSTS) ?? file.hosts,
  };
}

export function makeScope(cfg: ScopeConfig, origin: Scope["origin"]): Scope {
  return {
    paths: (cfg.paths ?? []).map(expand),
    hosts: [...new Set([...LOOPBACK, ...(cfg.hosts ?? []).map((h) => h.toLowerCase())])],
    origin,
  };
}

export function inScope(t: Target, scope: Scope): boolean {
  if (t.kind === "host") {
    if (t.value.startsWith("ssh://")) t = { ...t, value: t.value.slice(6) };
    return scope.hosts.some((h) => t.value === h || t.value.endsWith(`.${h}`));
  }
  return scope.paths.some((root) => t.value === root || t.value.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

export function severityOf(t: Target): ViolationSeverity {
  return t.access === "read" ? "medium" : "high";
}

function expand(p: string) {
  return path.resolve(p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
}
