import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("service secrets select the IP interval and invalidate configuration only for a changed policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "stelz-ip-config-"));
  const script = `import { ipCheckIntervalMs, configurationHash } from ${JSON.stringify(join(import.meta.dir, "../src/config.ts"))};
console.log(JSON.stringify({interval:ipCheckIntervalMs(),hash:configurationHash({id:"network",port:9478,mode:"direct"})}));`;
  const env: NodeJS.ProcessEnv = { ...process.env, STELZ_HOME: home };
  delete env.STELZ_IP_CHECK_INTERVAL_MS;
  const read = async (override?: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: { ...env, ...(override === undefined ? {} : { STELZ_IP_CHECK_INTERVAL_MS: override }) }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(err);
    return JSON.parse(out) as { interval: number; hash: string };
  };
  try {
    const initial = await read();
    expect(initial.interval).toBe(120_000);
    writeFileSync(join(home, "secrets.env"), "STELZ_IP_CHECK_INTERVAL_MS=120000\n");
    expect(await read()).toEqual(initial);
    writeFileSync(join(home, "secrets.env"), "STELZ_IP_CHECK_INTERVAL_MS=1000\n");
    const periodic = await read();
    expect(periodic.interval).toBe(1000); expect(periodic.hash).not.toBe(initial.hash);
    const strict = await read("0");
    expect(strict.interval).toBe(0); expect(strict.hash).not.toBe(periodic.hash);
    expect(await read("120000")).toEqual(initial);
    expect((await read("60000")).interval).toBe(60_000);
    await expect(read("120001")).rejects.toThrow("STELZ_IP_CHECK_INTERVAL_MS");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
