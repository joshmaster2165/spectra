import path from "node:path";

/**
 * Reads a shell command the way the shell would, far enough to recover the
 * addresses it requests. Recon rarely names its targets directly: it loops over
 * wordlists, calls small scripts, and builds URLs from variables. The hook sees
 * only the unexpanded command line, so the expansion happens here.
 *
 * This is not a shell. It expands the idioms recon actually uses — variables,
 * `for` and `while read` loops, `xargs`, functions, brace lists, here-documents
 * and scripts it is allowed to read — and leaves everything else alone. Whatever
 * still holds a `$` afterwards is reported as unread, never guessed at.
 */

export interface ShellContext {
  /** Directory relative paths resolve against. */
  cwd?: string;
  /** Text of a file the caller allows to be read (in scope, small, textual); undefined otherwise. */
  readFile?: (absPath: string) => string | undefined;
}

export interface Expansion {
  /** The command with loops, variables, functions and readable scripts expanded. */
  text: string;
  /** The same, without the bodies of here-documents fed to other programs: what the shell itself runs. */
  shell: string;
  /** Source of the non-shell scripts the command runs (Python, Node…), for reading their literals. */
  code: string[];
  /** Code handed to an interpreter on the command line: `-c` and `-e` strings, here-document bodies. */
  inline: string[];
  /** True when the command runs a script file that couldn't be read. */
  missing: boolean;
  /** Every address written in the expanded command. `bulk` marks one of many produced by a long loop. */
  urls: { url: string; bulk: boolean }[];
  /** Addresses a wordlist-driven scanner (ffuf, gobuster…) requests. */
  probes: string[];
  /** Files read while expanding: scripts and wordlists. */
  read: string[];
}

const MAX_CMD = 20_000;
// Enough for the wordlists recon usually loops over (a few thousand lines); larger sweeps are read from their output alone.
const MAX_TEXT = 2_000_000;
const MAX_ITEMS = 12_000;
/** A loop over more items than this is a sweep, not a handful of picked requests. */
export const BULK = 12;
const BULK_OPEN = "\u0001";
const BULK_CLOSE = "\u0002";
const SAFE_PATH = /^[\w./@+~-]+$/;
const ARGS = `((?:[ \\t]+(?:"[^"\\n]*"|'[^'\\n]*'|[^\\s;&|<>()]+))*)`;
const AT_COMMAND = `(^|[;\\n&|(]\\s*|\\b(?:do|then|else)\\s+)`;
const INNER_BODY = `((?:(?!\\b(?:for|while|until|select)\\b)[\\s\\S])*?)`;

interface State {
  ctx: ShellContext;
  dir?: string;
  virtual: Map<string, string>;
  code: string[];
  read: string[];
  items: number;
  missing: boolean;
}

const unquote = (v: string) => (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0] ? v.slice(1, -1) : v);
const quote = (v: string) => (v.includes("'") ? `"${v.replace(/(["\\$`])/g, "\\$1")}"` : `'${v}'`);

function resolveFrom(dir: string | undefined, raw: string): string | undefined {
  const p = unquote(raw.trim());
  if (!p || !SAFE_PATH.test(p) || p.startsWith("~")) return;
  if (path.isAbsolute(p)) return path.normalize(p);
  return dir ? path.resolve(dir, p) : undefined;
}

function readText(st: State, raw: string): string | undefined {
  const abs = resolveFrom(st.dir, raw);
  if (!abs) return;
  const text = st.virtual.get(abs) ?? st.ctx.readFile?.(abs);
  if (text !== undefined && !st.read.includes(abs)) st.read.push(abs);
  return text;
}

/** Splits on whitespace, keeping quoted strings and `$(…)` whole. */
function words(s: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  const push = () => {
    if (started) out.push({ text: cur, quoted });
    cur = "";
    quoted = false;
    started = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return out;
      cur += s.slice(i + 1, end);
      quoted = true;
      started = true;
      i = end;
    } else if (c === "$" && s[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      cur += s.slice(i, j + 1);
      started = true;
      i = j;
    } else if (c === "`") {
      const end = s.indexOf("`", i + 1);
      if (end < 0) return out;
      cur += s.slice(i, end + 1);
      started = true;
      i = end;
    } else if (/\s/.test(c)) push();
    else {
      cur += c;
      started = true;
    }
  }
  push();
  return out;
}

