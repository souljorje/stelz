import { createServer } from "node:net";
import assert from "node:assert/strict";

export async function unusedPorts(count: number) {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    const ports: number[] = [];
    for (let n = 0; n < count; n++) {
      const server = createServer(); servers.push(server);
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address(); assert(address && typeof address !== "string", "Test port reservation failed.");
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}
