import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { settings } from "../profiles/config.ts";
import { ensureProfile } from "../profiles/profile-configuration.ts";
import { runLifecycle } from "../runtime/operations.ts";
import { reportStatus } from "../runtime/runtime.ts";
import { contracts, type Tool } from "../browser/upstream.ts";
import { allowedBrowserTools, browserToolArguments } from "./tool-policy.ts";
import { createControlRegistry } from "./control-registry.ts";
import { serviceTransport } from "./service-binding.ts";
import { STELZ_VERSION } from "../versions.ts";
import { LocationError } from "../browser/location.ts";

const profileProperty = { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$", description: "Profile ID from profile_list or profile_create." };
const handleProperty = { type: "string", minLength: 1, description: "Opaque controlHandle returned by profile_acquire on this connection for this profile and browser lifetime." };

// Never expose internal controller IDs through status or list responses.
function publicStatus(value: Record<string, unknown>) {
  const { controlHandle: _handle, controllerId: _id, accessKey: _key, ...result } = value;
  if (result.controller && typeof result.controller === "object") {
    const { pid, label, activeActions, releasing } = result.controller as Record<string, unknown>;
    result.controller = { pid, label, activeActions, releasing };
  }
  return result;
}
function local(name: string, description: string, owned = false): Tool {
  const properties = name === "profile_list" ? {} : { profileId: profileProperty, ...(owned ? { controlHandle: handleProperty } : {}) };
  return { name, description, inputSchema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } };
}
export function routedTools(browserTools: Tool[]): Tool[] {
  return [
    local("profile_list", "List current profiles and their statuses. This tool does not acquire control or start browsers."),
    local("profile_create", "Create a direct native profile, or reuse an existing profile without changing its configuration. This tool does not start a browser."),
    local("profile_start", "Explicitly start this profile through the browser service. Repeated starts preserve the existing browser."),
    local("profile_status", "Read this profile and controller status without acquiring control or starting a browser."),
    local("profile_acquire", "Acquire exclusive control of a running profile. Save the returned controlHandle for all owned operations. An existing or pending controller cannot acquire again."),
    local("profile_release", "Block new operations, finish admitted work, and release this handle. Preserve the browser, pages, storage, and fingerprint configuration.", true),
    local("profile_pause", "Pause actions immediately, then wait for admitted work to finish before human work in the same window. Keep this controller.", true),
    local("profile_resume", "Resume after human work. Read a fresh snapshot before the next action.", true),
    local("profile_recheck", "Check the browser exit IP after a verification failure.", true),
    ...browserTools.map(tool => ({ ...tool, inputSchema: { ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, profileId: profileProperty, controlHandle: handleProperty },
      required: [...new Set([...(tool.inputSchema.required || []), "profileId", "controlHandle"])], additionalProperties: false } })),
  ];
}
export function routedArguments(tool: Tool, args: Record<string, unknown>) {
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties || {}, key)))
    throw Error("Unknown tool argument. Internal routing and controller fields are not accepted.");
  for (const key of tool.inputSchema.required || []) if (!Object.hasOwn(args, key)) throw Error(`Missing required argument: ${key}.`);
  if (tool.name !== "profile_list" && (typeof args.profileId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(args.profileId)))
    throw Error("profileId must be a valid profile ID.");
  if ("controlHandle" in (tool.inputSchema.properties || {}) && (typeof args.controlHandle !== "string" || !args.controlHandle))
    throw Error("controlHandle must be the value returned by profile_acquire.");
  const { profileId, controlHandle, ...canonical } = args;
  return { profileId: profileId as string, controlHandle: controlHandle as string, canonical };
}

export async function runMcp() {
  settings(); // An initialized empty catalog is valid.
  const upstream = await contracts();
  const browserTools = allowedBrowserTools(upstream.TOOL_DEFS);
  const tools = routedTools(browserTools);
  const registry = createControlRegistry(serviceTransport);
  const requests = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined, shuttingDown = false;
  const server = new Server({ name: "stelz", version: STELZ_VERSION }, {
    capabilities: { tools: {} },
    instructions: "Register Stelz once. Discover profiles with profile_list; create and start them explicitly. Every owned operation requires the profileId and controlHandle from this connection's profile_acquire. One profile has one browser and one controller. You may control multiple profiles in parallel. Read fresh snapshots. Pause for human authentication in the same window. Release each handle for handoff. Disconnect preserves browsers and pages. Never repeat an uncertain browser action automatically.",
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const work = (async () => {
      const { name, arguments: args = {} } = request.params;
      try {
        if (shuttingDown) throw Error("This MCP connection is closing.");
        extra.signal.throwIfAborted();
        const tool = tools.find(tool => tool.name === name);
        if (!tool) throw Error("Unknown tool.");
        const { profileId, controlHandle, canonical } = routedArguments(tool, args);
        let result: Record<string, unknown>;
        if (name === "profile_list") {
          result = { profiles: await Promise.all(settings().profiles.map(async profile => {
            try { return publicStatus(await reportStatus(profile.id)); }
            catch (error) { return { profileId: profile.id, phase: "unavailable", error: (error as Error).message }; }
          })) };
        } else if (name === "profile_create") {
          const created = await ensureProfile({ id: profileId });
          result = { profileId, created: created.created, ...publicStatus(await reportStatus(profileId)) };
        } else if (name === "profile_start") result = publicStatus(await runLifecycle("start", profileId, extra.signal));
        else if (name === "profile_status") result = publicStatus(await reportStatus(profileId));
        else if (name === "profile_acquire") {
          const acquired = await registry.acquire(profileId, server.getClientVersion()?.name || "MCP client", extra.signal);
          result = { ...publicStatus(acquired), controlHandle: acquired.controlHandle };
        } else if (name === "profile_release") result = await registry.release(profileId, controlHandle);
        else if (["profile_pause", "profile_resume", "profile_recheck"].includes(name))
          result = publicStatus(await registry.run(profileId, controlHandle, name === "profile_recheck" ? "check" : name.slice("profile_".length)));
        else {
          const browserTool = browserTools.find(tool => tool.name === name)!;
          return await registry.run(profileId, controlHandle, "tool", { name, args: browserToolArguments(browserTool, canonical) }) as { content: ReturnType<typeof upstream.adaptResponse> };
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof LocationError ? JSON.stringify({ error: { code: error.location.code, message: error.message }, location: error.location }) : (error as Error).message }] }; }
    })();
    requests.add(work);
    return work.finally(() => { requests.delete(work); });
  });
  const detach = () => {
    shuttingDown = true;
    return closing ||= (async () => {
      try { await registry.close(); }
      catch (error) { console.error((error as Error).message); }
      await Promise.allSettled([...requests]);
    })();
  };
  const shutdown = () => { void detach().finally(() => server.close()).finally(() => process.exit(0)); };
  server.onclose = () => { void detach().finally(() => process.exit(0)); };
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, shutdown);
  await server.connect(new StdioServerTransport());
}
