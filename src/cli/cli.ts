#!/usr/bin/env -S bun --no-env-file
import type { UiAction } from "../api/contracts.ts";
import { STELZ_VERSION } from "../versions.ts";
import { LocationError } from "../browser/location.ts";

const [command = "help", ...rawArgs] = process.argv.slice(2);
const rootJsonMode = ["setup", "start", "recheck", "status", "doctor"].includes(command) && rawArgs.includes("--json");
const jsonMode = rootJsonMode || command === "profile" && rawArgs.includes("--json");
const args = rootJsonMode ? rawArgs.filter(arg => arg !== "--json") : rawArgs;
function diagnostic(error: unknown) {
  const message = (error as Error).message;
  const downloads = (error as { downloads?: string[] }).downloads;
  const code = error instanceof LocationError ? error.location.code : downloads ? "confirmation_required" : command === "setup" ? "setup_failed" : "service_unavailable";
  return jsonMode ? JSON.stringify({ ok: false, error: { code, message, ...(downloads ? { downloads } : {}) },
    ...(error instanceof LocationError ? { location: error.location } : {}) }) : message;
}
/** Ask once in a terminal before setup downloads anything. */
async function confirmDownloads(downloads: string[]) {
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await prompt.question(`Setup will download:\n${downloads.map(item => `- ${item}`).join("\n")}\nDownload now? [y/N] `)).trim()); }
  finally { prompt.close(); }
}
try {
  // Configuration paths can fail during module initialization. Keep CLI errors structured too.
  const { HOME_DIR, settings } = await import("../profiles/config.ts");
  const { recover, doctor, logs } = await import("../runtime/runtime.ts");
  const { runLifecycle } = await import("../runtime/operations.ts");
  const { setup, setupSummary } = await import("../browser/setup.ts");
  const { runMcp } = await import("../mcp/mcp.ts");
  if (command === "--version" || command === "version") console.log(STELZ_VERSION);
  else if (command === "help" || command === "--help")
    console.log(
      `stelz ${STELZ_VERSION}\n\nstelz setup [--yes] [--json]\nstelz profile create ID [--direct | --proxy-url URL | --proxy-env NAME] [--expected-ip IP | --expected-ip-env NAME] [--json]\nstelz profile fingerprint check PROFILE [--json]\nstelz profile export ID...|--all --output FILE [--json]\nstelz profile import FILE [--profile SOURCE_ID]... [--rename SOURCE_ID=NEW_ID]... [--json]\nstelz ui [--port 1024-65535] [--open]\nstelz start ID|all [--json]\nstelz status [ID|all] [--json]\nstelz doctor [ID|all] [--json]\nstelz logs ID [--lines 1-500]\nstelz recover ID\nstelz stop ID|all\nstelz pause ID\nstelz resume ID\nstelz recheck ID [--json]\nstelz release ID\nstelz mcp\n\nSTELZ_HOME selects the service data directory. Default: ${HOME_DIR}`,
    );
  else if (command === "profile") await (await import("./profile.ts")).runProfile(args);
  else if (command === "setup") {
    if (args.some(arg => arg !== "--yes")) throw Error("Use: stelz setup [--yes] [--json]");
    const interactive = !jsonMode && process.stdin.isTTY && process.stderr.isTTY;
    const report = await setup({ yes: args.includes("--yes"), confirm: interactive ? confirmDownloads : undefined });
    console.log(jsonMode ? JSON.stringify({ ok: true, ...report }, null, 2) : setupSummary(report));
  }
  else if (command === "ui") (await import("../api/ui-server.ts")).runUi(args);
  else if (command === "doctor") {
    if (args.length > 1) throw Error("Use: stelz doctor [ID|all]");
    console.log(JSON.stringify(await doctor(args[0]), null, 2));
  } else if (command === "logs") {
    if (!args[0]) throw Error("Select a profile: stelz logs ID [--lines 1-500]");
    if (args.length > 1 && (args.length !== 3 || args[1] !== "--lines" || !/^\d+$/.test(args[2]!)))
      throw Error("Use: stelz logs ID [--lines 1-500]");
    console.log(JSON.stringify(logs(args[0], args[2] === undefined ? 100 : Number(args[2])), null, 2));
  } else if (command === "recover") {
    if (args.length !== 1 || args[0] === "all") throw Error("Select one profile: stelz recover ID");
    console.log(JSON.stringify(await recover(args[0]!), null, 2));
  } else if (command === "mcp") {
    if (args.length) throw Error("Use: stelz mcp. Select profiles through tool arguments.");
    await runMcp();
  } else if (["start", "status", "stop", "pause", "resume", "release", "recheck"].includes(command)) {
    const target = args[0] || (command === "status" ? "all" : "");
    if (!target) throw Error(`Select a profile: stelz ${command} ID`);
    if (command === "recheck" && target === "all") throw Error("Select one profile: stelz recheck ID");
    const ids = target === "all" ? settings().profiles.map((p) => p.id) : [target];
    for (const id of ids) {
      try {
        const result = await runLifecycle(command as UiAction | "status", id);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error(diagnostic(e));
        process.exitCode = 1;
      }
    }
  } else throw Error(`Unknown command: ${command}`);
} catch (e) {
  console.error(command === "profile" && args.includes("--json")
    ? JSON.stringify({ ok: false, error: { code: "profile_unavailable", message: "Cannot open the service configuration. Run stelz doctor and inspect the service files." } })
    : diagnostic(e));
  process.exitCode = 1;
}
