import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { settings, profile, base, dir } from "./config.ts";
import { acquire, release, intervention, withBrowser, status, key } from "./runtime.ts";
import { contracts, type Tool } from "./upstream.ts";
import { join } from "node:path";

const index = process.argv.indexOf("--profile");
const assigned = index < 0 ? undefined : process.argv[index + 1];
if (assigned) profile(assigned);
const upstream = await contracts();
const browserTools = upstream.TOOL_DEFS.filter(t => !["camofox_evaluate", "camofox_import_cookies"].includes(t.name));
const profileProperty = assigned ? {} : { profileId: { type: "string", description: "Only the profile assigned to this worker" } };
const requiredProfile = assigned ? [] : ["profileId"];
const lease = { leaseToken: { type: "string", description: "Exclusive token returned by profile_acquire; never reuse another worker's token" } };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[]): Tool {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}
const tools: Tool[] = [
  definition("profiles_list", "List configured profiles, network mode, and runtime status. Does not launch a browser.", {}, []),
  definition("profile_acquire", "Acquire the assigned profile exclusively and start its visible Camofox browser if stopped. Never launch browser processes yourself. Missing proxy credentials fail closed.", { ...profileProperty, owner: { type: "string", description: "Worker/task identifier" } }, [...requiredProfile, "owner"]),
  definition("profile_release", "Release this worker's profile after the task; cleanly stop by default, preserving storage and fingerprint. Set stopBrowser=false only when asked to leave the window open.", { ...profileProperty, ...lease, stopBrowser: { type: "boolean", default: true } }, [...requiredProfile, "leaseToken"]),
  definition("profile_pause", "Pause agent browser actions for authentication or manual intervention in the same window. Keep the lease; tell the orchestrator that human action is required.", { ...profileProperty, ...lease }, [...requiredProfile, "leaseToken"]),
  definition("profile_resume", "Resume a paused profile after the human reports completion; verify the browser exit IP again, then take a fresh snapshot before acting.", { ...profileProperty, ...lease }, [...requiredProfile, "leaseToken"]),
  ...browserTools.map(t => ({ ...t, description: `For the assigned, exclusively leased profile. Use fresh observations. ${t.description.replace(/PREFERRED: /, "").replace(/they bypass bot detection on Google, Amazon, LinkedIn, etc\./, "use the visible assigned browser.")}`, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, ...profileProperty, ...lease }, required: [...(t.inputSchema.required || []), ...requiredProfile, "leaseToken"], additionalProperties: false } })),
];
const server = new Server({ name: "stelz-camofox", version: "0.1.0" }, {
  capabilities: { tools: {} },
  instructions: "Each browser worker must acquire only its assigned profile, retain its lease token, use fresh snapshots, pause for authentication, and release after verification. Codex owns reasoning and delegation; this server only manages profile lifecycle and forwards upstream browser tools. Parallelism is limited by maxActive; no automatic queue exists.",
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: raw = {} } = request.params;
  try {
    if (!tools.some(t => t.name === name)) throw Error("Unknown tool");
    if (name === "profiles_list") return { content: [{ type: "text", text: JSON.stringify(settings().profiles.filter(p => !assigned || p.id === assigned).map(p => status(p.id))) }] };
    const id = assigned || String(raw.profileId || "");
    if (assigned && raw.profileId && raw.profileId !== assigned) throw Error("This MCP session is assigned to a different profile");
    profile(id);
    let result: unknown;
    if (name === "profile_acquire") {
      if (typeof raw.owner !== "string" || !raw.owner.trim()) throw Error("owner is required");
      result = await acquire(id, raw.owner);
    } else if (name === "profile_release") result = await release(id, String(raw.leaseToken), raw.stopBrowser !== false);
    else if (name === "profile_pause" || name === "profile_resume") {
      const { assertLease } = await import("./runtime.ts"); assertLease(id, String(raw.leaseToken));
      result = await intervention(id, name === "profile_pause" ? "pause" : "resume");
    } else {
      return await withBrowser(id, String(raw.leaseToken), async p => {
        const args = { ...raw }; delete args.profileId; delete args.leaseToken;
        const { spec, payload } = await upstream.runTool(name, args, { userId: id, sessionKey: "default" }, base(p), { accessKey: key(id), apiKey: key(id), cookiesDir: join(dir(id), "cookies") });
        return { content: upstream.adaptResponse(spec, payload) };
      });
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: (e as Error).message.replace(/(https?|socks5):\/\/[^\s/@]+:[^\s/@]+@/g, "$1://[redacted]@") }] };
  }
});
await server.connect(new StdioServerTransport());
