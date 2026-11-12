import fs from "node:fs";
import path from "node:path";

/**
 * Settings changed from the dashboard, kept in one owner-only file
 * (~/.spectra/settings.json by default). The Navigator's API key lives here
 * when it's entered in Settings; it is never sent back to the browser.
 */

export interface Settings {
  navigator: {
    apiKey?: string;
    model?: string;
    enabled?: boolean;
  };
}

export class SettingsStore {
  private data: Settings = { navigator: {} };

  /** Without a file, settings last for the life of the process (tests). SPECTRA_PERSIST doesn't affect this file. */
  constructor(private file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && raw.navigator && typeof raw.navigator === "object") this.data = { navigator: { ...raw.navigator } };
    } catch {
      // No settings yet, or an unreadable file: start from defaults.
    }
  }

  get(): Settings {
    return { navigator: { ...this.data.navigator } };
  }

  update(patch: Partial<Settings["navigator"]>): Settings {
    const next = { ...this.data.navigator, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    this.data = { navigator: next };
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(this.file, 0o600); // writeFileSync keeps an existing file's mode
    }
    return this.get();
  }
}
