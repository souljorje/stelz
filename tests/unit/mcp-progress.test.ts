import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, type CallToolResult, type Progress, type ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { withProgress } from "../../src/mcp/progress.ts";

const interval = 20;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
  const sent: ServerNotification[] = [];
  let finish = () => {};
  const server = new Server({ name: "progress-fixture", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const recorded = { ...extra, sendNotification: (notification: ServerNotification) => {
      sent.push(notification);
      return extra.sendNotification(notification);
    } };
    const slow = new Promise<CallToolResult>(resolve => {
      finish = () => resolve({ content: [{ type: "text", text: "done" }] });
    });
    return withProgress(recorded, `Stelz is still running ${request.params.name}.`, slow, interval);
  });
  const client = new Client({ name: "progress-check", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, sent, finish: () => finish(), close: async () => { await client.close(); await server.close(); } };
}

test("a slow call with a progress token reports progress and returns its result", async () => {
  const f = await fixture();
  try {
    const received: Progress[] = [];
    const call = f.client.callTool({ name: "camofox_type", arguments: {} }, undefined,
      { onprogress: progress => received.push(progress), resetTimeoutOnProgress: true });
    while (received.length < 3) await wait(interval);
    f.finish();
    expect((await call).content).toEqual([{ type: "text", text: "done" }]);
    const progress = received.map(entry => entry.progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(new Set(progress).size).toBe(progress.length);
    expect(received[0]!.message).toBe("Stelz is still running camofox_type.");
    // No notifications follow completion.
    const count = f.sent.length;
    await wait(interval * 4);
    expect(f.sent).toHaveLength(count);
    expect(received).toHaveLength(count);
  } finally { await f.close(); }
});

test("a call without a progress token sends no notifications", async () => {
  const f = await fixture();
  try {
    const call = f.client.callTool({ name: "camofox_type", arguments: {} });
    await wait(interval * 4);
    f.finish();
    expect((await call).content).toEqual([{ type: "text", text: "done" }]);
    expect(f.sent).toHaveLength(0);
  } finally { await f.close(); }
});

test("a cancelled call stops progress notifications", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const call = f.client.callTool({ name: "camofox_type", arguments: {} }, undefined,
      { onprogress: () => {}, signal: controller.signal });
    while (f.sent.length < 1) await wait(interval);
    controller.abort();
    await expect(call).rejects.toThrow();
    await wait(interval);
    const count = f.sent.length;
    await wait(interval * 4);
    expect(f.sent).toHaveLength(count);
    f.finish();
  } finally { await f.close(); }
});
