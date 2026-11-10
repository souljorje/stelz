import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertTestHome } from "./test-home.ts";

export const PUBLIC_PROFILE = "public-check";

/** A test-owned home is bound to one route; never replace its saved identity. */
export function lockPublicProfile(directory: string | undefined, proxy: string, expected?: string) {
  if (!directory) throw Error("Set PUBLIC_TEST_HOME to a persistent home created with createTestHome().");
  const home = assertTestHome(directory), lock = join(home, ".public-check.lock");
  try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch { throw Error("Public test home is locked. Check for an active run before removing .public-check.lock."); }
  const release = () => rmSync(lock, { force: true });
  try {
    const bindingFile = join(home, ".public-proxy.json"), settings = join(home, "profiles.json");
    const binding = createHash("sha256").update(JSON.stringify([new URL(proxy).href, expected ?? null])).digest("hex");
    const existing = existsSync(bindingFile);
    if (existing) {
      if (readFileSync(bindingFile, "utf8") !== binding) throw Error("Public test home belongs to another proxy route or IP pin.");
      const profiles = JSON.parse(readFileSync(settings, "utf8")).profiles;
      if (!Array.isArray(profiles) || profiles.length !== 1 || profiles[0].id !== PUBLIC_PROFILE
        || profiles[0].storage !== "native" || profiles[0].proxyEnv !== "PUBLIC_TEST_PROXY_URL"
        || profiles[0].expectedIPEnv !== (expected ? "PUBLIC_TEST_EXPECTED_IP" : undefined)) {
        throw Error("Public test profile configuration changed. Refusing to replace it.");
      }
    } else {
      if (existsSync(settings) || existsSync(join(home, "profiles"))) throw Error("First public check requires an empty test home.");
      const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = reservation.port; reservation.stop(true);
      writeFileSync(settings, JSON.stringify({ profiles: [{ id: PUBLIC_PROFILE, port, storage: "native",
        proxyEnv: "PUBLIC_TEST_PROXY_URL", ...(expected ? { expectedIPEnv: "PUBLIC_TEST_EXPECTED_IP" } : {}) }] }), { mode: 0o600, flag: "wx" });
      writeFileSync(bindingFile, binding, { mode: 0o600, flag: "wx" });
    }
    return { home, release };
  } catch (error) { release(); throw error; }
}
