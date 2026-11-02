import { ROOT, settings, profile } from "./config.ts";
import { start, adminStop, status, intervention } from "./runtime.ts";
const [action = "status", target = "all"] = process.argv.slice(2);
if (action === "codex") {
  if (target !== "all") profile(target);
  const path = target === "all" ? ROOT : `${ROOT}/sessions/${target}`;
  const command = Bun.spawn(["codex", "app", path], { stdout: "inherit", stderr: "inherit" });
  process.exit(await command.exited);
}
const ids = target === "all" ? settings().profiles.map(p => p.id) : [target];
let failed = false;
for (const id of ids) {
  try {
    const result = action === "start" ? await start(id) : action === "stop" ? await adminStop(id) : action === "pause" || action === "resume" ? await intervention(id, action) : action === "status" ? status(id) : (() => { throw Error("Use start/status/stop/pause/resume/codex [profileId|all]"); })();
    console.log(JSON.stringify(result, null, 2));
  } catch (e) { failed = true; console.error(`${id}: ${(e as Error).message}`); }
}
if (failed) process.exitCode = 1;
