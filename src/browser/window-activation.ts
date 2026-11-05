import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function profileBrowserPid(output: string, parentPid: number, executable: string) {
  const matches = output.split("\n").flatMap(line => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return row && Number(row[2]) === parentPid && row[3] === executable ? [Number(row[1])] : [];
  });
  if (matches.length !== 1 || matches[0]! <= 1) throw Error("The profile's browser process could not be verified. Refresh and try again.");
  return matches[0]!;
}

// Firefox before 158 can raise a macOS window without activating its application.
// Request activation only for this service's direct browser child.
export async function activateProfileBrowser(executable: string) {
  if (process.platform !== "darwin") return;
  const path = realpathSync(executable);
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,comm="], { timeout: 2_000, maxBuffer: 2 * 1024 * 1024 });
  const pid = profileBrowserPid(stdout, process.pid, path);
  await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
    ObjC.import("AppKit");
    function run(args) {
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
      if (!app || app.isTerminated || ObjC.unwrap(app.executableURL.path) !== args[1]) throw Error("Browser process changed.");
      // The operator explicitly requested foreground activation for this exact PID.
      if (!app.activateWithOptions(2)) throw Error("Application activation was refused.");
      for (let attempt = 0; attempt < 24; attempt++) {
        if ($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier === Number(args[0])) return;
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
      }
      throw Error("Application activation was not confirmed.");
    }
  `, String(pid), path], { timeout: 2_000, maxBuffer: 4096 }).catch(() => {
    throw Error("The browser could not enter the foreground. Select its window manually, then try again.");
  });
}
