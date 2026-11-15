import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { settings } from "../profiles/config.ts";
import type { ToolResult } from "../browser/catalog.ts";
import { loadContracts } from "./contracts.ts";
import { createDispatch } from "./dispatch.ts";
import { createControlRegistry } from "./control-registry.ts";
import { withProgress } from "./progress.ts";
import { serviceTransport } from "./service-binding.ts";
import { STELZ_VERSION } from "../versions.ts";
import { LocationError } from "../browser/location.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function formatPayload(kind: ToolResult["kind"], payload: unknown): Content[] {
  if (kind === "image") return [payload as Content];
  const value = (payload ?? {}) as { url?: unknown; snapshot?: unknown; refsCount?: unknown; truncated?: unknown; nextOffset?: unknown; viewId?: unknown;
    baseline?: unknown; structure?: unknown; screenshot?: { data?: string; mimeType?: string } };
  if (kind === "snapshot" && typeof value.snapshot === "string") {
    // One header line, then the page text as it is. JSON would escape every line break.
    const { url, refsCount, truncated, nextOffset, viewId, baseline, structure } = value;
    const header = JSON.stringify({ url, refsCount, truncated, ...(nextOffset === null || nextOffset === undefined ? {} : { nextOffset }), viewId,
      ...(baseline === true ? { baseline } : {}) });
    // The structure of forms and tables follows the page text as compact JSON, after a comment line.
    const tail = structure === undefined || structure === null ? "" : `\n# structure\n${JSON.stringify(structure)}`;
    return [{ type: "text", text: `${header}\n${value.snapshot}${tail}` },
      ...(value.screenshot?.data ? [{ type: "image" as const, data: value.screenshot.data, mimeType: value.screenshot.mimeType || "image/png" }] : [])];
  }
  return [{ type: "text", text: JSON.stringify(payload) }];
}

/**
 * Turn a raw tool result into MCP content. This is the only place that formats results.
 * An action with an observation is one text block: the compact action result, then the page as a snapshot reply, or a note that the read of the page failed.
 */
export function formatResult({ kind, payload, observation }: ToolResult): Content[] {
  const content = formatPayload(kind, payload), [action] = content;
  if (!observation || action?.type !== "text") return content;
  const [page, ...images] = "error" in observation ? [{ type: "text" as const, text: `# ${observation.error}` }] : formatPayload(observation.kind, observation.payload);
  return [{ type: "text", text: `${action.text}\n${page?.type === "text" ? page.text : ""}` }, ...images];
}

export async function runMcp(options: { tools?: string } = {}) {
  settings(); // An initialized empty catalog is valid.
  const registry = createControlRegistry(serviceTransport);
  const requests = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined, shuttingDown = false;
  const server = new Server({ name: "stelz", version: STELZ_VERSION }, {
    capabilities: { tools: {} },
    instructions: "Register Stelz once. Discover profiles with profile_list; create and start them explicitly. Every owned operation requires the profileId and controlHandle from this connection's profile_acquire. One profile has one browser and one controller. You may control multiple profiles in parallel. Read fresh snapshots. Pause for human authentication in the same window. Release each handle for handoff. Disconnect preserves browsers and pages. Never repeat an uncertain browser action automatically.",
  });
  // The tool list stays fixed for the connection. A bad `--tools` name fails here, before the server connects.
  const dispatch = createDispatch({ defs: (await loadContracts()).TOOL_DEFS, registry, tools: options.tools,
    label: () => server.getClientVersion()?.name || "MCP client" });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: dispatch.tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const work = withProgress(extra, `Stelz is still running ${request.params.name}.`, (async () => {
      const { name, arguments: args = {} } = request.params;
      try {
        if (shuttingDown) throw Error("This MCP connection is closing.");
        extra.signal.throwIfAborted();
        return { content: formatResult(await dispatch.call(name, args, extra.signal)) };
      } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof LocationError ? JSON.stringify({ error: { code: error.location.code, message: error.message }, location: error.location }) : (error as Error).message }] }; }
    })());
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