/** `{a,b}` and `{1..5}` the way the shell expands them. */
export function braces(word: string, cap = 200): string[] {
  const m = word.match(/\{(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?\}|\{([^{}\s]*,[^{}\s]*)\}/);
  if (!m || m.index === undefined) return [word];
  const pre = word.slice(0, m.index);
  const post = word.slice(m.index + m[0].length);
  let alts: string[] = [];
  if (m[4] !== undefined) alts = m[4].split(",");
  else {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const step = Math.max(1, Number(m[3] ?? 1));
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) {
      alts.push(String(v));
      if (alts.length >= cap) break;
    }
  }
  const out: string[] = [];
  for (const alt of alts) {
    for (const rest of braces(post, cap)) {
      out.push(pre + alt + rest);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** curl's own URL ranges: `[1-3]`, `[a-c]`, `[1-9:2]`. */
export function curlRanges(url: string, cap = 200): string[] {
  const m = url.match(/\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-z])-([a-z])\]/i);
  if (!m || m.index === undefined) return [url];
  const pre = url.slice(0, m.index);
  const post = url.slice(m.index + m[0].length);
  const alts: string[] = [];
  if (m[1] !== undefined) {
    const width = m[1].startsWith("0") ? m[1].length : 0;
    for (let v = Number(m[1]); v <= Number(m[2]) && alts.length < cap; v += Math.max(1, Number(m[3] ?? 1))) alts.push(String(v).padStart(width, "0"));
  } else {
    for (let c = m[4].charCodeAt(0); c <= m[5].charCodeAt(0) && alts.length < cap; c++) alts.push(String.fromCharCode(c));
  }
  const out: string[] = [];
  for (const alt of alts) {
    for (const rest of curlRanges(post, cap)) {
      out.push(pre + alt + rest);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** `${v#pat}`, `${v##pat}`, `${v%pat}`, `${v%%pat}` with shell glob patterns. */
function trimValue(v: string, op: string, pat: string): string {
  const rx = (greedy: boolean) =>
    pat
      .split("")
      .map((ch) => (ch === "*" ? (greedy ? "[\\s\\S]*" : "[\\s\\S]*?") : ch === "?" ? "[\\s\\S]" : ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")))
      .join("");
  if (op === "#") return v.replace(new RegExp("^" + rx(false)), "");
  if (op === "##") return v.replace(new RegExp("^" + rx(true)), "");
  const whole = new RegExp("^" + rx(true) + "$");
  if (op === "%") {
    for (let k = v.length; k >= 0; k--) if (whole.test(v.slice(k))) return v.slice(0, k);
  } else if (op === "%%") {
    for (let k = 0; k <= v.length; k++) if (whole.test(v.slice(k))) return v.slice(0, k);
  }
  return v;
}

/** Replaces `$name`, `${name}` and the trimming forms, outside single quotes. Unknown names are left as written. */
function substVars(text: string, get: (name: string) => string | undefined): string {
  if (!text.includes("$")) return text;
  let out = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && !inSingle) {
      out += c + (text[i + 1] ?? "");
      i++;
    } else if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      out += c;
    } else if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      out += c;
    } else if (c === "$" && !inSingle) {
      const rest = text.slice(i, i + 300);
      const braced = rest.match(/^\$\{([A-Za-z_]\w*|\d|[@*#])(?:(##?|%%?|:[-=])([^}]*))?\}/);
      const bare = braced ? null : rest.match(/^\$([A-Za-z_]\w*|\d|[@*#])/);
      const m = braced ?? bare;
      const value = m ? get(m[1]) : undefined;
      if (m && value !== undefined) {
        out += braced?.[2] && !braced[2].startsWith(":") ? trimValue(value, braced[2], braced[3]) : value;
        i += m[0].length - 1;
      } else if (braced?.[2]?.startsWith(":") && !/[$`]/.test(braced[3])) {
        out += braced[3]; // ${name:-default} with the name unset
        i += braced[0].length - 1;
      } else out += c;
    } else out += c;
  }
  return out;
}

const withArgs = (body: string, args: string[]) =>
  substVars(body, (n) => (/^\d$/.test(n) ? (n === "0" ? undefined : (args[Number(n) - 1] ?? "")) : n === "@" || n === "*" ? args.join(" ") : n === "#" ? String(args.length) : undefined));

/** Items of a `for … in` list, or undefined when any of them can't be known from here. */
function listItems(raw: string, st: State): string[] | undefined {
  const out: string[] = [];
  for (const w of words(raw)) {
    const t = w.text;
    const file = t.match(/^\$\(\s*cat\s+(\S+)\s*\)$/) ?? t.match(/^`\s*cat\s+(\S+)\s*`$/) ?? t.match(/^\$\(\s*<\s*(\S+)\s*\)$/);
    const seq = t.match(/^\$\(\s*seq\s+(-?\d+)(?:\s+(-?\d+))?(?:\s+(-?\d+))?\s*\)$/);
    if (file) {
      const text = readText(st, file[1]);
      if (text === undefined) return;
      out.push(...(w.quoted ? [text.trim()] : text.split(/\s+/).filter(Boolean)));
    } else if (seq) {
      const nums = seq.slice(1).filter((x) => x !== undefined).map(Number);
      const [from, step, to] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
      if (!step) return;
      for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
        out.push(String(v));
        if (out.length > MAX_ITEMS) return;
      }
    } else if (/[$`]/.test(t) || (!w.quoted && /[*?]/.test(t))) return;
    else out.push(...(w.quoted ? [t] : braces(t)));
    if (out.length > MAX_ITEMS) return;
  }
  return out.length ? out : undefined;
}

/** Splits into statements at newlines, `;`, `&&` and `||` that sit outside quotes and substitutions. */
function statements(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += text[++i] ?? "";
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\\") {
      cur += c + (text[i + 1] ?? "");
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      cur += c;
    } else if (c === "$" && (text[i + 1] === "(" || text[i + 1] === "{")) {
      depth++;
      cur += c + text[++i];
    } else if (depth && (c === ")" || c === "}")) {
      depth--;
      cur += c;
    } else if (!depth && (c === "\n" || c === ";")) {
      out.push(cur);
      cur = "";
    } else if (!depth && (c === "&" || c === "|") && text[i + 1] === c) {
      out.push(cur);
      cur = "";
      i++;
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

const VALUE = `(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|\\$\\((?:[^()]|\\([^()]*\\))*\\)|\\$\\{[^}]*\\}|\`[^\`]*\`|[^\\s;&|])*`;
const ASSIGN = new RegExp(`^((?:(?:do|then|else|\\{)\\s+)?(?:(?:export|local|readonly|declare|typeset)\\s+(?:-\\w+\\s+)*)?)([A-Za-z_]\\w*)=(${VALUE})(?=\\s|$)`);

/** Walks the statements in order, tracking assignments, and substitutes every variable it knows. */
function evaluate(text: string): string {
  const env = new Map<string, string>();
  const get = (n: string) => env.get(n);
  const out: string[] = [];
  for (const raw of statements(text)) {
    let rest = raw;
    let head = "";
    for (let guard = 0; guard < 20; guard++) {
      const m = rest.match(ASSIGN);
      if (!m) break;
      rest = rest.slice(m[0].length).trimStart();
      // The output of another command: unknowable here, but the command inside is still read.
      if (/\$\(|`/.test(m[3])) {
        env.delete(m[2]);
        head += `${m[1]}${m[2]}=${substVars(m[3], get)} `;
        continue;
      }
      // Adjacent quoted and bare pieces concatenate: API="http://h"/v1
      const pieces = m[3].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^"']+/g) ?? [];
      const value = pieces.map((p) => (p[0] === "'" ? p.slice(1, -1) : substVars(p[0] === '"' ? p.slice(1, -1).replace(/\\(["\\$`])/g, "$1") : p, get))).join("");
      if (value.includes("$")) env.delete(m[2]);
      else env.set(m[2], value);
      head += `${m[1]}${m[2]}=${quote(value)} `;
    }
    out.push((head + substVars(rest, get)).trim());
  }
  return out.join("\n");
}

function stripComments(script: string) {
  return script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

/** Takes here-documents out of the text: files they create are remembered, shell input is inlined, the rest is set aside. */
function heredocs(text: string, st: State, held: string[]): string {
  for (let guard = 0; guard < 20; guard++) {
    const m = /<<-?[ \t]*(?:(['"])(\w+)\1|\\?(\w+))/.exec(text);
    if (!m) break;
    const delim = m[2] ?? m[3];
    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const lineEnd = text.indexOf("\n", m.index);
    if (lineEnd < 0) break;
    const end = new RegExp(`\\n[ \\t]*${delim}[ \\t]*(?=\\n|$)`).exec(text.slice(lineEnd));
    if (!end) break;
    const body = text.slice(lineEnd + 1, lineEnd + end.index);
    const after = lineEnd + end.index + end[0].length;
    const line = text.slice(lineStart, m.index) + text.slice(m.index + m[0].length, lineEnd);
    const creates = line.match(/\bcat\b[^|;>]*>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/) ?? line.match(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|>]+)/);
    let replacement: string;
    if (creates) {
      const abs = resolveFrom(st.dir, creates[1]);
      if (abs) st.virtual.set(abs, body);
      replacement = "";
    } else if (/^\s*(?:bash|sh|zsh|dash)\b(?:\s+-s)?\s*$/.test(line) || /\|\s*(?:bash|sh|zsh|dash)\b/.test(line)) {
      replacement = stripComments(body);
    } else {
      held.push(body);
      replacement = `${line} \u0000${held.length - 1}\u0000`;
    }
    text = text.slice(0, lineStart) + replacement + text.slice(after);
  }
  return text;
}

function inlineScripts(text: string, st: State): string {
  const isShell = (src: string) => !/^#!/.test(src) || /^#!.*\b(?:ba|z|da|k)?sh\b/.test(src.split("\n", 1)[0]);
  const inline = (whole: string, lead: string, file: string, args: string, explicitShell: boolean) => {
    const src = readText(st, file);
    if (src === undefined) {
      st.missing = true;
      return whole;
    }
    if (!explicitShell && !isShell(src)) {
      st.code.push(src);
      return whole;
    }
    if (text.length + src.length > MAX_TEXT) return whole;
    return `${lead}\n${withArgs(stripComments(src.replace(/\\\n/g, " ")), words(args).map((w) => w.text))}\n`;
  };
  for (let depth = 0; depth < 3; depth++) {
    const before = text;
    // bash -c "…": the string is the script
    text = text.replace(new RegExp(`${AT_COMMAND}(?:bash|sh|zsh|dash)[ \\t]+-[a-z]*c[ \\t]+(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`, "g"), (_w, lead: string, dq?: string, sq?: string) => {
      return `${lead}\n${dq !== undefined ? dq.replace(/\\(["\\$`])/g, "$1") : sq}\n`;
    });
    text = text.replace(
      new RegExp(`${AT_COMMAND}(?:bash|sh|zsh|dash|source|\\.)[ \\t]+(?:-[A-Za-z]+[ \\t]+)*("[^"\\n]+"|'[^'\\n]+'|[^\\s;&|<>()"'\`$-][^\\s;&|<>()"'\`$]*)${ARGS}`, "g"),
      (whole, lead: string, file: string, args: string) => inline(whole, lead, file, args, true),
    );
    text = text.replace(new RegExp(`${AT_COMMAND}((?:\\.{1,2}\\/|\\/)[^\\s;&|<>()"'\`$]+|[\\w.-]+\\.sh)${ARGS}`, "g"), (whole, lead: string, file: string, args: string) =>
      inline(whole, lead, file, args, false),
    );
    if (text === before) break;
  }
  // Scripts in other languages can't be expanded, but their source can be read for the addresses in it.
  for (const m of text.matchAll(new RegExp(`${AT_COMMAND}(?:python[23]?|node|deno[ \\t]+run|bun|ruby|perl|php|tsx|ts-node)[ \\t]+(?:-[A-Za-z]+[ \\t]+)*([^\\s;&|<>()"'\`$-][^\\s;&|<>()"'\`$]*)`, "g"))) {
    if (m[2].includes("\u0000")) continue; // a here-document body, already held as inline code
    const src = readText(st, m[2]);
    if (src === undefined) st.missing = true;
    else if (st.code.length < 5) st.code.push(src);
  }
  return text;
}

function inlineFunctions(text: string): string {
  const funcs = new Map<string, string>();
  text = text.replace(/(^|[;\n])[ \t]*(?:function[ \t]+)?([A-Za-z_][\w-]*)[ \t]*\([ \t]*\)[ \t]*\{([\s\S]*?)\}[ \t]*(?=;|\n|$)/g, (_w, lead: string, name: string, body: string) => {
    funcs.set(name, body.trim().replace(/;$/, ""));
    return lead;
  });
  for (const [name, body] of funcs) {
    const call = new RegExp(`${AT_COMMAND}${name.replace(/[-]/g, "\\-")}${ARGS}(?=\\s*(?:[;\\n&|)]|$))`, "g");
    for (let pass = 0; pass < 2; pass++) {
      text = text.replace(call, (_w, lead: string, args: string) => `${lead}${withArgs(body, words(args).map((w) => w.text))}`);
    }
  }
  return text;
}

function expandLoops(text: string, st: State): string {
  const fits = (n: number, bodyLength: number) => {
    if (st.items + n > MAX_ITEMS || text.length + n * (bodyLength + 40) > MAX_TEXT) return false;
    st.items += n;
    return true;
  };
  const sweep = (n: number, body: string) => (n > BULK ? `\n${BULK_OPEN}\n${body}\n${BULK_CLOSE}\n` : `${body}\n`);
  const each = (name: string, items: string[], body: string) => sweep(items.length, items.map((it) => `${name}=${quote(it)}\n${body.trim()}`).join("\n"));
  const lines = (src: string) =>
    src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  const WHILE = new RegExp(
    `(?:\\bcat[ \\t]+(\\S+)[ \\t]*\\|[ \\t]*)?\\bwhile[ \\t]+(?:IFS=\\S*[ \\t]+)?read[ \\t]+(?:-[a-z]+[ \\t]+)*([A-Za-z_]\\w*)[ \\t]*(?:;|\\n)\\s*do\\b${INNER_BODY}\\s*;?\\s*\\bdone\\b(?:[ \\t]*<[ \\t]*(\\S+))?`,
    "g",
  );
  const FOR = new RegExp(`\\bfor[ \\t]+([A-Za-z_]\\w*)[ \\t]+in[ \\t]+([^;\\n]*?)[ \\t]*(?:;|\\n)\\s*do\\b${INNER_BODY}\\s*;?\\s*\\bdone\\b`, "g");
  const XARGS = /\bcat[ \t]+(\S+)[ \t]*\|[ \t]*xargs\b((?:[ \t]+-(?!I)[A-Za-z]+(?:[ \t]*\d+)?)*)(?:[ \t]+-I[ \t]*(\S+))?((?:[ \t]+-(?!I)[A-Za-z]+(?:[ \t]*\d+)?)*)[ \t]+([^\n;|]+)/g;
  for (let round = 0; round < 30; round++) {
    const before = text;
    text = text.replace(WHILE, (whole, piped: string | undefined, name: string, body: string, redirected: string | undefined) => {
      const src = readText(st, redirected ?? piped ?? "");
      if (src === undefined) return whole;
      const items = lines(src);
      return items.length && fits(items.length, body.length) ? each(name, items, body) : whole;
    });
    text = text.replace(FOR, (whole, name: string, raw: string, body: string) => {
      const items = listItems(raw, st);
      return items && fits(items.length, body.length) ? each(name, items, body) : whole;
    });
    text = text.replace(XARGS, (whole, file: string, _f1: string, token: string | undefined, _f2: string, cmd: string) => {
      const src = readText(st, file);
      if (src === undefined) return whole;
      const items = lines(src);
      if (!items.length || !fits(items.length, cmd.length)) return whole;
      return sweep(items.length, items.map((it) => (token ? cmd.split(token).join(it) : `${cmd.trim()} ${it}`)).join("\n"));
    });
    if (text === before) break;
  }
  return text;
}

/** What a wordlist-driven scanner will request: the URL template crossed with its wordlist. */
function scannerProbes(shell: string, st: State): string[] {
  const out: string[] = [];
  for (const line of statements(shell)) {
    const prog = line.match(/(?:^|\s)(ffuf|wfuzz|gobuster|dirb|feroxbuster|dirsearch)(?:\.py)?\b/)?.[1];
    if (!prog) continue;
    const url = unquote(line.match(/\s(?:-u|--url)[ \t=]+("[^"]+"|'[^']+'|\S+)/)?.[1] ?? (prog === "dirb" ? (line.match(/\bdirb\s+(https?:\S+)/)?.[1] ?? "") : ""));
    const list = line.match(/\s(?:-w|--wordlist)[ \t=]+("[^"]+"|'[^']+'|[^\s:]+)/)?.[1] ?? (prog === "dirb" ? line.match(/\bdirb\s+\S+\s+(\S+)/)?.[1] : undefined);
    if (!/^https?:\/\//i.test(url) || /[$`]/.test(url) || !list) continue;
    const src = readText(st, list);
    if (src === undefined) continue;
    const entries = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (entries.length > MAX_ITEMS) continue;
    const fuzzed = /\bFUZZ\b/.test(url);
    for (const w of entries) out.push(fuzzed ? url.replace(/\bFUZZ\b/g, w) : `${url.replace(/\/+$/, "")}/${w.replace(/^\/+/, "")}`);
  }
  return out;
}

export function expand(raw: string, ctx: ShellContext = {}): Expansion {
  const plain = (): Expansion => ({ text: raw, shell: raw, code: [], inline: [], missing: true, urls: scanUrls(raw), probes: [], read: [] });
  if (raw.length > MAX_CMD) return plain();
  const st: State = { ctx, dir: ctx.cwd, virtual: new Map(), code: [], read: [], items: 0, missing: false };
  let text = raw.replace(/\\\n/g, " ");
  const cd = text.match(/^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:;|&&|\n)/);
  if (cd) st.dir = resolveFrom(st.dir, cd[1]) ?? st.dir;
  const held: string[] = [];
  try {
    text = heredocs(text, st, held);
    text = inlineScripts(text, st);
    text = inlineFunctions(text);
    text = expandLoops(text, st);
    if (text.length <= MAX_TEXT) text = evaluate(text);
  } catch {
    return plain(); // an unexpected shape: read it as written
  }
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `\n\u0003${held[Number(i)]}\u0003\n`);
  const urls = scanUrls(text.replace(/\u0003/g, ""));
  const clean = (t: string) => t.replace(/[\u0001\u0002]\n?/g, "");
  const shell = clean(text.replace(/\u0003[\s\S]*?\u0003/g, " "));
  const inline = [...held, ...[...raw.matchAll(/\s-(?:c|e|r|-eval|-execute)[ \t]+("(?:[^"\\]|\\.)*"|'[^']*')/g)].map((m) => m[1].slice(1, -1))];
  return { text: clean(text.replace(/\u0003/g, "")), shell, code: st.code, inline, missing: st.missing, urls, probes: scannerProbes(shell, st), read: st.read };
}

/** The command as the shell would run it, with what can be expanded expanded. */
export const expandShell = (cmd: string, ctx?: ShellContext) => expand(cmd, ctx).text;

// Stops at shell punctuation, but keeps `&name=value` pairs: a query string is part of the address.
const URL_IN_SHELL = /\bhttps?:\/\/[^\s'"`|;&<>)]+(?:&[\w.[\]%-]+=[^\s'"`|;&<>)]*)*/gi;

/**
 * The addresses written in an expanded command. Each is taken with the options
 * around it: a `Host:` header names the site actually requested, and `-G` moves
 * `-d` pairs into the query string.
 */
export const urlsIn = (text: string) => scanUrls(text).map((u) => u.url);

function scanUrls(text: string): { url: string; bulk: boolean }[] {
  const found: { url: string; bulk: boolean }[] = [];
  let depth = 0;
  for (const line of text.split("\n")) {
    if (line === BULK_OPEN) depth++;
    else if (line === BULK_CLOSE) depth = Math.max(0, depth - 1);
    if (!/https?:\/\//i.test(line)) continue;
    const vhost = line.match(/(?:-H|--header)[ \t=]*(["'])\s*Host:\s*([A-Za-z0-9.-]+)(?::\d+)?\s*\1/i)?.[2];
    const query = /\s(?:-G|--get)\b/.test(line)
      ? [...line.matchAll(/\s(?:-d|--data|--data-urlencode|--data-raw)[ \t=]*(["']?)([A-Za-z_][\w.[\]-]*=[^\s"']*)\1/g)].map((m) => m[2]).join("&")
      : "";
    for (const m of line.matchAll(URL_IN_SHELL)) {
      for (const braced of braces(m[0], 60)) {
        for (let url of curlRanges(braced, 60)) {
          if (vhost) url = url.replace(/^(https?:\/\/)[^/:?#]+/i, `$1${vhost}`);
          if (query) url += (url.includes("?") ? "&" : "?") + query;
          found.push({ url, bulk: depth > 0 });
        }
      }
    }
  }
  return found;
}
