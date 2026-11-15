import { isTypingMode, TYPING_MODES } from "./typing.ts";
import {
  ACTION_LIMIT_MS, EVALUATE_DEFAULT_MS, EVALUATE_MAX_MS, EVALUATE_MIN_MS, TYPING_LIMIT_MS, WAIT_DEFAULT_MS, WAIT_MAX_MS,
  evaluateLimit, waitLimit,
} from "./deadlines.ts";

export type Tool = { name: string; description: string; inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown } };
export type Contracts = {
  TOOL_DEFS: Tool[];
  TOOL_NAMES: string[];
  runTool(name: string, args: Record<string, unknown>, context: { userId: string; sessionKey: string }, url: string, config: Record<string, unknown>):
    Promise<{ spec: { responseKind?: ResultKind }; payload: unknown }>;
};
/** The shape of an upstream payload. Only the MCP server turns it into text and images. */
export type ResultKind = "json" | "snapshot" | "image";
export type ToolResult = { kind: ResultKind; payload: unknown };

// default: listed. scripts: listed only for a profile that allows scripts. held: reviewed, not listed.
// Every upstream tool that no entry names is held too. Each Camofox release adds tools and properties, so review them before you add an entry.
export type Policy = "default" | "scripts" | "held";
export type Entry = {
  /** The Stelz name. One operation has one name in every surface. */
  name: string;
  /** The upstream tool name that `runTool` receives. */
  upstream: string;
  description?: string;
  /** Upstream properties that Stelz does not expose. */
  hiddenProperties?: string[];
  /** Properties that Stelz adds or replaces. */
  extraProperties?: Record<string, unknown>;
  policy: Policy;
  /** `core` tools are in both groups. `full` tools are only in `full`. */
  group: "core" | "full";
  /** The upstream time limit for one call, in milliseconds. */
  deadline(args: Record<string, unknown>): number;
};
/** Upstream tools that Stelz never lists and never names. They write or read cookies and storage, send files, or set the viewport. */
export const excluded: readonly string[] = ["camofox_import_cookies", "camofox_import_local_storage", "camofox_export_storage_state", "camofox_upload", "camofox_viewport"];

const action = () => ACTION_LIMIT_MS;
const typingMode = { type: "string", enum: [...TYPING_MODES],
  description: "Typing mode for this call. Omit to use the profile default. Balanced uses paced input if its estimated duration is at most 10 seconds. " +
    `Longer text uses bulk entry. Keyboard uses paced input without bulk fallback, for up to ${TYPING_LIMIT_MS / 60_000} minutes. ` +
    "Text that needs longer fails before the field changes. Paced input can include corrected typos in plain text fields. Instant uses bulk entry." };
const waitTimeout = { type: "number", minimum: 0, maximum: WAIT_MAX_MS,
  description: `Maximum milliseconds to wait. Default ${WAIT_DEFAULT_MS}. Maximum ${WAIT_MAX_MS}.` };
const evaluateTimeout = { type: "integer", minimum: EVALUATE_MIN_MS, maximum: EVALUATE_MAX_MS,
  description: `Deadline in milliseconds. Default ${EVALUATE_DEFAULT_MS}. Maximum ${EVALUATE_MAX_MS}. On timeout the tab stays open and the script can still run in the page.` };
const entry = (name: string, upstream: string, group: Entry["group"], more: Partial<Entry> = {}): Entry =>
  ({ name, upstream, policy: "default", group, deadline: action, ...more });

