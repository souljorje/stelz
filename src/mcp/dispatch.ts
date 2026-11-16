import { HOME_DIR, settings } from "../profiles/config.ts";
import { ensureProfile } from "../profiles/profile-configuration.ts";
import { anyProfileAllowsScripts, assertScriptsAllowed } from "../profiles/allow-scripts.ts";
import { runLifecycle } from "../runtime/operations.ts";
import { reportStatus } from "../runtime/runtime.ts";
import { browserTools, toolArguments, type Tool, type ToolResult } from "../browser/catalog.ts";
import type { createControlRegistry } from "./control-registry.ts";

// Argument checks and routing for every Stelz tool. The MCP server and the SDK both call it.
// It returns raw payloads. Only mcp.ts turns them into text and images.
const profileProperty = { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$", description: "Profile ID from profile_list or profile_create." };
const handleProperty = { type: "string", minLength: 1, description: "Opaque controlHandle returned by profile_acquire on this connection for this profile and browser lifetime." };
const profileId = /^[a-z][a-z0-9-]{0,63}$/;

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
/** The nine profile tools. They are in every group. */
export const profileTools: Tool[] = [
  local("profile_list", "List current profiles and their statuses. This tool does not acquire control or start browsers."),
  local("profile_create", "Create a direct native profile, or reuse an existing profile without changing its configuration. This tool does not start a browser."),
  local("profile_start", "Explicitly start this profile through the browser service. Repeated starts preserve the existing browser."),
  local("profile_status", "Read this profile and controller status without acquiring control or starting a browser."),
  local("profile_acquire", "Acquire exclusive control of a running profile. Save the returned controlHandle for all owned operations. An existing or pending controller cannot acquire again."),
  local("profile_release", "Block new operations, finish admitted work, and release this handle. Preserve the browser, pages, storage, and fingerprint configuration.", true),
  local("profile_pause", "Pause actions immediately, then wait for admitted work to finish before human work in the same window. Keep this controller.", true),
  local("profile_resume", "Resume after human work. Read a fresh snapshot before the next action.", true),
  local("profile_recheck", "Check the browser exit IP after a verification failure.", true),
];

// Every owned tool takes profileId and controlHandle.
function owned(tool: Tool): Tool {
  return { ...tool, inputSchema: { ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties, profileId: profileProperty, controlHandle: handleProperty },
    required: [...new Set([...(tool.inputSchema.required || []), "profileId", "controlHandle"])], additionalProperties: false } };
}
function routedArguments(tool: Tool, args: Record<string, unknown>) {
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties || {}, key)))
    throw Error("Unknown tool argument. Internal routing and controller fields are not accepted.");
  for (const key of tool.inputSchema.required || []) if (!Object.hasOwn(args, key)) throw Error(`Missing required argument: ${key}.`);
  if (tool.name !== "profile_list" && (typeof args.profileId !== "string" || !profileId.test(args.profileId)))
    throw Error("profileId must be a valid profile ID.");
  if ("controlHandle" in (tool.inputSchema.properties || {}) && (typeof args.controlHandle !== "string" || !args.controlHandle))
    throw Error("controlHandle must be the value returned by profile_acquire.");
  const { profileId: id, controlHandle, ...canonical } = args;
  return { profileId: id as string, controlHandle: controlHandle as string, canonical };
}

/**
 * Choose the tools of one connection. `selection` is the `--tools` value: `core`, `full`, tool names, or a comma-separated mix.
 * A scripts tool is listed only if the selection names it and a profile allows scripts. A bad name fails at startup.
 */
function selectTools(selection: string, all: readonly { tool: Tool; group: "core" | "full"; scripts: boolean }[], scriptsAllowed: boolean): Tool[] {
  const chosen = new Set<string>();
  for (const token of selection.split(",").map(item => item.trim())) {
    if (token === "core" || token === "full") all.filter(item => token === "full" || item.group === "core").forEach(item => chosen.add(item.tool.name));
    else if (all.some(item => item.tool.name === token)) chosen.add(token);
    else throw Error(`Unknown tool in --tools: "${token}". Use core, full, or names of listed tools.`);
  }
  return all.filter(item => chosen.has(item.tool.name) && (scriptsAllowed || !item.scripts)).map(item => item.tool);
}

type Registry = Pick<ReturnType<typeof createControlRegistry>, "acquire" | "run" | "release">;
export type DispatchOptions = {
  defs: readonly Tool[];
  registry: Registry;
  /** The `--tools` value. The default is `core`. */
  tools?: string;
  /** The label that profile_acquire shows to people. */
  label?: () => string;
  /** The service data directory. The default is STELZ_HOME. */
  home?: string;
};
export type Dispatch = { tools: Tool[]; call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> };

export function createDispatch(options: DispatchOptions): Dispatch {
  const { registry, home = HOME_DIR } = options;
  const browser = browserTools(options.defs);
  const tools = selectTools(options.tools ?? "core", [
    ...profileTools.map(tool => ({ tool, group: "core" as const, scripts: false })),
    ...[...browser.values()].map(({ entry, tool }) => ({ tool: owned(tool), group: entry.group, scripts: entry.policy === "scripts" })),
  ], anyProfileAllowsScripts(home));
  const listed = new Map(tools.map(tool => [tool.name, tool]));
  const json = (payload: unknown): ToolResult => ({ kind: "json", payload });

  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const tool = listed.get(name);
    if (!tool) throw Error("Unknown tool.");
    const { profileId: id, controlHandle, canonical } = routedArguments(tool, args);
    if (name === "profile_list") {
      return json({ profiles: await Promise.all(settings().profiles.map(async profile => {
        try { return publicStatus(await reportStatus(profile.id)); }
        catch (error) { return { profileId: profile.id, phase: "unavailable", error: (error as Error).message }; }
      })) });
    }
    if (name === "profile_create") {
      const created = await ensureProfile({ id });
      return json({ profileId: id, created: created.created, ...publicStatus(await reportStatus(id)) });
    }
    if (name === "profile_start") return json(publicStatus(await runLifecycle("start", id, signal)));
    if (name === "profile_status") return json(publicStatus(await reportStatus(id)));
    if (name === "profile_acquire") {
      const acquired = await registry.acquire(id, options.label?.() || "MCP client", signal);
      return json({ ...publicStatus(acquired), controlHandle: acquired.controlHandle });
    }
    if (name === "profile_release") return json(await registry.release(id, controlHandle));
    if (["profile_pause", "profile_resume", "profile_recheck"].includes(name))
      return json(publicStatus(await registry.run(id, controlHandle, name === "profile_recheck" ? "check" : name.slice("profile_".length))));
    const { entry, tool: exposed } = browser.get(name)!;
    const toolArgs = toolArguments(exposed, canonical);
    // The service checks the switch again on each call. This check refuses the call before it enters the queue.
    if (entry.policy === "scripts") assertScriptsAllowed(home, id, name);
    return await registry.run(id, controlHandle, "tool", { name, args: toolArgs }) as ToolResult;
  }
  return { tools, call };
}
