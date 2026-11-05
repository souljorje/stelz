import { readFileSync } from "node:fs";
import { existingProfilePath } from "./profile-compat.ts";
import { isTypingMode, parseTypingMode, type TypingMode } from "../browser/typing.ts";

// Resolve defaults inside the service action queue, including edits made while running.
export function profileTypingMode(home: string | undefined, id: string): TypingMode {
  const fallback = () => parseTypingMode(process.env.STELZ_TYPING_MODE);
  if (!home) return fallback();
  const file = existingProfilePath(home, "profiles.json", "identities.json");
  const catalog = JSON.parse(readFileSync(file, "utf8")) as { profiles?: Array<{ id: string; typingMode?: unknown }>; identities?: Array<{ id: string; typingMode?: unknown }> };
  const profile = (catalog.profiles ?? catalog.identities)?.find(item => item.id === id);
  if (!profile) throw Error("The selected profile is no longer configured.");
  if (profile.typingMode === undefined) return fallback();
  if (!isTypingMode(profile.typingMode)) throw Error("Typing mode must be auto, keyboard, or instant.");
  return profile.typingMode;
}
