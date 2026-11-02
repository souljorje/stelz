#!/usr/bin/env bun
// Generic MCP diagnostic client. No model or harness is required.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { entry, HOME_DIR } from "./config.ts";
import { STELZ_VERSION } from "./versions.ts";
const [id, name = "identity_status", input = "{}"] = process.argv.slice(2);
if (!id) throw Error("Select an identity: bun src/call.ts ID [TOOL] [JSON]");
const client = new Client({ name: "stelz-diagnostic", version: STELZ_VERSION });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", entry("cli"), "mcp", "--identity", id], env: { ...Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)), STELZ_HOME: HOME_DIR } }));
  if (name === "tools") console.log(JSON.stringify(await client.listTools(), null, 2));
  else {
    if (name.startsWith("camofox_")) { const acquired = await client.callTool({ name: "identity_acquire", arguments: {} }); if (acquired.isError) throw Error(JSON.stringify(acquired.content)); }
    const result = await client.callTool({ name, arguments: JSON.parse(input) }, undefined, { timeout: 180000 });
    console.log(JSON.stringify(result, null, 2)); if (result.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
