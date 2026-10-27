/** "mcp__Claude_Browser__navigate" → "Claude_Browser.navigate"; built-in tools pass through. */
export function formatTool(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const [, server = "mcp", ...rest] = name.split("__");
  const label = /^[0-9a-f-]{20,}$/i.test(server) ? "mcp" : server;
  return `${label}.${rest.join("__")}`;
}

export function clock(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}
