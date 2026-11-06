import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";

test("MCP exposes profile tools and rejects unrecognized aliases and CLI selectors", async () => {
  const home = createTestHome("profile-interface"), cli = resolve(import.meta.dir, "../../src/cli/cli.ts");
  const client = new Client({ name: "profile-interface-test", version: "1" });
  const env = { ...process.env, STELZ_HOME: home };
  try {
    const contracts = join(home, `runtime/camofox-${UPSTREAM_VERSION}/mcp/lib`);
    mkdirSync(contracts, { recursive: true });
    writeFileSync(join(contracts, "tool-contracts.mjs"), "export const TOOL_DEFS = [];\n");
    writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [{ id: "test", port: 19471 }] }));
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ["--no-env-file", cli, "mcp", "--profile", "test"], env, stderr: "pipe" }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(
      ["status", "acquire", "release", "pause", "resume", "recheck"].map(action => `profile_${action}`));
    const status = await client.callTool({ name: "profile_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(JSON.parse((status.content as { text: string }[])[0]!.text)).toMatchObject({ profileId: "test", phase: "stopped" });
    for (const action of ["status", "acquire", "release", "pause", "resume", "recheck"])
      expect((await client.callTool({ name: `identity_${action}`, arguments: {} })).isError).toBe(true);
    const rejected = Bun.spawn([process.execPath, "--no-env-file", cli, "mcp", "--identity", "test"],
      { env, stdout: "pipe", stderr: "pipe" });
    expect(await rejected.exited).not.toBe(0);
    expect(await new Response(rejected.stderr).text()).toContain("stelz mcp --profile ID");
  } finally { await client.close(); rmSync(assertTestHome(home), { recursive: true, force: true }); }
});
