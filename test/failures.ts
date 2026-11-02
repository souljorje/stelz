import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(import.meta.dir, ".."), folder = join(root, ".state/failure-acceptance");
mkdirSync(folder, { recursive: true, mode: 0o700 });
const config = join(folder, "profiles.json");
writeFileSync(config, JSON.stringify({ maxActive: 1, profiles: [
  { id: "unreachable-proxy", port: 9481, mode: "proxy", proxyEnv: "STELZ_TEST_BAD_PROXY" },
  { id: "wrong-exit", port: 9482, mode: "direct", expectedIPEnv: "STELZ_TEST_WRONG_IP" }
] }));
process.env.STELZ_CONFIG = config; process.env.STELZ_STATE_DIR = folder;
process.env.STELZ_TEST_BAD_PROXY = "http://127.0.0.1:9";
process.env.STELZ_TEST_WRONG_IP = "192.0.2.1";
const { acquire, running, adminStop } = await import("../src/runtime.ts");
const report: Record<string, unknown>[] = [];
for (const id of ["unreachable-proxy", "wrong-exit"]) {
  console.log(`Testing fail-closed behavior: ${id}`);
  const entry: Record<string, unknown> = { profileId: id }; report.push(entry);
  let rejected = false;
  try { await acquire(id, "failure-acceptance"); }
  catch (e) { rejected = true; entry.acquisitionRejected = true; entry.error = String(e); }
  try { await adminStop(id); } catch {}
  const log = readFileSync(join(folder, id, "server.log"), "utf8");
  const noDirectFallback = id !== "unreachable-proxy" || (!log.includes('"msg":"no proxy configured"') && log.includes('"proxyServer":"http://127.0.0.1:9"'));
  const stopped = !running(id);
  entry.noDirectFallback = noDirectFallback;
  entry.stopped = stopped;
  if (!rejected || !noDirectFallback || !stopped) process.exitCode = 1;
}
writeFileSync(join(folder, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
