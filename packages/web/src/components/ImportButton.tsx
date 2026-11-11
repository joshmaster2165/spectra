import { useEffect, useRef, useState } from "react";
import { addSummary, describeImport, emptySummary, parseHar, type ImportSummary } from "@spectra/schema";

const CHUNK = 1500;

/**
 * Imports proxy history (HAR from Burp, Caido, ZAP or browser devtools). The
 * file is parsed here, in the browser: only methods, URLs without query
 * strings, status codes, content types and parameter names reach the hub.
 */
export function ImportButton() {
  const input = useRef<HTMLInputElement>(null);
  // `text` is the short pill; `detail` the full summary (also logged to the activity stream).
  const [status, setStatus] = useState<{ text: string; detail?: string; error?: boolean; busy?: boolean }>();

  // Success messages fade after a while; errors stay until dismissed.
  useEffect(() => {
    if (!status || status.error || status.busy) return;
    const t = setTimeout(() => setStatus(undefined), 15_000);
    return () => clearTimeout(t);
  }, [status]);

  const importFile = async (file: File) => {
    setStatus({ text: `Importing ${file.name}…`, busy: true });
    try {
      const entries = parseHar(JSON.parse(await file.text()));
      let total: ImportSummary = emptySummary();
      for (let i = 0; i < entries.length; i += CHUNK) {
        const res = await fetch("/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ entries: entries.slice(i, i + CHUNK), label: file.name }),
        });
        if (!res.ok) throw new Error(`The hub couldn't import it (${res.status}).`);
        total = addSummary(total, await res.json());
      }
      const detail = [describeImport(total), total.outOfScopeHosts.length && `Out of scope: ${total.outOfScopeHosts.join(", ")}`, total.hint]
        .filter(Boolean)
        .join("\n");
      const n = total.newEndpoints;
      const text = total.imported ? `Imported ${total.imported} · ${n} new endpoint${n === 1 ? "" : "s"}` : "Nothing in scope to import";
      setStatus({ text, detail, error: !total.imported });
    } catch (err) {
      setStatus({ text: err instanceof SyntaxError ? `${file.name} isn't valid JSON.` : err instanceof Error ? err.message : String(err), error: true });
    }
  };

  return (
    <>
      <button className="ghost" onClick={() => input.current?.click()} title="Import proxy history: a HAR file from Burp, Caido, ZAP or browser devtools">
        Import HAR
      </button>
      <input
        ref={input}
        type="file"
        accept=".har,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void importFile(file);
        }}
      />
      {status && (
        <button
          className={`import-status ${status.error ? "err" : ""}`}
          title={(status.detail ?? status.text) + "\n\nClick to dismiss."}
          onClick={() => setStatus(undefined)}
        >
          {status.text}
        </button>
      )}
    </>
  );
}
