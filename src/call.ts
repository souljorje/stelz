// Generic MCP diagnostic client, also usable before desktop MCP reload.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { ROOT, STATE } from "./config.ts";
const client = new Client({ name: "stelz-diagnostic", version: "0.1.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, "src/mcp.ts")], cwd: ROOT, env: Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)), stderr: "inherit" });
try {
  await client.connect(transport);
  const [name = "tools", input = "{}"] = process.argv.slice(2);
  if (name === "tools") console.log(JSON.stringify(await client.listTools(), null, 2));
  else {
    const result = await client.callTool({ name, arguments: JSON.parse(input) }, undefined, { timeout: 180000 });
    for (const block of result.content as Array<{ type: string; text?: string; data?: string }>) {
      if (block.type === "text") console.log(block.text);
      if (block.type === "image" && block.data) {
        const folder = join(STATE, "artifacts"); mkdirSync(folder, { recursive: true, mode: 0o700 });
        const path = join(folder, `${name}-${Date.now()}.png`); writeFileSync(path, Buffer.from(block.data, "base64"), { mode: 0o600 }); console.log(`Screenshot: ${path}`);
      }
    }
    if (result.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
