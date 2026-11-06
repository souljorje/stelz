#!/usr/bin/env bun
// Generic MCP diagnostic client. No model or harness is required.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { entry, HOME_DIR } from "../src/profiles/config.ts";
import { STELZ_VERSION } from "../src/versions.ts";
import { redactControlHandles, requiresControl, routeProfileTools } from "../tests/helpers/mcp-client.ts";
const [id, name = "profile_status", input = "{}"] = process.argv.slice(2);
if (!id) throw Error("Select a profile: bun scripts/call.ts ID [TOOL] [JSON]");
const client = routeProfileTools(new Client({ name: "stelz-diagnostic", version: STELZ_VERSION }), id);
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", process.env.STELZ_TEST_CLI || entry("cli"), "mcp"], env: { ...Object.fromEntries(Object.entries(process.env).filter((v): v is [string, string] => v[1] !== undefined)), STELZ_HOME: HOME_DIR } }));
  if (name === "tools") console.log(JSON.stringify(await client.listTools(), null, 2));
  else {
    const args = JSON.parse(input) as Record<string, unknown>;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw Error("Tool arguments must be a JSON object.");
    if (requiresControl(name) && !Object.hasOwn(args, "controlHandle")) {
      const acquired = await client.callTool({ name: "profile_acquire", arguments: { profileId: args.profileId ?? id } }, undefined, { timeout: 180000 });
      if (acquired.isError) throw Error(JSON.stringify(redactControlHandles(acquired.content)));
    }
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    console.log(JSON.stringify(redactControlHandles(result), null, 2)); if (result.isError) process.exitCode = 1;
  }
} finally { await client.close(); }
