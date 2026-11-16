/** The Claude Code hook events Spectra registers for. */
export const EVENTS: string[];

/** The settings file for one project, or for every project when `user` is set. */
export function settingsPathFor(target: { projectDir?: string; user?: boolean }): string;

/**
 * Adds (or with `remove`, takes out) the Spectra hook in one settings file and returns its path.
 * Throws if the file exists and isn't valid JSON.
 */
export function installHooks(options: { settingsPath: string; hookScript: string; remove?: boolean }): string;
