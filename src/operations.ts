import { start, stop, reportStatus, intervention } from "./runtime.ts";
import type { UiAction } from "./ui-types.ts";

// Both operator interfaces use the same lifecycle and ownership checks.
export async function runLifecycle(command: UiAction | "status", id: string) {
  switch (command) {
    case "start": return start(id);
    case "stop": return stop(id);
    case "status": return reportStatus(id);
    case "release": return intervention(id, "handoff");
    case "recheck": return intervention(id, "check");
    case "pause":
    case "resume": return intervention(id, command);
    default: throw Error(`Unknown command: ${command}`);
  }
}
