import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTypingMode, parseTypingMode, type TypingMode } from "../browser/typing.ts";

// Resolve defaults inside the service action queue, including edits made while running.
export function profileTypingMode(home: string | undefined, id: string): TypingMode {
  const fallback = () => parseTypingMode(process.env.STELZ_TYPING_MODE);
  if (!home) return fallback();
  const catalog = JSON.parse(readFileSync(join(home, "profiles.json"), "utf8")) as { profiles: Array<{ id: string; typingMode?: unknown }> };
  const profile = catalog.profiles.find(item => item.id === id);
  if (!profile) throw Error("The selected profile is no longer configured.");
  if (profile.typingMode === undefined) return fallback();
  if (!isTypingMode(profile.typingMode)) throw Error("Typing mode must be balanced, keyboard, or instant.");
  return profile.typingMode;
}
