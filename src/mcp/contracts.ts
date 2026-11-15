import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Contracts } from "../browser/catalog.ts";
import { upstream } from "../profiles/config.ts";

/** The upstream tool contracts of the prepared runtime. The MCP server and the SDK pass its `TOOL_DEFS` to `createDispatch`. */
export const loadContracts = () => import(pathToFileURL(join(upstream(), "mcp/lib/tool-contracts.mjs")).href) as Promise<Contracts>;
