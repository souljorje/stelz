import { start, stop, reportStatus, intervention, recheck, running } from "./runtime.ts";
import { profile } from "../profiles/config.ts";
import type { UiAction } from "../api/contracts.ts";

// Both operator interfaces use the same lifecycle and ownership checks.
export async function runLifecycle(command: UiAction | "status" | "restart", id: string, signal?: AbortSignal) {
  switch (command) {
    case "restart": return restart(id, signal);
    case "start": return start(id, signal);
    case "stop": return stop(id);
    case "status": return reportStatus(id);
    case "release": return intervention(id, "handoff");
    case "recheck": return recheck(id, signal);
    case "pause":
    case "resume": return intervention(id, command);
    default: throw Error(`Unknown command: ${command}`);
  }
}

/** Stop and then start a running profile, so that it uses the current runtime. */
async function restart(id: string, signal?: AbortSignal) {
  profile(id);
  if (!running(id)) throw Error(`Profile is stopped. Run stelz start ${id}.`);
  await stop(id);
  return start(id, signal);
}
