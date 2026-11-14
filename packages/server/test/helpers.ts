// Shared plumbing for the tests: a throwaway hub started exactly as a user starts it, the real
// hook binary, the lab app, and a copy of the lab project in a temp folder.
// Nothing here touches ~/.spectra, port 4317, or the network beyond this machine.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeRoute } from "../src/toolmap.ts";
import type { LabRequest } from "./lab/app.ts";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(HERE, "..");
export const HOOK = path.join(SERVER_DIR, "bin", "spectra-hook.mjs");
/** The port written into the fixtures; replaced by the lab's real port when they are copied. */
export const FIXTURE_PORT = "4420";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const temps: string[] = [];
/** A fresh folder under the system temp dir, as its real path (macOS links /var and /tmp elsewhere). */
export function tempDir(name: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `spectra-test-${name}-`)));
  temps.push(dir);
  return dir;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string>; timeout?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), opts.timeout ?? 60_000);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    p.stdin.end(opts.input ?? "");
  });
}

/** Programs the end-to-end tests run commands with. Returns the ones that aren't installed. */
export async function missingPrograms(names: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const n of names) if ((await run("/bin/sh", ["-c", `command -v ${n}`])).code !== 0) missing.push(n);
  return missing;
}

// ── a hub ────────────────────────────────────────────────────────────────────

export interface HubOptions {
  /** Holds the hub's config, settings and audit log. Start again with the same folder to restart the hub. */
  dir: string;
  scope?: { paths?: string[]; hosts?: string[] };
  /** Written as the settings file the first time this folder is used. */
  settings?: object;
  /** Where the Navigator and Interpreter send their requests. Defaults to a dead local address. */
  modelUrl?: string;
  env?: Record<string, string>;
}

export interface TestHub {
  url: string;
  dataDir: string;
  /** Everything the hub process printed. */
  log(): string;
  state(): Promise<any>;
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<Response>;
  /** Sends one hook payload through the real hook binary, as Claude Code does. */
  hook(payload: object): Promise<void>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const p of running) p.kill("SIGKILL");
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

export async function startHub(opts: HubOptions): Promise<TestHub> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const config = path.join(opts.dir, "spectra.config.json");
  const settingsFile = path.join(opts.dir, "settings.json");
  const dataDir = path.join(opts.dir, "sessions");
  if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ scope: opts.scope ?? {} }));
  if (!fs.existsSync(settingsFile) && opts.settings) fs.writeFileSync(settingsFile, JSON.stringify(opts.settings));

  // The developer's own key and Spectra settings must never reach a test hub.
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|SPECTRA_)/.test(k)) delete env[k];
  Object.assign(env, {
    SPECTRA_PORT: String(port),
    SPECTRA_OBSERVER: "0",
    SPECTRA_NOTIFY: "0",
    SPECTRA_CONFIG: config,
    SPECTRA_SETTINGS: settingsFile,
    SPECTRA_DATA_DIR: dataDir,
    ANTHROPIC_BASE_URL: opts.modelUrl ?? "http://127.0.0.1:9",
    ...opts.env,
  });

  const child = spawn(process.execPath, ["--import", "tsx", path.join(SERVER_DIR, "src", "index.ts")], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  running.add(child);
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      running.delete(child);
      resolve();
    }),
  );

  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`the test hub exited while starting:\n${log}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (i > 150) {
      child.kill("SIGKILL");
      throw new Error(`the test hub did not start within 15 seconds:\n${log}`);
    }
    await sleep(100);
  }

  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    url,
    dataDir,
    log: () => log,
    state: async () => (await fetch(`${url}/state`)).json(),
    get: async (p) => (await fetch(url + p)).json(),
    post: (p, body) => fetch(url + p, json(body)),
    hook: async (payload) => {
      const r = await run(process.execPath, [HOOK], { input: JSON.stringify(payload), env: { SPECTRA_HUB: url } });
      if (r.code !== 0) throw new Error(`the hook exited with ${r.code}: ${r.stderr}`);
    },
    stop: async (signal = "SIGTERM") => {
      child.kill(signal);
      await exited;
    },
  };
}

/** Polls the hub's state until `done` says so, and returns the last state either way. */
export async function waitForState(hub: TestHub, done: (state: any) => boolean, ms = 20_000): Promise<any> {
  let state = await hub.state();
  for (const end = Date.now() + ms; !done(state) && Date.now() < end; ) {
    await sleep(250);
    state = await hub.state();
  }
  return state;
}

// ── the lab project ──────────────────────────────────────────────────────────

export interface LabProject {
  dir: string;
  /** PATH with the scanner stand-ins first. */
  path: string;
}

/** Copies the lab project (the folder a driver would work in) to a temp folder, pointed at the lab's port. */
export function copyLabProject(port: number): LabProject {
  const dir = tempDir("project");
  const from = path.join(HERE, "lab", "project");
  const copy = (rel: string) => {
    const src = path.join(from, rel);
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(path.join(dir, rel), { recursive: true });
      for (const f of fs.readdirSync(src)) copy(path.join(rel, f));
    } else fs.writeFileSync(path.join(dir, rel), fs.readFileSync(src, "utf8").split(FIXTURE_PORT).join(String(port)));
  };
  copy("");
  fs.chmodSync(path.join(dir, "list-routes.sh"), 0o755);

  const bin = tempDir("bin");
  const shim = path.join(HERE, "lab", "recon-shim.mjs");
  for (const tool of ["ffuf", "gobuster", "httpx"]) fs.writeFileSync(path.join(bin, tool), `#!/bin/sh\nexec "${process.execPath}" "${shim}" ${tool} "$@"\n`, { mode: 0o755 });
  return { dir, path: `${bin}${path.delimiter}${process.env.PATH}` };
}

// ── ground truth ─────────────────────────────────────────────────────────────

/** Nothing there: not found, or no such site on the lab server. */
const NOT_THERE = new Set([404, 421]);

export interface Truth {
  /** host + route of everything that answered. */
  live: Set<string>;
  /** host + route of what was requested and wasn't there. */
  dead: Set<string>;
  /** `param:` node ids for the query parameters sent to routes that answered. */
  params: Set<string>;
}

/** What a set of lab requests really touched, keyed the way the map keys its targets. */
export function truthOf(requests: LabRequest[]): Truth {
  const key = (r: LabRequest) => `${r.host}${normalizeRoute(`http://${r.host}${r.path}`) ?? ""}`;
  const live = new Set<string>();
  const dead = new Set<string>();
  const params = new Set<string>();
  for (const r of requests) {
    if (NOT_THERE.has(r.status)) dead.add(key(r));
    else {
      live.add(key(r));
      for (const p of r.params) params.add(`param:${key(r)}?${p}`);
    }
  }
  for (const k of live) dead.delete(k);
  return { live, dead, params };
}

/** The node id a host+route key has on the map. */
export const nodeIdOf = (key: string) => (key.includes("/") ? `endpoint:${key}` : `host:${key}`);

/** Whether a host+route key is on the map (a bare host may be mapped as a domain). */
export const onMap = (state: any, key: string) => {
  const id = nodeIdOf(key);
  return !!state.nodes[id] || (id.startsWith("host:") && !!state.nodes[`domain:${id.slice(5)}`]);
};

/** An action that was read, dismissed or found to have nothing to map — anything but still open or failed. */
export const settled = (action: any) => !!action?.resolution && action.resolution !== "failed";
