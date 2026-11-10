import type { Tool } from "../browser/upstream.ts";
import { isTypingMode, TYPING_MODES } from "../browser/typing.ts";
import { TYPING_LIMIT_MS } from "../browser/deadlines.ts";

const excludedTools = new Set(["camofox_evaluate", "camofox_import_cookies"]);
const tabIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function allowedBrowserTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => !excludedTools.has(tool.name)).map(tool => {
    if (tool.name !== "camofox_type" || !("inputSchema" in tool)) return tool;
    const definition = tool as T & Tool;
    return { ...definition, inputSchema: { ...definition.inputSchema, properties: {
      ...definition.inputSchema.properties,
      mode: { type: "string", enum: [...TYPING_MODES],
        description: "Typing mode for this call. Omit to use the profile default. Balanced uses paced input if its estimated duration is at most 10 seconds. " +
          `Longer text uses bulk entry. Keyboard uses paced input without bulk fallback, for up to ${TYPING_LIMIT_MS / 60_000} minutes. ` +
          "Text that needs longer fails before the field changes. Paced input can include corrected typos in plain text fields. Instant uses bulk entry." },
    } } };
  });
}

export function browserToolArguments(tool: Tool, value: unknown = {}): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Tool arguments must be an object.");
  const args = value as Record<string, unknown>;
  if (tool.name === "camofox_type" && Object.hasOwn(args, "mode") && !isTypingMode(args.mode))
    throw Error("Typing mode must be balanced, keyboard, or instant.");
  // Standalone Camofox generates UUIDs. Its contracts interpolate tabId into
  // URL paths, so reject route syntax before calling the canonical dispatcher.
  if (tool.inputSchema.required?.includes("tabId") || "tabId" in args) {
    if (typeof args.tabId !== "string" || args.tabId.length !== 36 || !tabIdPattern.test(args.tabId)) {
      throw Error("tabId must be a UUID returned by Camofox.");
    }
  }
  return args;
}
