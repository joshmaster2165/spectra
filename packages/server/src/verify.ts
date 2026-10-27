import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyFile } from "./audit.ts";

/**
 * Checks hash-chained audit logs.
 *
 *   npm run verify                    every session in ~/.spectra/sessions
 *   npm run verify -- <id|file>       one session
 *   npm run verify -- <id> <head>     also confirm the head hash you recorded earlier
 *
 * Exits 1 if any log fails.
 */
const dir = process.env.SPECTRA_DATA_DIR ?? path.join(os.homedir(), ".spectra", "sessions");
const [target, expectedHead] = process.argv.slice(2);

const files = target
  ? [fs.existsSync(target) ? target : path.join(dir, `${target.replace(/[^\w.-]/g, "_")}.jsonl`)]
  : fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f))
    : [];

if (!files.length) {
  console.log(`no audit logs in ${dir}`);
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const r = verifyFile(file);
  const name = path.basename(file, ".jsonl");
  if (r.ok) {
    console.log(`ok    ${name}  ${r.events} events  head ${r.head ?? "(empty)"}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  line ${r.badLine}: ${r.reason}`);
  }
  if (expectedHead && r.ok) {
    // The head only moves forward; an earlier recorded head must still be in the chain.
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const at = lines.findIndex((l) => JSON.parse(l)._hash === expectedHead);
    if (at < 0) {
      failed++;
      console.log(`FAIL  ${name}  recorded head ${expectedHead.slice(0, 16)}… is not in the log (log was rewritten)`);
    } else {
      console.log(`ok    ${name}  recorded head found at event ${at + 1}; ${lines.length - at - 1} events appended since`);
    }
  }
}
process.exit(failed ? 1 : 0);
