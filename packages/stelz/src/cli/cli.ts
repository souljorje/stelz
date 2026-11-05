#!/usr/bin/env -S bun --no-env-file
import { HOME_DIR, initialize, settings } from "../profiles/config.ts";
import { recover, doctor, logs } from "../runtime/runtime.ts";
import { runLifecycle } from "../runtime/operations.ts";
import type { UiAction } from "../api/contracts.ts";
import { setup } from "../browser/setup.ts";
import { runMcp } from "../mcp/mcp.ts";
import { STELZ_VERSION } from "../versions.ts";

const [command = "help", ...args] = process.argv.slice(2);
try {
  if (command === "--version" || command === "version") console.log(STELZ_VERSION);
  else if (command === "help" || command === "--help")
    console.log(
      `stelz ${STELZ_VERSION}\n\nstelz init\nstelz setup\nstelz ui [--port 1024-65535] [--open]\nstelz start ID|all\nstelz status [ID|all]\nstelz doctor [ID|all]\nstelz logs ID [--lines 1-500]\nstelz recover ID\nstelz stop ID|all\nstelz pause ID\nstelz resume ID\nstelz recheck ID\nstelz release ID\nstelz mcp --profile ID\n\nSTELZ_HOME selects the service data directory. Default: ${HOME_DIR}`,
    );
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
    if (args.length !== 2 || !["--profile", "--identity"].includes(args[0]!) || !args[1] || args[1].startsWith("--"))
      throw Error("Select a profile: stelz mcp --profile ID");
    await runMcp(args[1]);
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
  console.error((e as Error).message);
  process.exitCode = 1;
}
