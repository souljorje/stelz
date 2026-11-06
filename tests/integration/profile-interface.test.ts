import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import { processStart } from "../../src/runtime/profile-process.ts";
import { assertTestHome, createTestHome } from "../helpers/test-home.ts";

const cli = resolve(import.meta.dir, "../../src/cli/cli.ts");
type Result = Awaited<ReturnType<Client["callTool"]>>;
const data = (result: Result) => JSON.parse((result.content as { text: string }[])[0]!.text);
async function fixture() {
  const home = createTestHome("profile-interface"), env = { ...process.env, STELZ_HOME: home };
  const clients = new Set<Client>(), services = new Set<ReturnType<typeof Bun.serve>>();
  const sent: { profileId: string; action: string; body: Record<string, unknown> }[] = [];
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  expect((await run("init")).code).toBe(0);
  const contracts = join(home, `runtime/camofox-${UPSTREAM_VERSION}/mcp/lib`);
  mkdirSync(contracts, { recursive: true });
  const canonical = pathToFileURL(resolve(import.meta.dir, "../../node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs")).href;
  writeFileSync(join(contracts, "tool-contracts.mjs"), `export { TOOL_DEFS } from ${JSON.stringify(canonical)};\n`);
  async function connect() {
    const client = new Client({ name: "profile-interface-test", version: "1" }); clients.add(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", cli, "mcp"], env, stderr: "pipe" }));
    return client;
  }
  function service(profileId: string, version: number | undefined = 1) {
    const config = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8"));
    const profile = config.profiles.find((value: { id: string }) => value.id === profileId);
    const instanceId = crypto.randomUUID(), state = { owner: "", instanceId, version: version as number | undefined };
    const server = Bun.serve({ hostname: "127.0.0.1", port: profile.port, async fetch(req) {
      const action = new URL(req.url).pathname.split("/").at(-1)!;
      if (action === "status") return Response.json({ profileId, instanceId, phase: "ready", controlProtocolVersion: state.version,
        controller: state.owner ? { id: state.owner, label: "test", pid: process.pid, activeActions: 0, releasing: false } : null });
      const body = await req.json() as Record<string, unknown>;
      sent.push({ profileId, action, body });
      if (body.profileId !== profileId || body.instanceId !== instanceId) return Response.json({ error: "Wrong service." }, { status: 409 });
      if (action === "acquire") {
        if (state.owner) return Response.json({ error: "Profile has an active controller." }, { status: 409 });
        state.owner = String(body.id);
        return Response.json({ profileId, instanceId, phase: "ready", acquired: true, controller: { id: state.owner, label: "test" } });
      }
      if (action === "release") { if (body.controllerId === state.owner) state.owner = ""; return Response.json({ released: true }); }
      if (body.controllerId !== state.owner) return Response.json({ error: "Wrong controller." }, { status: 409 });
      return Response.json({ content: [{ type: "text", text: JSON.stringify({ profileId }) }] });
    } });
    services.add(server);
    const directory = join(home, "profiles", profileId); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "access-key"), "fixture-key");
    writeFileSync(join(directory, "status.json"), JSON.stringify({ profileId, instanceId, phase: "ready" }));
    const start = processStart(process.pid)!;
    writeFileSync(join(directory, "running.json"), JSON.stringify({ version: 2, pid: process.pid, supervisorStart: start,
      serverPid: process.pid, serverStart: start, instanceId: crypto.randomUUID(), configurationHash: "fixture", port: server.port, serverState: "started" }));
    return state;
  }
  return { home, run, connect, service, sent, async close() {
    for (const client of clients) await client.close();
    for (const server of services) server.stop(true);
    rmSync(assertTestHome(home), { recursive: true, force: true });
  } };
}

