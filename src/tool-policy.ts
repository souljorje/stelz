const excludedTools = new Set(["camofox_evaluate", "camofox_import_cookies"]);

export function allowedBrowserTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(tool => !excludedTools.has(tool.name));
}
