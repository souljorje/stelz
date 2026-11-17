import { createServer } from "node:net";
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTestHome } from "./test-home.ts";

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

// Profile creation probes the default port range. Keep live fixtures out of it.
export async function useEphemeralProfilePort(home: string, id: string) {
  const path = join(assertTestHome(home), "profiles.json"), [port] = await unusedPorts(1);
  const config = JSON.parse(readFileSync(path, "utf8")) as { profiles: Array<{ id: string; port: number }> };
  const profile = config.profiles.find(profile => profile.id === id);
  assert(profile, `Test profile is missing: ${id}`);
  profile.port = port!;
  writeFileSync(`${path}.ports`, JSON.stringify(config), { mode: 0o600 });
  renameSync(`${path}.ports`, path);
}
