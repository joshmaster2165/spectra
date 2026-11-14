/**
 * Reads the result lines of a sweep: the lines of a command's output that pair
 * an address with an HTTP status. A wordlist loop, a fuzzer and most small recon
 * scripts all print this way —
 *
 *     200 /login                      shop /robots.txt 200 93B
 *     login   [Status: 200, Size: 9]  /backup  (Status: 301) [Size: 0]
 *     GET /v1/users/me | anon=401     http://shop.example.test/login [200]
 *
 * Local and deterministic: nothing leaves the hub. A line is attributed to an
 * address only when there is no doubt which one — the full URL is printed, or
 * the path matches one of the addresses the command is known to request, or the
 * command names a single site. Anything else is counted as ambiguous and left
 * for the Interpreter or the operator.
 */

import { urlsIn, type Expansion } from "./shell.ts";

export interface ResultHit {
  url: string;
  status: number;
  /** True when the command itself is known to request this address; false when only the output says so. */
  requested: boolean;
  method?: string;
  /** The line it was read from. */
  evidence: string;
}

export interface ResultReading {
  hits: ResultHit[];
  /** Result lines whose status says nothing is there (404 and the like). */
  dead: number;
  /** Those of them the command is known to have requested, for noting the status on a target already mapped. */
  gone: { url: string; status: number }[];
  /** Result lines that couldn't be tied to one address. */
  ambiguous: number;
  /** Other lines that mention a path the reading doesn't account for. */
  unplaced: number;
  /** Lines that read as results at all. */
  lines: number;
}

