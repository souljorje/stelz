import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { profile, control } from "./config.ts";
import { assertRunning, running, status } from "./runtime.ts";
import { contracts, type Tool } from "./upstream.ts";

export async function runMcp(id: string) {
  if (!id) throw Error("Select an identity: stelz mcp --identity ID");
  const p = profile(id), controllerId = crypto.randomUUID();
  const upstream = await contracts();
  const browserTools = upstream.TOOL_DEFS.filter(t => !["camofox_evaluate", "camofox_import_cookies"].includes(t.name));
  const local = (name: string, description: string): Tool => ({ name, description, inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  const tools: Tool[] = [
    local("identity_status", "Read the selected identity and controller status. This tool does not start a browser."),
    local("identity_acquire", "Acquire exclusive control of the selected running identity. Start the browser with the standalone CLI first."),
    local("identity_release", "Release control after current actions finish. Keep the same browser, pages, storage, and fingerprint configuration."),
    local("identity_pause", "Pause browser actions for manual work in the same window. Keep the current controller."),
    local("identity_resume", "Resume browser actions after manual work. Read a fresh snapshot before the next action."),
    ...browserTools,
  ];
  let acquired = false, closing: Promise<void> | undefined;
  const server = new Server({ name: "stelz", version: "0.2.0" }, {
    capabilities: { tools: {} },
    instructions: `This connection selects identity ${id}. Acquire control before browser actions. Read fresh snapshots. Pause for authentication. Release control for handoff. Disconnect does not stop the browser or transfer conversation history.`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (!tools.some(t => t.name === name)) throw Error("Unknown tool.");
      let result: unknown;
      if (name === "identity_status") result = running(id) ? await control(p, "GET", "status") : status(id);
      else if (name === "identity_acquire") {
        assertRunning(id);
        result = await control(p, "POST", "acquire", { id: controllerId, pid: process.pid, label: server.getClientVersion()?.name || "MCP client" });
        acquired = true;
      } else if (name === "identity_release") {
        result = await control(p, "POST", "release", { controllerId }); acquired = false;
      } else {
        if (!acquired) throw Error("Call identity_acquire before browser actions.");
        assertRunning(id);
        if (name === "identity_pause" || name === "identity_resume") result = await control(p, "POST", name === "identity_pause" ? "pause" : "resume", { controllerId });
        else return await control(p, "POST", "tool", { controllerId, name, args }) as { content: Awaited<ReturnType<typeof upstream.adaptResponse>> };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
  });
  const detach = () => closing ||= (async () => {
    if (acquired) { await control(p, "POST", "release", { controllerId }).catch(() => {}); acquired = false; }
  })();
  server.onclose = () => { void detach().finally(() => process.exit(0)); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void detach().finally(() => server.close()).finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
