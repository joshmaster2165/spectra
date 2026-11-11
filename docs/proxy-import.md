# Proxy import

Spectra shows what the agent did; an intercepting proxy shows what crossed the wire. Importing your proxy's history as a HAR file puts that traffic on the same map: endpoints the agent also touched merge into one node with request counts, methods and status codes, and endpoints only the proxy saw arrive as **unmapped** — a ready-made list of surface nobody has tested yet, which the [Navigator](navigator.md#traffic-only-targets) weighs as leads. The file is reduced on your side before anything reaches the hub: only methods, URLs without query strings, status codes, content types and parameter **names** are sent — never values.

## Get a HAR file

Most intercepting proxies can export their history as HAR (HTTP Archive 1.2), either directly or through an extension; check your proxy's documentation, and make sure the export is HAR rather than the proxy's own format. Any browser can export one from its developer tools: open the **Network** tab, reproduce the traffic, and choose **Save all as HAR**.

A HAR is JSON with a `log.entries` array. Spectra reads each entry's request method, URL, query-string names, form and body field names, response status and response content type.

## Import it

**From the dashboard:** click **Import HAR** in the top bar and choose the file. A status pill reports the result — *Imported 7 · 5 new endpoints*, or *Nothing in scope to import*. Hover the pill for the full summary; click it to dismiss. Successful results fade after 15 seconds; errors stay until dismissed. The button is hidden during replay.

**From the command line:**

```bash
npm run import -- /path/to/history.har
npm run import -- first.har second.har          # several files
npm run import -- /path/to/history.har --include-static
```

It prints one summary line per file, the most frequent out-of-scope hosts, and a hint when nothing was in scope:

```
history.har: Imported 7 of 10 requests: 6 endpoints (5 new), 6 parameters; skipped 2 out of scope, 1 static.
  out of scope: www.googletagmanager.com, api.segment.io
```

Relative paths are resolved from the directory you ran the command in. The CLI sends to `SPECTRA_HUB` (default `http://127.0.0.1:4317`).

Both paths send entries to the hub's `POST /import` in chunks of 1,500, so large histories are fine. The summary also appears in **Activity → Stream**, tagged *proxy import*.

## What's kept and what's dropped

| Kept | Dropped |
|---|---|
| Request method | Header values, including cookies and `Authorization` |
| URL scheme, host and path | Query-string values, fragments, and any user name or password in the URL |
| Response status code | Request and response bodies |
| Response content type | Form and JSON field **values** |
| Parameter **names**: query-string keys, form fields, and the top-level keys of a JSON or URL-encoded body | Timings, cookies, and everything else in the HAR |

- **Parsing happens on your side** — in the browser for the dashboard button, in the CLI process for `npm run import`. The HAR file itself never reaches the hub.
- **Query strings are stripped twice.** The parser removes the query string, fragment and credentials from each URL before sending it, and the hub strips anything after `?` or `#` again on arrival, whatever the client sent.
- **Paths are normalized** the same way as the agent's traffic. Numeric segments, UUIDs and long hex strings become `:id`; token-like segments (20 or more letters, digits, `_` or `-`, mixing letters and digits, with fewer than two hyphens) become `:token`, so a password-reset link such as `/reset/k7Qm2xV9pL4sT8nB1wZ6yR3c` lands on the map as `/reset/:token`. Only the first six path segments are kept.
- **Limits.** Up to 40 parameter names per request (each truncated to 80 characters), URLs up to 4,096 characters, and 5,000 entries per `/import` request.

## Scope filtering

Only requests to hosts in your scope are imported, the way a proxy's "in-scope only" view works. Third-party hosts — CDNs, analytics, fonts — are counted as *out of scope* and the most frequent ones are listed so you can check you haven't missed one of the target's hosts.

The scope must exist and include the target's hosts **before** you import. If no scope is set yet (no paths configured and no session started), everything is skipped. See [Setup → Set your scope](setup.md#1-set-your-scope).

## Static assets

By default, requests for static files are skipped and counted as *static*:

