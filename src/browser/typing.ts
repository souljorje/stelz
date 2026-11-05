import { setTimeout as delay } from "node:timers/promises";
import type { Locator } from "playwright-core";

export const TYPING_MODES = ["auto", "keyboard", "instant"] as const;
export type TypingMode = typeof TYPING_MODES[number];
type Target = Pick<Locator, "evaluate" | "fill" | "pressSequentially">;
type Timing = { random(): number; now(): number; sleep(ms: number): Promise<void> };
const timing: Timing = { random: Math.random, now: () => performance.now(), sleep: async ms => { await delay(ms); } };
const textInputs = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const actionBudget = 45_000;
export const AUTO_TYPING_BUDGET_MS = 10_000;

export function isTypingMode(value: unknown): value is TypingMode {
  return TYPING_MODES.includes(value as TypingMode);
}

export function parseTypingMode(value?: string): TypingMode {
  // Preserve old service settings without retaining their long-text rejection.
  if (value === undefined || value === "paced") return "auto";
  if (isTypingMode(value)) return value;
  throw Error("STELZ_TYPING_MODE must be auto, keyboard, or instant.");
}

function typingError(message: string, code: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Called inside Camofox's existing tab lock. Never replay a partially typed value.
export async function typeIntoLocator(target: Target, text: string,
  mode: TypingMode = parseTypingMode(process.env.STELZ_TYPING_MODE), clock: Timing = timing) {
  if (!isTypingMode(mode)) throw Error("Typing mode must be auto, keyboard, or instant.");
  if (mode === "instant") return target.fill(text, { timeout: 10_000 });
  const deadline = clock.now() + actionBudget;
  const remaining = (cap = 10_000) => {
    const ms = deadline - clock.now();
    if (ms <= 0) throw typingError("Typing timeout. Stop and start the profile before another browser action.", "typing_timeout");
    return Math.min(ms, cap);
  };
  const field = await target.evaluate(el => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "text").toLowerCase(),
  }), undefined, { timeout: remaining() });
  // Date and similar controls require Playwright's specialized fill behavior.
  if (field.tag === "input" && !textInputs.has(field.type)) return target.fill(text, { timeout: remaining() });
  // Match the native newline normalization performed by fill().
  const value = field.tag === "input" ? text.replace(/[\r\n]/g, "") : text.replace(/\r\n?/g, "\n");
  const base = mode === "auto" ? 55 + clock.random() * 35 : 0;
  const plan: Array<{ text: string; hold: number; gap: number }> = [];
  let duration = 0;
  for (const { segment } of mode === "auto" ? segmenter.segment(value) : []) {
    const hold = Math.round(15 + clock.random() * 25);
    let gap = Math.round(base * (0.6 + clock.random() * 0.8));
    if (/[.!?,;:\n]$/u.test(segment)) gap += Math.round(120 + clock.random() * 180);
    else if (/\s$/u.test(segment) && clock.random() < 0.2) gap += Math.round(80 + clock.random() * 120);
    duration += hold * Array.from(segment).length + gap;
    // Select bulk entry before clearing the field. Never fall back after typing.
    if (duration > AUTO_TYPING_BUDGET_MS) return target.fill(text, { timeout: remaining() });
    plan.push({ text: segment, hold, gap });
  }
  remaining();
  try {
    // Preserve replacement and empty-string semantics. This also checks editability.
    await target.fill("", { timeout: remaining() });
    if (mode === "keyboard") {
      await target.pressSequentially(value, { delay: 0, timeout: remaining(actionBudget) });
      remaining();
      return;
    }
    for (const step of plan) {
      await target.pressSequentially(step.text, { delay: step.hold, timeout: remaining() });
      if (step.gap >= remaining()) throw typingError("Typing timeout.", "typing_timeout");
      await clock.sleep(step.gap);
    }
    remaining();
  } catch (error) {
    if (/timeout|timed out/i.test((error as Error).message)) {
      throw typingError("Typing timeout. Input may be incomplete. Stop and start the profile before another browser action.", "typing_timeout");
    }
    throw typingError("Typing stopped. The field may contain incomplete text. Read a fresh snapshot before another action.", "typing_incomplete");
  }
}
