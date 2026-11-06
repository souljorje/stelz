#!/usr/bin/env -S bun --no-env-file
import type { UiAction } from "../api/contracts.ts";
import { STELZ_VERSION } from "../versions.ts";

const [command = "help", ...args] = process.argv.slice(2);
try {
  // Configuration paths can fail during module initialization. Keep CLI errors structured too.
  const { HOME_DIR, initialize, settings } = await import("../profiles/config.ts");
  const { recover, doctor, logs } = await import("../runtime/runtime.ts");
  const { runLifecycle } = await import("../runtime/operations.ts");
  const { setup } = await import("../browser/setup.ts");
  const { runMcp } = await import("../mcp/mcp.ts");
  if (command === "--version" || command === "version") console.log(STELZ_VERSION);
  else if (command === "help" || command === "--help")
    console.log(
      `stelz ${STELZ_VERSION}\n\nstelz init\nstelz setup\nstelz profile create ID [--direct | --proxy-url URL | --proxy-env NAME] [--expected-ip IP | --expected-ip-env NAME] [--json]\nstelz profile export ID...|--all --output FILE [--json]\nstelz profile import FILE [--profile SOURCE_ID]... [--rename SOURCE_ID=NEW_ID]... [--json]\nstelz ui [--port 1024-65535] [--open]\nstelz start ID|all\nstelz status [ID|all]\nstelz doctor [ID|all]\nstelz logs ID [--lines 1-500]\nstelz recover ID\nstelz stop ID|all\nstelz pause ID\nstelz resume ID\nstelz recheck ID\nstelz release ID\nstelz mcp\n\nSTELZ_HOME selects the service data directory. Default: ${HOME_DIR}`,
    );
  else if (command === "profile") await (await import("./profile.ts")).runProfile(args);
  else if (command === "init") {
    initialize();
    console.log(HOME_DIR);
  } else if (command === "setup") await setup();
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
    if (args.some(arg => arg === "--profile" || arg.startsWith("--profile=")))
      throw Error("The MCP --profile option was removed. Register stelz mcp once, then supply profileId to its tools and use the controlHandle from profile_acquire. Keep the same STELZ_HOME.");
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
        console.error((e as Error).message);
        process.exitCode = 1;
      }
    }
  } else throw Error(`Unknown command: ${command}`);
} catch (e) {
  console.error(command === "profile" && args.includes("--json")
    ? JSON.stringify({ ok: false, error: { code: "profile_unavailable", message: "Cannot open the service configuration. Run stelz doctor and inspect the service files." } })
    : (e as Error).message);
  process.exitCode = 1;
}
