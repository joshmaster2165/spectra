// Stand-ins for ffuf, gobuster and httpx, so the tests need none of them installed.
// They make the same requests and print in the same line format as the real tools,
// which is what Spectra reads: the command line and the output.
import fs from "node:fs";
const [tool, ...args] = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const words = (f) => fs.readFileSync(f, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const get = async (url) => {
  try {
    const r = await fetch(url, { redirect: "manual" });
    const body = await r.text();
    return { status: r.status, size: body.length, title: (body.match(/<title>([^<]*)/) ?? [])[1] };
  } catch {
    return { status: 0, size: 0 };
  }
};
const match = (opt("-mc") ?? "200,204,301,302,307,401,403,405,500").split(",").map(Number);

if (tool === "ffuf") {
  const u = opt("-u");
  for (const w of words(opt("-w").split(":")[0])) {
    const r = await get(u.replace("FUZZ", w));
    if (match.includes(r.status)) console.log(`${w.padEnd(24)}[Status: ${r.status}, Size: ${r.size}, Words: 1, Lines: 1, Duration: 1ms]`);
  }
} else if (tool === "gobuster") {
  const u = opt("-u").replace(/\/$/, "");
  console.log("===============================================================\nStarting gobuster in directory enumeration mode\n===============================================================");
  for (const w of words(opt("-w"))) {
    const r = await get(`${u}/${w}`);
    if (r.status !== 404 && r.status !== 0) console.log(`/${w.padEnd(21)}(Status: ${r.status}) [Size: ${r.size}]`);
  }
} else if (tool === "httpx") {
  const list = opt("-l") ? words(opt("-l")) : fs.readFileSync(0, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  for (const h of list) {
    const url = /^https?:/.test(h) ? h : `http://${h}`;
    const r = await get(url);
    if (r.status && r.status !== 421) console.log(`${url} [${r.status}]${r.title ? ` [${r.title}]` : ""}`);
  }
}
