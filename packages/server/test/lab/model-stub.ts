// A local stand-in for the Anthropic Messages API, so the Navigator and the Interpreter can be
// tested with no API key and nothing leaving the machine. It accepts only the test key.
// Interpreter requests get an answer that is partly right, partly invented, partly out of scope
// and partly obeying text planted in the output — so what is tested is the hub's own checks.
import http from "node:http";

export const TEST_KEY = "sk-ant-test-local-only";

export interface ModelStub {
  url: string;
  /** How many requests carried the right key. */
  calls(): number;
  /** The text of every Interpreter request, exactly as the hub sent it. */
  prompts: string[];
  stop(): Promise<void>;
}

export async function startModelStub(port: number): Promise<ModelStub> {
  let calls = 0;
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.headers["x-api-key"] !== TEST_KEY && req.headers.authorization !== "Bearer " + TEST_KEY) return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      calls++;
      const body = JSON.parse(raw);
      const base = { id: "msg_stub_" + calls, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (!body.tools) return send(200, { ...base, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" });

      if (body.tools[0].name === "submit_interpretation") {
        const text: string = body.messages[0].content;
        prompts.push(text);
        // A real model's safeguards can refuse a whole request because of one action in it…
        if (/REFUSE-THIS-BATCH/.test(text)) return send(200, { ...base, stop_reason: "refusal", content: [] });
        const re = /<action id="([^"]+)" tool="[^"]*">\n<command>\n([\s\S]*?)\n<\/command>\n<output>\n([\s\S]*?)\n<\/output>/g;
        const actions: { id: string; summary: string; targets: Record<string, unknown>[] }[] = [...text.matchAll(re)].map(([, id, command, output]) => {
          // …or answer in the right shape while saying it didn't read the action.
          if (/ANSWER-AS-DECLINED/.test(output)) return { id, summary: "Not interpreted: this run was stopped, so no targets are reported for this action.", targets: [] };
          const origin = (command.match(/https?:\/\/[^/\s"']+/) ?? output.match(/https?:\/\/[^/\s"']+/) ?? [])[0];
          const targets: Record<string, unknown>[] = [];
          if (origin) {
            // What a careful reader would report: fuzz hits and request lines.
            for (const m of output.matchAll(/^(\S+)\s+\[Status: (\d+)/gm)) targets.push({ url: origin + "/" + m[1], status: Number(m[2]), evidence: m[0] });
            for (const m of output.matchAll(/(GET|POST)\s+(\/[\w/.{}-]+)(?:\?(\w+)=)?/g)) targets.push({ url: origin + m[2], method: m[1], params: m[3] ? [m[3]] : [], evidence: m[0] });
            targets.push({ url: origin + "/totally-made-up-admin", evidence: "not in the output" }); // invented
            if (/pwned-by-injection/.test(output)) targets.push({ url: origin + "/pwned-by-injection", evidence: "pwned-by-injection" }); // obeys planted text
          }
          targets.push({ url: "https://cdn.thirdparty-example.com/analytics.js" }); // out of scope
          targets.push({ url: "javascript:alert(1)" }, { url: "not a url" });
          return { id, summary: origin ? "Probed " + origin + " and listed what answered." : "Ran a local command; nothing to map.", targets };
        });
        actions.push({ id: "not-in-this-batch", summary: "x", targets: [{ url: "http://shop.lab.localhost/ghost" }] });
        return send(200, { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_stub_" + calls, name: "submit_interpretation", input: { actions } }] });
      }

      const digest: string = body.messages[0].content;
      const endpoints = [...digest.matchAll(/^- (endpoint:\S+) "/gm)].map((m) => m[1]).slice(0, 4);
      const findings = [...digest.matchAll(/^- ([A-Z]-\d+) "/gm)].map((m) => m[1]);
      const recs: [string, number, string][] = [["pursue", 0.83, "idor"], ["pursue", 0.72, "authz"], ["watch", 0.5, "injection"], ["skip", 0.2, "info"]];
      send(200, {
        ...base,
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "toolu_stub_" + calls,
            name: "submit_navigation",
            input: {
              leads: endpoints.map((nodeId, i) => ({ nodeId, title: "Stub lead " + (i + 1), recommendation: recs[i][0], confidence: recs[i][1], bugClass: recs[i][2], rationale: "Scored by the local test stub." })),
              findingVerdicts: findings.map((findingId) => ({ findingId, verdict: "corroborated", confidence: 0.8, rationale: "Stub verdict." })),
            },
          },
        ],
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    prompts,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
