import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupProxyAcceptance } from "../helpers/proxy-acceptance-cleanup.ts";
import { PROXY_PROFILE_IDS as ids, proxyRedactor } from "../helpers/proxy-acceptance-helpers.ts";
import { replaceTestHome } from "../helpers/test-home.ts";

const directories: string[] = [];
const secret = "synthetic-cleanup-password", url = `http://cleanup-user:${secret}@proxy.invalid:8080`;
const redact = proxyRedactor([url]);
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporary() {
  const directory = mkdtempSync(join(tmpdir(), "stelz-proxy-cleanup-")); directories.push(directory); return directory;
}
function fixture() {
  const home = replaceTestHome(join(temporary(), "home"));
  writeFileSync(join(home, "secrets.env"), `PROXY=${url}`);
  for (const id of ids) {
    const profile = join(home, "profiles", id);
    mkdirSync(join(profile, "window-addon"), { recursive: true });
    writeFileSync(join(profile, "window-addon", "background.js"), `const password = ${JSON.stringify(secret)};`);
    writeFileSync(join(profile, "cookies.sqlite"), "native data");
    writeFileSync(join(profile, "running.json"), "owned lifetime");
  }
  return home;
}

for (const failed of [false, true]) test(`cleanup removes credential copies and preserves redacted evidence after acceptance ${failed ? "failure" : "success"}`, async () => {
  const home = fixture(), owned = new Set<string>(ids), stops: string[] = [];
  const report = [{ result: failed ? "failed" : "passed", detail: redact(url) }];
  writeFileSync(join(home, "report.json"), JSON.stringify(report));
  const run = async () => {
    try { if (failed) throw Error("Synthetic acceptance failure"); }
    finally {
      await cleanupProxyAcceptance(home, owned, async id => {
        stops.push(id);
        for (const profile of ids) expect(existsSync(join(home, "profiles", profile, "window-addon", "background.js"))).toBe(true);
      });
    }
  };
  if (failed) await expect(run()).rejects.toThrow("Synthetic acceptance failure");
  else await run();
  expect(stops).toEqual([...ids]); expect(owned.size).toBe(0);
  expect(existsSync(join(home, "secrets.env"))).toBe(false);
  for (const id of ids) expect(existsSync(join(home, "profiles", id))).toBe(false);
  expect(JSON.parse(readFileSync(join(home, "report.json"), "utf8"))).toEqual(report);
  expect(readFileSync(join(home, "report.json"), "utf8")).not.toContain(secret);
  await cleanupProxyAcceptance(home, owned, async () => { throw Error("Already stopped"); });
});

test("a failed stop does not skip later stops or delete native data; known credential files are removed", async () => {
  const home = fixture(), owned = new Set<string>(ids), stops: string[] = [];
  let failure = "";
  try {
    await cleanupProxyAcceptance(home, owned, async id => {
      stops.push(id);
      expect(existsSync(join(home, "secrets.env"))).toBe(true);
      if (id === ids[0]) throw Error(`Stop failed: ${url}`);
    });
  } catch (error) { failure = redact(String(error)); }
  expect(stops).toEqual([...ids]); expect([...owned]).toEqual([ids[0]]);
  expect(failure).toContain(`Stop ${ids[0]}`);
  expect(failure).toContain("Credential cleanup cannot be guaranteed");
  expect(failure).not.toContain(secret);
  expect(existsSync(join(home, "secrets.env"))).toBe(false);
  for (const id of ids) {
    expect(readFileSync(join(home, "profiles", id, "cookies.sqlite"), "utf8")).toBe("native data");
    expect(readFileSync(join(home, "profiles", id, "running.json"), "utf8")).toBe("owned lifetime");
    expect(existsSync(join(home, "profiles", id, "window-addon", "background.js"))).toBe(false);
  }
  await cleanupProxyAcceptance(home, owned, async () => {});
  for (const id of ids) expect(existsSync(join(home, "profiles", id))).toBe(false);
});

test("a credential removal failure is reported and does not skip other cleanup", async () => {
  const home = fixture();
  rmSync(join(home, "secrets.env")); mkdirSync(join(home, "secrets.env"));
  await expect(cleanupProxyAcceptance(home, new Set(ids), async () => {})).rejects.toThrow("Remove secrets.env");
  for (const id of ids) expect(existsSync(join(home, "profiles", id))).toBe(false);
});

test("cleanup refuses unmarked homes before stops or file removal", async () => {
  const home = temporary(); let stops = 0;
  writeFileSync(join(home, "secrets.env"), secret);
  await expect(cleanupProxyAcceptance(home, new Set(ids), async () => { stops++; })).rejects.toThrow("unowned service directory");
  expect(stops).toBe(0); expect(readFileSync(join(home, "secrets.env"), "utf8")).toBe(secret);
});

test("cleanup does not follow profile or addon directory links", async () => {
  for (const linked of ["profiles", "addon"] as const) {
    const home = fixture(), external = temporary();
    writeFileSync(join(external, "background.js"), "outside data");
    const target = linked === "profiles" ? join(home, "profiles") : join(home, "profiles", ids[0], "window-addon");
    rmSync(target, { recursive: true }); symlinkSync(external, target);
    await expect(cleanupProxyAcceptance(home, new Set(ids), async () => { throw Error("Still running"); })).rejects.toThrow("Refusing a linked or non-directory parent");
    expect(readFileSync(join(external, "background.js"), "utf8")).toBe("outside data");
    expect(existsSync(join(home, "secrets.env"))).toBe(false);
    if (linked === "addon") expect(existsSync(join(home, "profiles", ids[1], "window-addon", "background.js"))).toBe(false);
  }
});
