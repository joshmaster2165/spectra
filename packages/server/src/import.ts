import fs from "node:fs";
import path from "node:path";
import { addSummary, describeImport, emptySummary, parseHar, type ImportSummary } from "@spectra/schema";

/**
 * Imports proxy history (HAR from Burp, Caido, ZAP or browser devtools) into a
 * running hub. Parsing happens here: only methods, URLs without query strings,
 * status codes, content types and parameter *names* are sent.
 *
 *   npm run import -- burp-history.har [more.har ...] [--include-static]
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const CHUNK = 1500;
const args = process.argv.slice(2);
const includeStatic = args.includes("--include-static");
const files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  console.error("usage: npm run import -- <file.har> [more.har ...] [--include-static]");
  process.exit(1);
}

// npm runs workspace scripts from the package directory; resolve against where the command was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();

for (const file of files) {
  const full = path.resolve(cwd, file);
  let entries;
  try {
    entries = parseHar(JSON.parse(fs.readFileSync(full, "utf8")));
  } catch (err) {
    console.error(`${file}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    continue;
  }

  let total: ImportSummary = emptySummary();
  for (let i = 0; i < entries.length; i += CHUNK) {
    let res: Response;
    try {
      res = await fetch(`${HUB}/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: entries.slice(i, i + CHUNK), label: path.basename(file), includeStatic }),
      });
    } catch {
      console.error(`Can't reach the hub at ${HUB}. Start it with npm start.`);
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`${file}: hub returned ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    total = addSummary(total, (await res.json()) as ImportSummary);
  }

  console.log(`${path.basename(file)}: ${describeImport(total)}`);
  if (total.outOfScopeHosts.length) console.log(`  out of scope: ${total.outOfScopeHosts.join(", ")}`);
  if (total.hint) console.log(`  ${total.hint}`);
}
