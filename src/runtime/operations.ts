import { start, stop, reportStatus, intervention, recheck } from "./runtime.ts";
import type { UiAction } from "../api/contracts.ts";

// Both operator interfaces use the same lifecycle and ownership checks.
export async function runLifecycle(command: UiAction | "status", id: string, signal?: AbortSignal) {
  switch (command) {
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
