import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { profile, control } from "../profiles/config.ts";
import { assertRunning, processStart, reportStatus, running } from "../runtime/runtime.ts";
import { contracts, type Tool } from "../browser/upstream.ts";
import { allowedBrowserTools } from "./tool-policy.ts";
import { STELZ_VERSION } from "../versions.ts";

// Accept cached legacy tool calls while advertising only the current names.
const legacyTools = new Map(["status", "acquire", "release", "pause", "resume", "recheck"]
  .map(action => [`identity_${action}`, `profile_${action}`]));

export async function runMcp(id: string) {
  if (!id) throw Error("Select a profile: stelz mcp --profile ID");
  const p = profile(id), controllerId = crypto.randomUUID();
  const serviceProfile = () => {
    const record = running(id);
    if (!record?.port || !record.serverPid || !record.serverStart || processStart(record.serverPid) !== record.serverStart) {
      throw Error(`${id}: server ownership is unavailable. Run stelz doctor ${id}.`);
    }
    return { ...p, port: record.port };
  };
  const upstream = await contracts();
  const browserTools = allowedBrowserTools(upstream.TOOL_DEFS);
  const local = (name: string, description: string): Tool => ({ name, description, inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  const tools: Tool[] = [
    local("profile_status", "Read the selected profile and controller status. This tool does not start a browser."),
    local("profile_acquire", "Acquire exclusive control of the selected running profile. Start the browser with the standalone CLI first."),
    local("profile_release", "Release control after current actions finish. Keep the same browser, pages, storage, and fingerprint configuration."),
    local("profile_pause", "Pause browser actions for manual work in the same window. Keep the current controller."),
    local("profile_resume", "Resume browser actions after manual work. Read a fresh snapshot before the next action."),
    local("profile_recheck", "Check the browser exit IP again after a verification failure."),
    ...browserTools,
  ];
  let acquired = false, closing: Promise<void> | undefined;
  const server = new Server({ name: "stelz", version: STELZ_VERSION }, {
    capabilities: { tools: {} },
    instructions: `This connection selects profile ${id}. Acquire control before browser actions. Read fresh snapshots. Pause for authentication. Release control for handoff. Disconnect does not stop the browser or transfer conversation history.`,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name: requestedName, arguments: args = {} } = request.params;
    const name = legacyTools.get(requestedName) ?? requestedName;
    try {
      if (!tools.some(t => t.name === name)) throw Error("Unknown tool.");
      let result: unknown;
      if (name === "profile_status") result = await reportStatus(id);
      else if (name === "profile_acquire") {
        assertRunning(id);
        result = await control(serviceProfile(), "POST", "acquire", { id: controllerId, pid: process.pid, label: server.getClientVersion()?.name || "MCP client" });
        acquired = true;
      } else if (name === "profile_release") {
        result = await control(serviceProfile(), "POST", "release", { controllerId }); acquired = false;
      } else {
        if (!acquired) throw Error("Call profile_acquire before browser actions.");
        assertRunning(id);
        if (name === "profile_pause" || name === "profile_resume" || name === "profile_recheck") {
          const action = name === "profile_pause" ? "pause" : name === "profile_resume" ? "resume" : "check";
          result = await control(serviceProfile(), "POST", action, { controllerId });
        }
        else return await control(serviceProfile(), "POST", "tool", { controllerId, name, args }) as { content: Awaited<ReturnType<typeof upstream.adaptResponse>> };
      }
      if (legacyTools.has(requestedName) && result && typeof result === "object" && "profileId" in result)
        result = { ...result, identityId: result.profileId };
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (e) { return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] }; }
  });
  const detach = () => closing ||= (async () => {
    if (acquired) {
      try { await control(serviceProfile(), "POST", "release", { controllerId }); } catch {}
      acquired = false;
    }
  })();
  server.onclose = () => { void detach().finally(() => process.exit(0)); };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { void detach().finally(() => server.close()).finally(() => process.exit(0)); });
  await server.connect(new StdioServerTransport());
}
