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
  /**
   * The Interpreter reads the output of actions the hub couldn't. "unread":
   * only those. "all": also output that lists paths the map doesn't have.
   * Absent: off. It uses the Navigator's key and model.
   */
  interpreter: {
    mode?: InterpreterMode;
  };
  /**
   * MCP tools the operator has said never touch the target (a notes server, a
   * docs lookup): their calls aren't listed as unread. Each entry is a tool
   * name, or a server prefix ending in "__" that covers all of its tools.
   */
  localTools: string[];
}

/** A tool name, or a whole server's prefix: "mcp__notes__add" or "mcp__notes__". */
export const LOCAL_TOOL = /^mcp__[\w.-]{1,60}__[\w.-]{0,60}$/;

export type InterpreterMode = "unread" | "all";

export class SettingsStore {
  private data: Settings = { navigator: {}, interpreter: {}, localTools: [] };

  /** Without a file, settings last for the life of the process (tests). SPECTRA_PERSIST doesn't affect this file. */
  constructor(private file?: string) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") {
        const obj = (v: unknown) => (v && typeof v === "object" ? { ...(v as object) } : {});
        const mode = (raw.interpreter as { mode?: unknown } | undefined)?.mode;
        const tools = Array.isArray(raw.localTools) ? raw.localTools.filter((t: unknown): t is string => typeof t === "string" && LOCAL_TOOL.test(t)).slice(0, 100) : [];
        this.data = { navigator: obj(raw.navigator), interpreter: mode === "unread" || mode === "all" ? { mode } : {}, localTools: tools };
      }
    } catch {
      // No settings yet, or an unreadable file: start from defaults.
    }
  }

  get(): Settings {
    return { navigator: { ...this.data.navigator }, interpreter: { ...this.data.interpreter }, localTools: [...this.data.localTools] };
  }

  /** `interpreter: null` turns the Interpreter off. */
  update(patch: Partial<Settings["navigator"]>, interpreter?: InterpreterMode | null): Settings {
    const next = { ...this.data.navigator, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    this.data = { ...this.data, navigator: next, interpreter: interpreter === undefined ? this.data.interpreter : interpreter ? { mode: interpreter } : {} };
    this.save();
    return this.get();
  }

  /** Adds or removes a tool the operator treats as local. Returns false for a name that isn't an MCP tool or server. */
  setLocalTool(name: string, local: boolean): boolean {
    if (!LOCAL_TOOL.test(name)) return false;
    const rest = this.data.localTools.filter((t) => t !== name);
    this.data = { ...this.data, localTools: local ? [...rest, name].slice(-100) : rest };
    this.save();
    return true;
  }

  private save() {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(this.file, 0o600); // writeFileSync keeps an existing file's mode
    }
  }
}
