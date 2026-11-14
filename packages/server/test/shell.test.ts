// The shell expander: the hook sees one unexpanded command string, so the hub has to work out
// which addresses it really requests. Each case lists exactly those.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { expand, urlsIn, type Expansion } from "../src/shell.ts";
import { HERE } from "./helpers.ts";

const PROJ = path.join(HERE, "lab", "project");
const ctx = { cwd: PROJ, readFile: (p: string) => (p.startsWith(PROJ) && fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined) };
const paths = fs.readFileSync(`${PROJ}/wordlists/paths.txt`, "utf8").split("\n").filter(Boolean);
const subs = fs.readFileSync(`${PROJ}/wordlists/subdomains.txt`, "utf8").split("\n").filter(Boolean);
const S = "http://shop.lab.localhost:4420";
const A = "http://api.lab.localhost:4420";

/** `want` is the full set of URLs the command requests; `unresolved` says a URL still holding a `$` is expected. */
function requests(name: string, cmd: string, want: string[], opts: { unresolved?: boolean } = {}) {
  test(name, () => {
    const e = expand(cmd, ctx);
    const all = urlsIn(e.text);
    const urls = [...new Set(all.filter((u) => !/[$`{}]/.test(u)))];
    assert.deepEqual(urls.sort(), [...new Set(want)].sort());
    assert.equal(all.some((u) => /[$`]/.test(u)), !!opts.unresolved, "a URL left unresolved");
  });
}
function reads(name: string, cmd: string, check: (e: Expansion) => void) {
  test(name, () => check(expand(cmd, ctx)));
}

requests("plain", `curl -s ${S}/login`, [`${S}/login`]);
requests("base variable", `B=${S}; curl -s $B/login; curl -s "$B/products?id=2"`, [S, `${S}/login`, `${S}/products?id=2`]);
requests("export and ${VAR}", `export API=${A}; curl -s "\${API}/v1/x" -X POST`, [A, `${A}/v1/x`]);
requests("for over literals", `for p in robots.txt sitemap.xml; do curl -s -o /dev/null -w "$p %{http_code}\\n" ${S}/$p; done`, [`${S}/robots.txt`, `${S}/sitemap.xml`]);
requests("for over $(cat wordlist)", `for p in $(cat wordlists/paths.txt); do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${S}/$p)"; done`, paths.map((p) => `${S}/${p}`));
requests("cd, then a relative wordlist", `cd ${PROJ}/wordlists; for p in $(cat paths.txt); do curl -s ${S}/$p; done`, paths.map((p) => `${S}/${p}`));
requests("while read < file", `while read -r s; do echo "$s $(curl -s -m3 -o /dev/null -w '%{http_code}' "http://$s.lab.localhost:4420/")"; done < wordlists/subdomains.txt`, subs.map((s) => `http://${s}.lab.localhost:4420/`));
requests("cat | while read", `cat wordlists/paths.txt | while read p; do code=$(curl -s -o /dev/null -w '%{http_code}' ${S}/$p); [ "$code" != 404 ] && echo "$code /$p"; done`, paths.map((p) => `${S}/${p}`));
requests("xargs -I{}", `cat wordlists/paths.txt | xargs -I{} curl -s -o /dev/null -w "%{http_code} /{}\\n" ${A}/{}`, paths.map((p) => `${A}/${p}`));
requests(
  "nested loops",
  `for h in shop staging; do for p in login debug .env; do echo "$h /$p $(curl -s -o /dev/null -w '%{http_code}' http://$h.lab.localhost:4420/$p)"; done; done`,
  ["shop", "staging"].flatMap((h) => ["login", "debug", ".env"].map((p) => `http://${h}.lab.localhost:4420/${p}`)),
);
requests(
  "seq and a brace range",
  `for i in $(seq 1001 1003); do curl -s ${A}/v1/orders/$i; done; for i in {1..2}; do curl -s ${S}/products?id=$i; done`,
  [1001, 1002, 1003].map((i) => `${A}/v1/orders/${i}`).concat([1, 2].map((i) => `${S}/products?id=${i}`)),
);
requests("curl ranges", `curl -s "${A}/v1/users/[1-3]"`, [1, 2, 3].map((i) => `${A}/v1/users/${i}`));
requests("curl brace list", `curl -s -o /dev/null "${S}/{login,products,help/contact}"`, ["login", "products", "help/contact"].map((p) => `${S}/${p}`));
requests("brace hosts", `curl -s http://{shop,staging}.lab.localhost:4420/.env`, ["shop", "staging"].map((h) => `http://${h}.lab.localhost:4420/.env`));
requests("Host header on an IP", `curl -s -H "Host: admin.lab.localhost" http://127.0.0.1:4420/login`, ["http://admin.lab.localhost:4420/login"]);
requests("-G turns -d into a query", `curl -s -G -d user_id=3 -d status=open ${A}/v1/orders`, [`${A}/v1/orders?user_id=3&status=open`]);
requests("shell function", `probe(){ curl -s -o /dev/null -w "%{http_code} $1\\n" "http://admin.lab.localhost:4420$1"; }; probe /login; probe /users`, ["http://admin.lab.localhost:4420/login", "http://admin.lab.localhost:4420/users"]);
requests(
  "a list taken from a live response stays unresolved",
  `for p in $(curl -s ${A}/openapi.json | jq -r '.paths | keys[]'); do echo "$p $(curl -s -o /dev/null -w '%{http_code}' ${A}$p)"; done`,
  [`${A}/openapi.json`],
  { unresolved: true },
);
requests("a token in a variable is not a URL problem", `T=$(curl -s -X POST ${A}/v1/auth/login | jq -r .token); curl -s -H "Authorization: Bearer $T" ${A}/v1/orders/1001`, [`${A}/v1/auth/login`, `${A}/v1/orders/1001`]);
requests("a shell script in the project is read", `./list-routes.sh`, [A, `${A}/openapi.json`]);
requests(
  "method and path pairs with ${r%% *} trimming",
  `API=${A}\nfor r in "GET /v1/users/me" "GET /v1/orders?user_id=1&status=open" "POST /v1/auth/reset"; do\n  m=\${r%% *}; p=\${r#* }\n  a=$(curl -s -m3 -o /dev/null -w '%{http_code}' -X "$m" "$API$p")\n  echo "$r | anon=$a"\ndone`,
  [A, `${A}/v1/users/me`, `${A}/v1/orders?user_id=1&status=open`, `${A}/v1/auth/reset`],
);
requests(
  "a script written by heredoc, then run",
  `cat > probe-x.sh <<'EOF'\nfor p in dashboard users; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' http://admin.lab.localhost:4420/$p)"; done\nEOF\nbash probe-x.sh`,
  ["dashboard", "users"].map((p) => `http://admin.lab.localhost:4420/${p}`),
);
requests("bash -c string", `bash -c 'for p in a b; do curl -s ${S}/$p; done'`, [`${S}/a`, `${S}/b`]);
requests("a python heredoc keeps its literals and is not treated as shell", `python3 - <<'EOF'\nbase = "http://staging.lab.localhost:4420"\nfor p in ["/debug"]:\n    print(p)\nEOF`, ["http://staging.lab.localhost:4420"]);
requests("awk's $2 is left alone", `curl -s ${S}/robots.txt | awk '{print $2}' | head -3`, [`${S}/robots.txt`]);
requests("the words for and done inside echo are not a loop", `echo "waiting for it"; curl -s ${S}/login; echo done`, [`${S}/login`]);
requests("a wordlist outside the project is not opened", `for p in $(cat /etc/hosts); do curl -s ${S}/$p; done`, [], { unresolved: true });

reads("a python script's source is read", `python3 check.py`, (e) => {
  assert.equal(e.code.length, 1);
  assert.match(e.code[0], /shop\.lab\.localhost/);
});
reads("ffuf's probes come from its wordlist", `ffuf -u ${S}/FUZZ -w wordlists/paths.txt -mc 200`, (e) => {
  assert.equal(e.probes.length, paths.length);
  assert.equal(e.probes[0], `${S}/${paths[0]}`);
});
reads("gobuster's probes come from its wordlist", `gobuster dir -u ${S} -w wordlists/paths.txt -q`, (e) => {
  assert.equal(e.probes.length, paths.length);
  assert.ok(e.probes.includes(`${S}/login`));
});
