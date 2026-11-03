// Operator acceptance: close the single test browser window when prompted.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
mkdirSync(join(root, ".state"), { recursive: true });
const home = mkdtempSync(join(root, ".state/window-close-"));
process.env.STELZ_HOME = home;
const { initialize, dir } = await import("../src/config.ts");
const { assertStoppedProfile, running } = await import("../src/runtime.ts");
const { createUiModel } = await import("../src/ui-model.ts");
const { createUiServer } = await import("../src/ui-server.ts");
const cli = join(root, "dist/cli.js"), id = "window-close-check";
async function command(...args: string[]) {
  const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code) throw Error(err || out || `Exit ${code}`);
}
initialize();
const model = createUiModel();
await model.createProfile({ id, revision: (await model.snapshot()).catalogRevision });
let ui: ReturnType<typeof createUiServer> | undefined;
let fixture: ReturnType<typeof Bun.serve> | undefined;
const report: Record<string, unknown> = { home, profile: id };
try {
  await command("setup"); await command("start", id);
  const before = (await model.snapshot()).profiles[0]!;
  const pin = readFileSync(join(dir(id), "fingerprint.json"), "utf8");
  fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    '<!doctype html><title>STELZ window-close-check · isolated test</title><h1>Close this test browser window</h1>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } }) });
  const page = await fetch(`http://127.0.0.1:${before.port}/tabs`, { method: "POST",
    headers: { Authorization: `Bearer ${readFileSync(join(dir(id), "access-key"), "utf8").trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: id, sessionKey: "default", url: `http://127.0.0.1:${fixture.port}/` }) });
  if (!page.ok) throw Error("The isolated test page could not be opened.");
  ui = createUiServer({ port: 0 });
  console.log(JSON.stringify({ ready: true, home, port: before.port, ui: ui.launchUrl,
    instruction: "Close the browser window for window-close-check. The test will verify shutdown and an explicit restart." }));
  const deadline = Date.now() + 300_000;
  let clean = false;
  while (Date.now() < deadline) {
    const profile = (await model.snapshot()).profiles[0]!;
    if (profile.phase === "unclean") throw Error("Closing the browser left an unclean lifetime.");
    if (profile.phase === "stopped" && !running(id)) {
      assertStoppedProfile(id); clean = true; break;
    }
    await Bun.sleep(250);
  }
  if (!clean) throw Error("Window closure did not stop the profile within the test deadline.");
  report.closed = await model.snapshot();
  await command("start", id);
  const after = (await model.snapshot()).profiles[0]!;
  if (after.phase !== "ready" || after.instanceId === before.instanceId || readFileSync(join(dir(id), "fingerprint.json"), "utf8") !== pin)
    throw Error("Explicit restart did not preserve the profile and create a new lifetime.");
  report.result = "passed";
  report.checks = ["actual browser window close", "UI model reports stopped", "verified clean receipt", "explicit restart", "saved fingerprint preserved"];
} catch (error) { report.result = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  ui?.stop(); await command("stop", id).catch(() => {}); fixture?.stop(true);
  writeFileSync(join(home, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}
