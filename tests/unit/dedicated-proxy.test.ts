import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dedicatedProxyInputs } from "../helpers/dedicated-proxy.ts";
import { lockPublicProfile } from "../helpers/public-profile.ts";
import { createTestHome } from "../helpers/test-home.ts";

const proxy = "http://fixture:secret@proxy.invalid:8080";

test("live input requires an explicit file and the correct dedicated purpose", () => {
  const home = mkdtempSync(join(tmpdir(), "dedicated-proxy-")), file = join(home, "input.env");
  try {
    expect(() => dedicatedProxyInputs(undefined, "acceptance")).toThrow("PROXY_TEST_ENV");
    expect(() => dedicatedProxyInputs("relative.env", "acceptance")).toThrow("absolute");
    expect(() => dedicatedProxyInputs(file, "acceptance")).toThrow("Cannot read");
    writeFileSync(file, `PROXY_TEST_URL=${proxy}\n`);
    expect(() => dedicatedProxyInputs(file, "acceptance")).toThrow("dedicated-acceptance");
    writeFileSync(file, `PROXY_TEST_USAGE=dedicated-acceptance\nPROXY_TEST_URL=${proxy}\n`);
    expect(dedicatedProxyInputs(file, "acceptance").PROXY_TEST_URL).toBe(proxy);
    expect(() => dedicatedProxyInputs(file, "public")).toThrow("dedicated-public");
    writeFileSync(file, `PROXY_TEST_USAGE=dedicated-public\nPROXY_TEST_URL=${proxy}\n`);
    expect(dedicatedProxyInputs(file, "public").PROXY_TEST_URL).toBe(proxy);
    expect(() => dedicatedProxyInputs(file, "acceptance")).toThrow("dedicated-acceptance");
    writeFileSync(file, `PROXY_TEST_USAGE=dedicated-public\nPROXY_TEST_URL=${proxy}\nPROXY_TEST_SECOND_URL=http://second.invalid\n`);
    expect(() => dedicatedProxyInputs(file, "public")).toThrow("one dedicated");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("public checks preserve profile configuration and data across runs and reject route changes", () => {
  const home = createTestHome("public-profile-unit");
  try {
    const first = lockPublicProfile(home, proxy);
    const settings = readFileSync(join(home, "profiles.json"), "utf8");
    const binding = readFileSync(join(home, ".public-proxy.json"), "utf8");
    writeFileSync(join(home, "saved-identity"), "cookie/device fixture");
    for (const credential of ["fixture", "secret"]) expect(binding).not.toContain(credential);
    expect(() => lockPublicProfile(home, proxy)).toThrow("locked");
    first.release();
    const rotated = lockPublicProfile(home, "http://rotated:changed@proxy.invalid:8080");
    expect(readFileSync(join(home, "profiles.json"), "utf8")).toBe(settings);
    expect(readFileSync(join(home, "saved-identity"), "utf8")).toBe("cookie/device fixture");
    expect(readFileSync(join(home, ".public-proxy.json"), "utf8")).toBe(binding);
    rotated.release();
    for (const route of ["http://fixture:secret@different.invalid:8080", "http://fixture:secret@proxy.invalid:8081",
      "https://fixture:secret@proxy.invalid:8080"]) {
      expect(() => lockPublicProfile(home, route)).toThrow("another proxy");
    }
    expect(() => lockPublicProfile(home, proxy, "192.0.2.1")).toThrow("another proxy");
    expect(existsSync(join(home, ".public-check.lock"))).toBe(false);
    expect(readFileSync(join(home, "profiles.json"), "utf8")).toBe(settings);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("public checks refuse unowned homes and cannot adopt existing test profiles", () => {
  const unowned = mkdtempSync(join(tmpdir(), "public-unowned-")), home = createTestHome("public-profile-unit");
  try {
    expect(() => lockPublicProfile(undefined, proxy)).toThrow("PUBLIC_TEST_HOME");
    expect(() => lockPublicProfile(unowned, proxy)).toThrow("unowned");
    writeFileSync(join(home, "profiles.json"), '{"profiles":[{"id":"other"}]}');
    expect(() => lockPublicProfile(home, proxy)).toThrow("empty test home");
    expect(JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")).profiles[0].id).toBe("other");
    expect(existsSync(join(home, ".public-proxy.json"))).toBe(false);
    expect(existsSync(join(home, ".public-check.lock"))).toBe(false);
  } finally { for (const path of [unowned, home]) rmSync(path, { recursive: true, force: true }); }
});

test("public checks refuse edited configuration without replacing it", () => {
  const home = createTestHome("public-profile-unit");
  try {
    lockPublicProfile(home, proxy).release();
    const file = join(home, "profiles.json"), settings = JSON.parse(readFileSync(file, "utf8"));
    settings.profiles[0].proxyEnv = "EVERYDAY_PROXY";
    const modified = JSON.stringify(settings);
    writeFileSync(file, modified);
    expect(() => lockPublicProfile(home, proxy)).toThrow("configuration changed");
    expect(readFileSync(file, "utf8")).toBe(modified);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("live entrypoints fail before network or browser work when only an ambient proxy is supplied", async () => {
  for (const script of ["tests/browser/proxy-integration.ts", "tests/qa/public-sites.ts", "tests/qa/package.ts"]) {
    const child = Bun.spawn([process.execPath, "--no-env-file", script, ...(script.endsWith("package.ts") ? ["--proxy"] : [])], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PROXY_TEST_URL: proxy }, stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).not.toBe(0);
    expect(out + err).toContain("PROXY_TEST_ENV");
    expect(out + err).not.toContain(proxy);
  }
});
