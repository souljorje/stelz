import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { UPSTREAM } from "./config.ts";
export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type Tool = { name: string; description: string; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown } };
type Contracts = {
  TOOL_DEFS: Tool[];
  runTool(name: string, args: Record<string, unknown>, context: { userId: string; sessionKey: string }, url: string, config: Record<string, unknown>): Promise<{ spec: unknown; payload: unknown }>;
  adaptResponse(spec: unknown, payload: unknown): Content[];
};
export async function contracts(): Promise<Contracts> {
  return import(pathToFileURL(join(UPSTREAM, "mcp/lib/tool-contracts.mjs")).href);
}
