import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const profileTools = new Set(["profile_create", "profile_start", "profile_status", "profile_acquire"]);
const controlTools = new Set(["profile_release", "profile_pause", "profile_resume", "profile_recheck"]);

export function requiresControl(name: string): boolean {
  return controlTools.has(name) || name.startsWith("camofox_");
}

/** Add explicit routing to fixture calls. Every acquire request still reaches the server. */
export function routeProfileTools(client: Client, defaultProfileId?: string): Client {
  const handles = new Map<string, string>();
  const callTool = client.callTool.bind(client), close = client.close.bind(client);
  client.callTool = async (request, schema, options) => {
    const { name } = request;
    const args = { ...request.arguments };
    if (profileTools.has(name) || requiresControl(name)) {
      if (!Object.hasOwn(args, "profileId") && defaultProfileId !== undefined) args.profileId = defaultProfileId;
      if (requiresControl(name) && !Object.hasOwn(args, "controlHandle") && typeof args.profileId === "string") {
        const handle = handles.get(args.profileId);
        if (handle !== undefined) args.controlHandle = handle;
      }
    }
    const result = await callTool({ ...request, arguments: args }, schema, options);
    if (!result.isError && typeof args.profileId === "string") {
      if (name === "profile_acquire") {
        const content = result.content as Array<{ type: string; text?: string }>;
        const status = JSON.parse(content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n"));
        if (typeof status.controlHandle !== "string" || !status.controlHandle) {
          throw Error("profile_acquire returned no control handle.");
        }
        handles.set(args.profileId, status.controlHandle);
      } else if (name === "profile_release" && args.controlHandle === handles.get(args.profileId)) {
        handles.delete(args.profileId);
      }
    }
    return result;
  };
  client.close = async () => {
    try { await close(); }
    finally { handles.clear(); }
  };
  return client;
}

/** Remove control handles from JSON diagnostics, including JSON inside MCP text content. */
export function redactControlHandles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactControlHandles);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, key === "controlHandle" ? "[redacted]" : redactControlHandles(entry)]));
  if (typeof value === "string") {
    try { return JSON.stringify(redactControlHandles(JSON.parse(value))); } catch {}
  }
  return value;
}
