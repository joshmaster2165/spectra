import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { SpectraEvent } from "@spectra/schema";

/**
 * Spectra recon MCP server. Claude Code launches this over stdio; the agent
 * calls these tools to annotate the attack-surface map as it works, and we
 * forward each call to the hub as SpectraEvents.
 *
 *   claude mcp add spectra -- npx tsx /path/to/Spectra/packages/server/src/mcp.ts
 *
 * stdout is the MCP channel, so log only to stderr.
 */

const HUB = process.env.SPECTRA_HUB ?? "http://127.0.0.1:4317";
const SESSION = process.env.SPECTRA_SESSION ?? "mcp";

type Payload = SpectraEvent extends infer E ? (E extends SpectraEvent ? Omit<E, "ts" | "sessionId" | "source"> : never) : never;

async function post(events: Payload[]) {
  const body = events.map((e) => ({ ...e, sessionId: SESSION, source: "mcp" }));
  try {
    await fetch(`${HUB}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[spectra-mcp] hub unreachable:", err);
  }
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

const server = new McpServer({ name: "spectra", version: "0.1.0" });

server.tool(
  "map_target",
  "Add or update a target on the attack-surface map: an asset you discovered — a host, subdomain, API endpoint, parameter, or module. Link it to a parent to build the surface tree (domain → subdomain → endpoint → parameter).",
  {
    id: z
      .string()
      .describe(
        "Stable id. Use the hub's conventions so it merges with observed traffic: 'domain:<apex>', 'host:<hostname>', 'endpoint:<hostname><route>' (e.g. 'endpoint:api.example.test/v1/users/:id'), 'param:<hostname><route>?<name>'",
      ),
    label: z.string(),
    kind: z.enum(["root", "category", "leaf"]).default("leaf"),
    status: z.enum(["unexplored", "active", "complete"]).default("active"),
    parentId: z.string().optional(),
    category: z.string().optional(),
    importance: z.number().int().min(1).max(5).optional(),
    note: z.string().optional().describe("Why this matters; shown in the thought stream"),
  },
  async ({ note, importance, ...node }) => {
    const events: Payload[] = [
      { type: "node.upsert", node: { ...node, importance: importance as 1 | 2 | 3 | 4 | 5 | undefined } },
    ];
    if (note) events.push({ type: "thought", text: note, reason: `node ${node.id}` });
    await post(events);
    return ok(`mapped ${node.id}`);
  },
);

server.tool(
  "link_nodes",
  "Draw a labelled relationship between two targets on the map (for example an endpoint → a parameter it reflects, or a subdomain → a login it exposes).",
  { source: z.string(), target: z.string(), label: z.string().optional() },
  async ({ source, target, label }) => {
    await post([{ type: "edge.upsert", edge: { id: `${source}=>${target}`, source, target, label } }]);
    return ok(`linked ${source} → ${target}`);
  },
);

server.tool(
  "update_chain",
  "Add a step to an attack chain: how smaller observations connect into a vulnerability. Use `after` to point arrows from earlier steps.",
  {
    chainId: z.string().default("main"),
    id: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    nodeIds: z.array(z.string()).optional(),
    after: z.array(z.string()).optional(),
    confirmed: z.boolean().optional(),
  },
  async (step) => {
    await post([{ type: "chain.step", step }]);
    return ok(`chain ${step.chainId}: ${step.id}`);
  },
);

server.tool(
  "report_finding",
  "Report or update a suspected vulnerability on an in-scope target. Link the attack-chain steps and targets that support it so a reviewer can check the evidence.",
  {
    id: z.string().describe("Stable id; reuse it to update the same finding"),
    title: z.string(),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    confidence: z.number().min(0).max(1).describe("Your confidence the finding is real, 0–1"),
    status: z.enum(["suspected", "confirmed", "dismissed", "fixed"]).default("suspected"),
    description: z.string().optional().describe("What is wrong, why it matters, and how to fix it"),
    file: z.string().optional(),
    line: z.number().int().optional(),
    nodeIds: z.array(z.string()).optional(),
    stepIds: z.array(z.string()).optional().describe("Chain step ids that led here, in order"),
  },
  async ({ file, line, ...f }) => {
    await post([{ type: "finding.upsert", finding: { ...f, location: file ? { file, line } : undefined } }]);
    return ok(`finding ${f.id} recorded`);
  },
);

// Deliberately no scope tool: the scope is set by the operator, never by the agent.

server.tool(
  "log_thought",
  "Explain to the operator why you are changing direction or what you are about to probe next.",
  { text: z.string(), reason: z.string().optional() },
  async ({ text, reason }) => {
    await post([{ type: "thought", text, reason }]);
    return ok("noted");
  },
);

await server.connect(new StdioServerTransport());
console.error(`[spectra-mcp] ready, forwarding to ${HUB}`);
