import { readFileSync } from "node:fs";
import { join } from "node:path";
import { base, dir, profile } from "../profiles/config.ts";
import { assertRunning, reportStatus, running } from "../runtime/runtime.ts";
import { createUiRedactor } from "./ui-model.ts";
import type { ProfileWindows, ShowProfileWindow } from "../api/contracts.ts";
import { normalizeProfileId } from "../profiles/profile-compat.ts";

export type WindowModel = {
  list(id: string): Promise<ProfileWindows>;
  show(id: string, selection: ShowProfileWindow): Promise<void>;
};

async function request(id: string, action: string, body?: unknown) {
  const p = assertRunning(id), record = running(id);
  if (!record?.port) throw Error("The browser service is unavailable. Inspect this profile before continuing.");
  const token = readFileSync(join(dir(id), "access-key"), "utf8").trim();
  const response = await fetch(base({ ...p, port: record.port }) + "/local-profile/" + action, {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(body === undefined ? 3_000 : 75_000),
  });
  if (response.status === 404) throw Error("Update the runtime with stelz setup, then start this profile again.");
  const value = normalizeProfileId(await response.json() as Record<string, unknown>);
  if (!response.ok) throw Error(typeof value.error === "string" ? value.error : "Update the runtime with stelz setup, then start this profile again.");
  if (running(id)?.instanceId !== record.instanceId) throw Error("The browser restarted. Refresh the profile before selecting its window.");
  return value;
}

export function createWindowModel(): WindowModel {
  return {
    async list(id) {
      profile(id);
      const status = await reportStatus(id) as Record<string, unknown>;
      const unavailable = (reason: string): ProfileWindows => ({ profileId: id,
        instanceId: typeof status.instanceId === "string" ? status.instanceId : null, available: false,
        reason, updatedAt: null, windows: [] });
      if (status.phase === "stopped") return unavailable("Start this profile to see its browser windows.");
      if (!["ready", "paused", "verification_failed"].includes(String(status.phase))) return unavailable("Window controls are unavailable while this browser needs attention.");
      const redact = createUiRedactor();
      const url = (value: string) => {
        // Older extensions can send a truncated URL. Never display malformed credentials.
        try { new URL(value); } catch { return ""; }
        return redact(value, 512);
      };
      try {
        const value = await request(id, "windows") as unknown as ProfileWindows;
        if (value.profileId !== id || value.instanceId !== status.instanceId || !Array.isArray(value.windows)) throw Error("The browser window inventory changed. Refresh the profile.");
        return { ...value, reason: value.reason ? redact(value.reason, 300) : null,
          windows: value.windows.map(window => ({ ...window, title: redact(window.title, 240),
            tabs: window.tabs.map(tab => ({ ...tab, title: redact(tab.title, 200), url: url(tab.url) })) })) };
      } catch (error) { return unavailable(redact((error as Error).message, 300)); }
    },
    async show(id, selection) {
      const result = await request(id, "window-show", selection);
      if (result.shown !== true) throw Error("The browser did not confirm the selected window.");
    },
  };
}