test("one MCP connection discovers an empty and changing catalog with fixed schemas", async () => {
  const f = await fixture();
  try {
    const client = await f.connect(), original = (await client.listTools()).tools;
    expect(original).toHaveLength(18);
    expect(data(await client.callTool({ name: "profile_list" }))).toEqual({ profiles: [] });
    const call = (name: string, profileId: string) => client.callTool({ name, arguments: { profileId } });
    expect(data(await call("profile_create", "alpha"))).toMatchObject({ profileId: "alpha", created: true, phase: "stopped" });
    expect(data(await call("profile_create", "alpha"))).toMatchObject({ created: false });
    expect((await call("profile_acquire", "alpha")).isError).toBe(true);
    expect((await call("profile_create", "beta")).isError).not.toBe(true);
    expect((await f.run("profile", "create", "external", "--direct")).code).toBe(0);
    mkdirSync(join(f.home, "profiles/beta"), { recursive: true });
    writeFileSync(join(f.home, "profiles/beta/running.json"), "broken");
    const listed = data(await client.callTool({ name: "profile_list" })).profiles;
    expect(listed.map((value: { profileId: string }) => value.profileId)).toEqual(["alpha", "beta", "external"]);
    expect(listed[1]).toMatchObject({ profileId: "beta", phase: "unavailable" });
    expect((await client.listTools()).tools).toEqual(original);
    for (const tool of original.filter(tool => tool.name !== "profile_list")) {
      expect(tool.inputSchema.required).toContain("profileId");
      expect(tool.inputSchema.properties?.profileId).not.toHaveProperty("enum");
    }
    for (const args of [["--profile", "alpha"], ["--profile=alpha"], ["--identity", "alpha"]]) {
      const rejected = await f.run("mcp", ...args);
      expect(rejected.code).toBe(1); expect(rejected.stderr).toContain("stelz mcp");
      if (args[0]!.startsWith("--profile")) expect(rejected.stderr).toContain("removed");
    }
  } finally { await f.close(); }
}, 20000);

test("stdio routing requires connection-local handles, strips routing, and never exposes controller credentials", async () => {
  const f = await fixture();
  try {
    const client = await f.connect(), other = await f.connect();
    for (const profileId of ["alpha", "beta"]) await client.callTool({ name: "profile_create", arguments: { profileId } });
    const a = f.service("alpha"), b = f.service("beta");
    const acquired = async (profileId: string) => data(await client.callTool({ name: "profile_acquire", arguments: { profileId } }));
    const first = await acquired("alpha"), second = await acquired("beta");
    expect(first.controlHandle).toBeString(); expect(first.controlHandle).not.toBe(a.owner);
    expect(first.controller).not.toHaveProperty("id");
    expect(JSON.stringify(data(await client.callTool({ name: "profile_list" })))).not.toContain(a.owner);
    expect(JSON.stringify(data(await client.callTool({ name: "profile_status", arguments: { profileId: "alpha" } })))).not.toContain(first.controlHandle);
    const count = f.sent.length;
    const valid = { profileId: "alpha", controlHandle: first.controlHandle };
    for (const args of [{ profileId: "alpha" }, { ...valid, profileId: "beta" }, { ...valid, controlHandle: "unknown" },
      ...["controllerId", "id", "instanceId", "sessionKey", "userId", "accessKey", "typingMode"].map(key => ({ ...valid, [key]: "injected" }))])
      expect((await client.callTool({ name: "camofox_list_tabs", arguments: args })).isError).toBe(true);
    expect((await other.callTool({ name: "camofox_list_tabs", arguments: valid })).isError).toBe(true);
    expect(f.sent).toHaveLength(count);
    expect(data(await client.callTool({ name: "camofox_list_tabs", arguments: valid }))).toEqual({ profileId: "alpha" });
    expect(f.sent.at(-1)!.body.args).toEqual({});
    await client.callTool({ name: "profile_release", arguments: valid });
    expect(b.owner).not.toBe("");
    expect((await client.callTool({ name: "camofox_list_tabs", arguments: { profileId: "beta", controlHandle: second.controlHandle } })).isError).not.toBe(true);
    const next = data(await other.callTool({ name: "profile_acquire", arguments: { profileId: "alpha" } }));
    const owner = a.owner;
    await client.callTool({ name: "profile_release", arguments: valid }); expect(a.owner).toBe(owner);
    expect(next.controlHandle).not.toBe(first.controlHandle);
    await client.close(); expect(b.owner).toBe("");
    await other.close(); expect(a.owner).toBe("");
  } finally { await f.close(); }
}, 20000);

test("incompatible services fail before acquisition with setup and restart guidance", async () => {
  const f = await fixture();
  try {
    const client = await f.connect();
    await client.callTool({ name: "profile_create", arguments: { profileId: "legacy" } });
    const state = f.service("legacy"); state.version = undefined;
    const result = await client.callTool({ name: "profile_acquire", arguments: { profileId: "legacy" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("stelz setup");
    expect(JSON.stringify(result)).toContain("stop running profiles before stelz setup");
    expect(JSON.stringify(result)).toContain("stelz start legacy");
    expect(f.sent).toHaveLength(0); expect(state.owner).toBe("");
  } finally { await f.close(); }
}, 20000);