export const entries: readonly Entry[] = [
  entry("tab_list", "camofox_list_tabs", "core"),
  entry("tab_create", "camofox_create_tab", "core", {
    description: "Open a new tab in the browser of this profile and go to a URL. Returns the tabId for later calls." }),
  entry("tab_close", "camofox_close_tab", "core"),
  entry("tab_navigate", "camofox_navigate", "core", { description: "Go to a URL in a tab, or use a search macro such as @google_search or @youtube_search." }),
  entry("tab_back", "camofox_back", "core"),
  entry("tab_snapshot", "camofox_snapshot", "core", { hiddenProperties: ["annotateScreenshot"],
    description: "Read the page of a tab as an accessibility snapshot. The first line is JSON with url, refsCount, truncated, and nextOffset. The page text follows, with element refs (e1, e2, and so on) for tab_click, tab_type, tab_select, and other tools. A screenshot comes with the snapshot. " +
      "A large page is truncated. If `truncated` is true and `nextOffset` is present, call again with that `offset` to read more." }),
  entry("tab_click", "camofox_click", "core", { hiddenProperties: ["coordinates"],
    description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector. Optionally pass expected_role and/or expected_accessible_name to assert the target is still the element you expected before the click lands." }),
  entry("tab_type", "camofox_type", "core", { extraProperties: { mode: typingMode }, deadline: () => TYPING_LIMIT_MS }),
  entry("tab_press", "camofox_press", "core"),
  entry("tab_select", "camofox_select", "core"),
  entry("tab_scroll", "camofox_scroll", "core"),
  entry("tab_screenshot", "camofox_screenshot", "core"),
  entry("tab_wait", "camofox_wait", "core", { hiddenProperties: ["dismissConsent"], extraProperties: { timeout: waitTimeout }, deadline: waitLimit,
    description: "Wait for a Camoufox page to settle before you continue. Waits up to timeout ms, and optionally until the network is idle." }),
  entry("tab_forward", "camofox_forward", "full"),
  entry("tab_refresh", "camofox_refresh", "full"),
  entry("tab_mouse_wheel", "camofox_mouse_wheel", "full"),
  entry("tab_drag", "camofox_drag", "full"),
  entry("tab_ax", "camofox_ax", "full"),
  entry("tab_actionables", "camofox_actionables", "full"),
  entry("tab_table_rows", "camofox_table_rows", "full"),
  entry("tab_links", "camofox_links", "full"),
  entry("tab_images", "camofox_images", "full"),
  entry("tab_extract", "camofox_extract", "full"),
  entry("tab_evaluate", "camofox_evaluate", "full", { policy: "scripts", extraProperties: { timeoutMs: evaluateTimeout }, deadline: evaluateLimit }),
  entry("tab_init_script", "camofox_init_script", "full", { policy: "scripts" }),
  entry("tab_activate", "camofox_activate", "full", { policy: "held" }),
];

const byName = new Map(entries.map(item => [item.name, item]));
const stelzNames = new Map(entries.map(item => [item.upstream, item.name]));
/** The upstream time limit for one call of a Stelz tool. */
export function deadline(name: string, args: Record<string, unknown>): number {
  const found = byName.get(name);
  if (!found) throw Error("Unknown browser tool.");
  return found.deadline(args);
}

// Stelz fixes the profile (userId) and the tab group (sessionKey). Upstream adds both to every schema and accepts both as arguments.
const routingProperties = ["userId", "sessionKey"];
const tabIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An upstream description can name other upstream tools. Show the Stelz names.
const stelzText = (text: string) => text.replace(/camofox_[a-z_]+/g, name => stelzNames.get(name) ?? name);

export type BrowserTool = { entry: Entry; tool: Tool };
/** The listed browser tools by Stelz name. The result holds new objects. The upstream definitions stay unchanged. */
export function browserTools(defs: readonly Tool[]): Map<string, BrowserTool> {
  const listed = entries.filter(item => item.policy !== "held");
  if (listed.some(item => defs.filter(def => def.name === item.upstream).length !== 1))
    throw Error(`Camofox must provide each of these tools once: ${listed.map(item => item.upstream).join(", ")}.`);
  return new Map(listed.map(item => {
    const def = defs.find(def => def.name === item.upstream)!;
    const properties = {
      ...structuredClone(Object.fromEntries(Object.entries(def.inputSchema.properties ?? {})
        .filter(([key]) => !routingProperties.includes(key) && !(item.hiddenProperties ?? []).includes(key)))),
      ...structuredClone(item.extraProperties ?? {}),
    };
    const tool: Tool = { ...def, name: item.name, description: stelzText(item.description ?? def.description),
      inputSchema: { ...def.inputSchema, properties, ...(def.inputSchema.required ? { required: [...def.inputSchema.required] } : {}) } };
    return [item.name, { entry: item, tool }] as const;
  }));
}

/** Check the arguments of one call against the exposed schema. The MCP server and the service both use it. */
export function toolArguments(tool: Tool, value: unknown = {}): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Tool arguments must be an object.");
  const args = value as Record<string, unknown>;
  if (routingProperties.some(name => Object.hasOwn(args, name))) throw Error("Routing fields are not accepted. Stelz selects the profile and the tab group.");
  if (tool.name === "tab_type" && Object.hasOwn(args, "mode") && !isTypingMode(args.mode))
    throw Error("Typing mode must be balanced, keyboard, or instant.");
  // Standalone Camofox generates UUIDs. Its contracts interpolate tabId into
  // URL paths, so reject route syntax before calling the canonical dispatcher.
  if (tool.inputSchema.required?.includes("tabId") || "tabId" in args) {
    if (typeof args.tabId !== "string" || args.tabId.length !== 36 || !tabIdPattern.test(args.tabId)) {
      throw Error("tabId must be a UUID returned by Camofox.");
    }
  }
  // Accept only the exposed properties. This also rejects hidden upstream properties and the internal typingMode.
  const properties = tool.inputSchema.properties ?? {};
  if (Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw Error("Unknown tool argument.");
  // Upstream rejects a fraction in an integer property. A number with a maximum sets a time limit, so reject a value that the deadline cannot cover.
  for (const [key, schema] of Object.entries(properties)) {
    const { type, minimum = 0, maximum } = schema as { type?: string; minimum?: number; maximum?: number };
    if (!Object.hasOwn(args, key)) continue;
    const number = args[key];
    if (type === "integer" && !Number.isInteger(number)) throw Error(`${key} must be an integer.`);
    if (typeof maximum === "number" && (typeof number !== "number" || !Number.isFinite(number) || number < minimum || number > maximum))
      throw Error(`${key} must be a number from ${minimum} to ${maximum}.`);
  }
  return args;
}
