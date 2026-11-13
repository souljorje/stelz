import type { Tool } from "../browser/upstream.ts";
import { isTypingMode, TYPING_MODES } from "../browser/typing.ts";
import { TYPING_LIMIT_MS } from "../browser/deadlines.ts";

// Stelz exposes exactly these Camofox tools. Each Camofox release adds tools and properties.
// `hidden` names upstream properties that Stelz does not expose. A new upstream tool stays unavailable until reviewed.
const browserTools: Record<string, { hidden?: string[]; description?: string }> = {
  camofox_create_tab: {},
  camofox_snapshot: { hidden: ["annotateScreenshot"] },
  camofox_click: { hidden: ["coordinates"],
    description: "Click an element in a Camoufox tab by ref (e.g., e1) or CSS selector. Optionally pass expected_role and/or expected_accessible_name to assert the target is still the element you expected before the click lands." },
  camofox_type: {},
  camofox_navigate: {},
  camofox_scroll: {},
  camofox_screenshot: { hidden: ["fullPage"] },
  camofox_close_tab: {},
  camofox_list_tabs: {},
};
// Stelz fixes the profile (userId) and the tab group (sessionKey). Upstream adds both to every schema and accepts both as arguments.
const routingProperties = ["userId", "sessionKey"];
const tabIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const typingMode = { type: "string", enum: [...TYPING_MODES],
  description: "Typing mode for this call. Omit to use the profile default. Balanced uses paced input if its estimated duration is at most 10 seconds. " +
    `Longer text uses bulk entry. Keyboard uses paced input without bulk fallback, for up to ${TYPING_LIMIT_MS / 60_000} minutes. ` +
    "Text that needs longer fails before the field changes. Paced input can include corrected typos in plain text fields. Instant uses bulk entry." };

// Return new objects. The upstream definitions stay unchanged.
export function allowedBrowserTools(tools: readonly Tool[]): Tool[] {
  const allowed = tools.filter(tool => Object.hasOwn(browserTools, tool.name));
  if (allowed.length !== Object.keys(browserTools).length || new Set(allowed.map(tool => tool.name)).size !== allowed.length)
    throw Error(`Camofox must provide each of these tools once: ${Object.keys(browserTools).join(", ")}.`);
  return allowed.map(tool => {
    const { hidden = [], description = tool.description } = browserTools[tool.name]!;
    const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {})
      .filter(([name]) => !routingProperties.includes(name) && !hidden.includes(name)));
    return { ...tool, description, inputSchema: { ...tool.inputSchema,
      properties: tool.name === "camofox_type" ? { ...properties, mode: typingMode } : properties } };
  });
}

export function browserToolArguments(tool: Tool, value: unknown = {}): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Tool arguments must be an object.");
  const args = value as Record<string, unknown>;
  if (routingProperties.some(name => Object.hasOwn(args, name))) throw Error("Routing fields are not accepted. Stelz selects the profile and the tab group.");
  if (tool.name === "camofox_type" && Object.hasOwn(args, "mode") && !isTypingMode(args.mode))
    throw Error("Typing mode must be balanced, keyboard, or instant.");
  // Standalone Camofox generates UUIDs. Its contracts interpolate tabId into
  // URL paths, so reject route syntax before calling the canonical dispatcher.
  if (tool.inputSchema.required?.includes("tabId") || "tabId" in args) {
    if (typeof args.tabId !== "string" || args.tabId.length !== 36 || !tabIdPattern.test(args.tabId)) {
      throw Error("tabId must be a UUID returned by Camofox.");
    }
  }
  // Accept only the exposed properties. This also rejects hidden upstream properties and the internal typingMode.
  if (Object.keys(args).some(key => !Object.hasOwn(tool.inputSchema.properties ?? {}, key))) throw Error("Unknown tool argument.");
  return args;
}