- paths ending in `.js`, `.mjs`, `.css`, `.map`, image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.ico`, `.webp`, `.avif`, `.bmp`), fonts (`.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`), media (`.mp4`, `.webm`, `.mp3`, `.wav`) or `.pdf`;
- responses whose content type is an image, font, audio or video type, `text/css`, or anything containing `javascript`.

Add `--include-static` on the command line to keep them — useful when you want JS bundles on the map to mine for routes. The dashboard button always skips static assets.

## How it merges with the agent's map

Imported targets use the same ids as the agent's own traffic — `domain:<domain>`, `host:<hostname>`, `endpoint:<hostname><route>`, `param:<hostname><route>?<name>` — so there is one node per endpoint whichever way it arrived.

- **A target already on the map** keeps its place and status, and gains traffic properties.
- **A new target** is added as **unexplored** (*unmapped*) under its host. If the import brings a domain the map doesn't have yet, it's placed under a new root, *proxy · \<file name\>*, with the proxy-import icon.
- Imported events are recorded with the source `proxy` in the current session's audit log (or a new `import-…` session if no session has started).

Each imported target gets these properties, visible in the [Target](dashboard.md#target) view and used by the Surface table:

| Property | Meaning |
|---|---|
| **seen in** | *proxy traffic* if it was new when imported; *agent and proxy traffic* if it was already on the map. The Surface **Source** column shows these as *proxy* and *both*. |
| **requests** | How many requests in the history hit it. Domains and hosts count every request beneath them. |
| **methods** | The HTTP methods seen, such as `GET, POST`. |
| **status codes** | The response codes seen, such as `200, 403`. |

Two things to know:

- **Re-importing adds up.** Importing the same file twice doubles its request counts. Restart the hub for a clean map.
- **Order doesn't matter.** Import before or after the agent works. If the agent later requests an endpoint that only the proxy had seen, the endpoint keeps its traffic details and becomes *seen in agent and proxy traffic* (source *both* in Surface).

## Try the example

`examples/acme-shop.har` is a small history for the demos' fictional target: ten requests, including an admin export, an object fetched by numeric id, an OAuth token request, a password-reset link, a JS bundle and two analytics calls. Both demos import it at the end. To import it yourself, start a fresh hub, put `acme-shop.test` in scope, and import:

```bash
curl -X POST http://127.0.0.1:4317/scope -H 'content-type: application/json' \
  -d '{"paths":["/path/to/target-repo"],"hosts":["acme-shop.test"]}'
npm run import -- examples/acme-shop.har
```

```
acme-shop.har: Imported 7 of 10 requests: 6 endpoints (6 new), 6 parameters; skipped 2 out of scope, 1 static.
  out of scope: www.googletagmanager.com, api.segment.io
```

The "new" count depends on what's already on the map. Look for `/api/admin/export` and `/api/users/:id/addresses` appearing as unmapped, `/reset/:token` with its token collapsed, and the `password` field of the token request present as a parameter name with no value.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| *Nothing in this file is in scope. Add the target's hosts to your scope (spectra.config.json or POST /scope) and import again.* (dashboard: *Nothing in scope to import*) | No scope yet, or the target's hosts aren't in it. Check the listed out-of-scope hosts, add the right ones, and import again. |
| *Not a HAR file: expected log.entries* | The file is JSON but not HAR — often a proxy's own export format. Export as HAR. |
| *\<file\> isn't valid JSON.* (dashboard) or a JSON parse error (CLI) | The file is truncated or not JSON. Export again. |
| *Can't reach the hub at http://127.0.0.1:4317. Start it with npm start.* | The hub isn't running, or it's on another port: set `SPECTRA_HUB`. |
| *The hub couldn't import it (\<status\>).* (dashboard) or *hub returned \<status\> …* (CLI) | The hub rejected a chunk. Check the hub's terminal. |
| *usage: npm run import -- \<file.har\> [more.har ...] [--include-static]* | No file was given. |
| Everything imported as *static* | The history is mostly assets. Add `--include-static` if you want them. |
| Lots of *out of scope* | Expected for third-party hosts. If one of the target's own hosts is listed, add it to your scope. |

---

**Next:** [Configuration](configuration.md)
