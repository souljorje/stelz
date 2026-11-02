#!/usr/bin/env -S bun --no-env-file
import { HOME_DIR, initialize, settings, control, profile } from "./config.ts";
import { start, stop, status, intervention, running } from "./runtime.ts";
import { setup } from "./setup.ts";
import { runMcp } from "./mcp.ts";
const [command = "help", ...args] = process.argv.slice(2);
try {
  if (command === "--version" || command === "version") console.log("0.2.0");
  else if (command === "help" || command === "--help") console.log(`stelz 0.2.0\n\nstelz init\nstelz setup\nstelz start ID|all\nstelz status [ID|all]\nstelz stop ID|all\nstelz pause ID\nstelz resume ID\nstelz release ID\nstelz mcp --identity ID\n\nSTELZ_HOME selects the service data directory. Default: ${HOME_DIR}`);
  else if (command === "init") { initialize(); console.log(HOME_DIR); }
  else if (command === "setup") await setup();
  else if (command === "mcp") {
    const index = args.indexOf("--identity");
    if (index < 0 || !args[index + 1]) throw Error("Select an identity: stelz mcp --identity ID");
    await runMcp(args[index + 1]!);
  } else if (["start", "status", "stop", "pause", "resume", "release"].includes(command)) {
    const target = args[0] || (command === "status" ? "all" : "");
    if (!target) throw Error(`Select an identity: stelz ${command} ID`);
    const ids = target === "all" ? settings().identities.map(p => p.id) : [target];
    for (const id of ids) {
      try {
        const result = command === "start" ? await start(id) : command === "stop" ? await stop(id) : command === "status" ? running(id) ? await control(profile(id), "GET", "status") : status(id) : await intervention(id, command === "release" ? "handoff" : command as "pause" | "resume");
        console.log(JSON.stringify(result, null, 2));
      } catch (e) { console.error((e as Error).message); process.exitCode = 1; }
    }
  } else throw Error(`Unknown command: ${command}`);
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