/** Nothing there: not found, or no such site on this server, or no answer. */
const DEAD = new Set([0, 404, 410, 421]);
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ABSOLUTE = /\bhttps?:\/\/[^\s'"`<>()\\,;\]}|]+/i;
/** Paths on this machine, not on the target. */
const LOCAL_PATH = /^\/(usr|bin|sbin|etc|tmp|var|dev|private|Users|home|opt|proc|sys|lib|Library|System|Applications|Volumes|root|mnt|node_modules)(\/|$)/;
const PATH_TOKEN = /^\/(?!\/)[\w.~%@!$&*+,;=:/?#[\]-]*$/;

function statusOf(line: string): number | undefined {
  const labelled = line.match(/\bStatus(?:[ _-]?Code)?\s*[:=]\s*(\d{3})\b/i) ?? line.match(/\bHTTP\/[\d.]+\s+(\d{3})\b/);
  if (labelled) return Number(labelled[1]);
  // Sizes, word counts and timings sit next to their own labels or units; a bare three-digit number is the status.
  const bare = line.replace(/\b(?:Size|Words|Lines|Length|Duration|Time|Bytes)\s*[:=]\s*\d+/gi, " ").match(/(?:^|[\s=:[(|>,-])(000|[1-5]\d{2})(?=$|[\s\]),|;.])(?!\.\d)/);
  return bare ? Number(bare[1]) : undefined;
}

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};

export interface ResultContext {
  /** Addresses the command is known to request. */
  probes?: string[];
  /** The command and any script it runs, as text: the sites it names. */
  material?: string;
}

export function readResults(output: string, ctx: ResultContext): ResultReading {
  const reading: ResultReading = { hits: [], dead: 0, gone: [], ambiguous: 0, unplaced: 0, lines: 0 };
  // The addresses the command is known to request, by host and by path.
  const byHostPath = new Map<string, string>();
  const hostsByPath = new Map<string, Set<string>>();
  const origins = new Map<string, string>(); // hostname → origin
  const index = (raw: string, requested: boolean) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return;
    }
    if (!origins.has(u.hostname)) origins.set(u.hostname, u.origin);
    if (!requested) return;
    for (const p of new Set([u.pathname + u.search, u.pathname, u.pathname.replace(/\/+$/, "") || "/"])) {
      if (!byHostPath.has(`${u.hostname}|${p}`)) byHostPath.set(`${u.hostname}|${p}`, raw);
      if (!hostsByPath.has(p)) hostsByPath.set(p, new Set());
      hostsByPath.get(p)!.add(u.hostname);
    }
  };
  for (const p of ctx.probes ?? []) index(p, true);
  for (const m of (ctx.material ?? "").matchAll(/\bhttps?:\/\/[^\s'"`<>()\\,;{}$|]+/gi)) index(m[0], false);
  // A fuzzer's template: results are words to put where the placeholder is.
  const template = (ctx.material ?? "").match(/\bhttps?:\/\/[^\s'"`<>()|;]*\bFUZZ\b[^\s'"`<>()|;]*/)?.[0];

  // A short name for each site: its first label, when that is unique ("shop" for shop.example.test).
  const labels = new Map<string, string>();
  const taken = new Set<string>();
  for (const host of origins.keys()) {
    const first = host.split(".")[0];
    if (taken.has(first)) labels.delete(first);
    else {
      taken.add(first);
      labels.set(first, host);
    }
  }

  const seen = new Set<string>();
  let current = "";
  const hit = (url: string, status: number, requested: boolean) => {
    if (DEAD.has(status)) {
      reading.dead++;
      if (requested && reading.gone.length < 500) reading.gone.push({ url, status });
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    reading.hits.push({ url, status, requested, method: current.match(/(?:^|\s)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?=\s)/)?.[1], evidence: current.slice(0, 160) });
  };

  for (const raw of output.split("\n").slice(0, 6000)) {
    const line = raw.replace(ANSI, "").trim();
    if (!line || line.length > 800) continue;
    let absolute = line.match(ABSOLUTE)?.[0].replace(/[.:!?*]+$/, "");
    try {
      if (absolute) new URL(absolute);
    } catch {
      absolute = undefined;
    }
    // The status is read from the line without its URL, so a port or an id in the address isn't mistaken for it.
    const status = statusOf(absolute ? line.replace(absolute, " ") : line);
    if (status === undefined) {
      // Not a result line. If it names a path this reading can't account for, the output isn't fully read.
      // (Addresses printed in full are picked up by the URL scan.)
      const stray = (absolute ? line.split(absolute).join(" ") : line).split(/[\s|,;="'`()<>[\]{}]+/).find((t) => PATH_TOKEN.test(t) && t.length > 2 && /[A-Za-z]/.test(t) && !LOCAL_PATH.test(t) && !hostsByPath.has(t) && !hostsByPath.has(t.replace(/\/+$/, "")));
      if (stray) reading.unplaced++;
      continue;
    }
    reading.lines++;
    current = line;
    const tokens = line
      .split(/[\s|,;]+/)
      .map((t) => t.replace(/^["'`([{<]+|["'`)\]}>:]+$/g, ""))
      .filter(Boolean);
    const named = tokens.map((t) => (origins.has(t) ? t : labels.get(t))).find(Boolean);
    const path = tokens.find((t) => PATH_TOKEN.test(t) && (t.length > 1 || !absolute));
    // A bare word a fuzzer or a loop printed: "login", "robots.txt", "backup/".
    const word = path ? undefined : tokens.find((t) => hostsByPath.has(`/${t}`) || hostsByPath.has(`/${t.replace(/\/+$/, "")}`));
    const wanted = path ?? (word ? `/${word}` : undefined);
    const variants = wanted ? [wanted, wanted.split("?")[0], wanted.replace(/\/+$/, "") || "/"] : [];

    // 1. An address the command is known to request.
    const hosts = variants.map((v) => hostsByPath.get(v)).find(Boolean);
    const host = hosts && (named && hosts.has(named) ? named : hosts.size === 1 ? [...hosts][0] : undefined);
    if (host) {
      hit(variants.map((v) => byHostPath.get(`${host}|${v}`)).find(Boolean)!, status, true);
      continue;
    }
    // 2. The full address is printed on the line.
    if (absolute && !/[${]/.test(absolute)) {
      const u = new URL(absolute);
      hit(absolute, status, byHostPath.has(`${u.hostname}|${u.pathname}`));
      continue;
    }
    // 3. A path on the site the line names, or on the only site the command names.
    const site = named ?? (origins.size === 1 ? [...origins.keys()][0] : undefined);
    if (path && !hosts && site) {
      hit(`${origins.get(site)}${path}`, status, false);
      continue;
    }
    // 4. "shop 200": a site by its name, from a sweep over hostnames.
    if (!wanted && named) {
      hit(byHostPath.get(`${named}|/`) ?? `${origins.get(named)}/`, status, byHostPath.has(`${named}|/`));
      continue;
    }
    // 5. "login [Status: 200 …]" from a fuzzer whose wordlist couldn't be read.
    const fuzzed = template && line.match(/^(\S+)\s+\[Status:/)?.[1];
    if (fuzzed) hit(template.replace(/\bFUZZ\b/g, fuzzed), status, false);
    else reading.ambiguous++;
  }
  return reading;
}

/**
 * A browser's own record of the requests a page made, as its tools print it:
 * one request per line with its URL and status, or JSON with `url` and `status`
 * fields. These are requests that were made, not guesses.
 */
export function readNetworkLog(output: string): { url: string; status?: number; method?: string }[] {
  const out: { url: string; status?: number; method?: string }[] = [];
  const seen = new Set<string>();
  const add = (url: unknown, status?: unknown, method?: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || out.length >= 2000) return;
    const key = `${typeof method === "string" ? method.toUpperCase() : ""} ${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    const code = Number(status);
    out.push({ url, status: Number.isInteger(code) && code >= 100 && code < 600 ? code : undefined, method: typeof method === "string" && /^[A-Za-z]{3,7}$/.test(method) ? method.toUpperCase() : undefined });
  };
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 6) return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, any>;
    const url = o.url ?? o.requestUrl ?? o.request?.url;
    if (typeof url === "string") add(url, o.status ?? o.statusCode ?? o.response?.status ?? o.responseStatus, o.method ?? o.request?.method);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  const trimmed = output.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      walk(JSON.parse(trimmed), 0);
    } catch {
      /* not JSON after all: read it as lines */
    }
  }
  if (!out.length) {
    for (const raw of output.split("\n").slice(0, 6000)) {
      const line = raw.replace(ANSI, "").trim();
      const url = line.match(ABSOLUTE)?.[0].replace(/[.:!?*]+$/, "");
      if (!url) continue;
      const rest = line.replace(url, " ");
      add(url, rest.match(/"status(?:Code)?"\s*:\s*(\d{3})/)?.[1] ?? statusOf(rest), rest.match(/(?:^|[\s[("])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)(?=[\s\])"])/)?.[1]);
    }
  }
  return out;
}

/** Static files a page pulls in that say nothing about the application. */
export const PAGE_NOISE = /\.(css|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|map)$/i;

/** Where a command sends its results instead of printing them: `> file`, `| tee file`, a scanner's `-o file`. */
export function resultFile(command: string): string | undefined {
  const flat = command.replace(/\\\n/g, " ");
  const redirect = [...flat.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([\w./@+~-]+)/g)].map((m) => m[1]).filter((f) => f !== "/dev/null");
  const tee = flat.match(/\|\s*tee\s+(?:-a\s+)?([\w./@+~-]+)/)?.[1];
  const scanner = /\b(?:ffuf|gobuster|feroxbuster|dirsearch|wfuzz|nuclei|httpx|katana|subfinder|nmap)\b/.test(flat) ? flat.match(/\s(?:-o|-oN|--output)[ \t=]+([\w./@+~-]+)/)?.[1] : undefined;
  return redirect.at(-1) ?? tee ?? scanner;
}

export { originOf };

/**
 * Addresses a command names that its own output shows were never requested:
 * the program wasn't found, the shell rejected the word, or the host couldn't
 * be reached. Only what the output says outright — a failure with no such sign
 * leaves the command's addresses where they are.
 */
export function notRequested(exp: Expansion, output: string): { urls: Set<string>; why?: string; missing: string[] } {
  const urls = new Set<string>();
  let why: string | undefined;
  const note = (line: string) => (why ??= line.trim().slice(0, 160));
  const all = exp.urls.filter((u) => !/[$`]/.test(u.url)).map((u) => u.url);
  // 1. A program that never started: every address handed to it.
  const missing = new Map<string, string>();
  for (const m of output.matchAll(/^.*?(?:command not found: ([\w.+-]+)|(?:^|[\s:])([\w.+-]+): (?:command )?not found)\s*$/gm)) missing.set(m[1] ?? m[2], m[0]);
  if (!all.length || !output) return { urls, missing: [...missing.keys()] };
  if (missing.size) {
    for (const line of exp.shell.split("\n")) {
      for (const segment of line.split(/\|\|?|&&|;/)) {
        const first = segment.trim().split(/\s+/).find((w) => !/^(do|then|else|\{|\(|[A-Za-z_]\w*=.*)$/.test(w));
        if (!first || !missing.has(first)) continue;
        for (const u of urlsIn(segment)) urls.add(u);
        note(missing.get(first)!);
      }
    }
  }
  // 2. A word the shell refused to run (zsh on an unquoted `?` or `*`): the command it was part of never ran.
  for (const m of output.matchAll(/^.*no matches found: (\S+)\s*$/gm)) {
    for (const u of all) {
      if (u === m[1] || m[1].startsWith(u) || u.startsWith(m[1])) {
        urls.add(u);
        note(m[0]);
      }
    }
  }
  // 3. A host that couldn't be reached: no request left for it.
  const unreachable = (host: string, port: string | undefined, line: string) => {
    for (const u of all) {
      try {
        const parsed = new URL(u);
        if (parsed.hostname !== host.toLowerCase()) continue;
        if (port && (parsed.port || (parsed.protocol === "https:" ? "443" : "80")) !== port) continue;
        urls.add(u);
        note(line);
      } catch {
        /* not an address */
      }
    }
  };
  for (const m of output.matchAll(/^.*Could not resolve host: ([A-Za-z0-9.-]+).*$/gm)) unreachable(m[1], undefined, m[0]);
  for (const m of output.matchAll(/^.*Failed to connect to ([A-Za-z0-9.-]+) port (\d+).*$/gm)) unreachable(m[1], m[2], m[0]);
  for (const m of output.matchAll(/^.*getaddrinfo \w+ ([A-Za-z0-9.-]+).*$/gm)) unreachable(m[1], undefined, m[0]);
  // A client that doesn't name the host: only when the command talks to one host, so there's no doubt which.
  const generic = output.match(/^.*(?:Name or service not known|nodename nor servname provided|Connection refused|ECONNREFUSED|No address associated with hostname).*$/m);
  if (generic && !urls.size) {
    const hosts = new Set(all.map((u) => originOf(u)).filter(Boolean));
    if (hosts.size === 1) {
      for (const u of all) urls.add(u);
      note(generic[0]);
    }
  }
  // 4. curl run silently: its exit status is all there is. 6 is "couldn't resolve", 7 "couldn't connect".
  const exit = output.match(/^Exit code (6|7)\b/)?.[1];
  const last = exp.shell.trim().split("\n").at(-1) ?? "";
  if (exit && !urls.size && /^\s*(?:[A-Za-z_]\w*=\S*\s+)*curl\b/.test(last) && !/\|/.test(last.replace(/"[^"]*"|'[^']*'/g, ""))) {
    const named = urlsIn(last);
    if (named.length === 1) {
      urls.add(named[0]);
      note(exit === "6" ? "curl couldn't resolve the host (exit code 6)" : "curl couldn't connect (exit code 7)");
    }
  }
  return { urls, why, missing: [...missing.keys()] };
}
