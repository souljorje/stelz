import { setTimeout as delay } from "node:timers/promises";
import type { Locator } from "playwright-core";

export const TYPING_MODES = ["balanced", "keyboard", "instant"] as const;
export type TypingMode = typeof TYPING_MODES[number];
type Target = Pick<Locator, "evaluate" | "fill" | "pressSequentially" | "press">;
type Timing = { random(): number; now(): number; sleep(ms: number): Promise<void> };
const timing: Timing = { random: Math.random, now: () => performance.now(), sleep: async ms => { await delay(ms); } };
const textInputs = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter("en", { granularity: "word" });
const actionBudget = 45_000;
export const BALANCED_TYPING_BUDGET_MS = 10_000;

// Adjacent letter keys on a US QWERTY keyboard. Preserve the requested case.
const neighbors: Record<string, string> = {
  q: "wa", w: "qeas", e: "wrsd", r: "etdf", t: "ryfg", y: "tugh", u: "yihj", i: "uojk", o: "ipkl", p: "ol",
  a: "qwsz", s: "weadzx", d: "ersfxc", f: "rtdgcv", g: "tyfhvb", h: "yugjbn", j: "uihknm", k: "iojlm", l: "opk",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};
type Correction = { correct: string; typo: string };
type Step = { text: string; hold: number; gap: number } | { backspace: true; hold: number; gap: number } | { pause: number };

function corrections(value: string, clock: Timing): Map<number, Correction> {
  const plan = new Map<number, Correction>();
  const tokens = [...words.segment(value)].filter(word => word.isWordLike);
  if (tokens.length < 2) return plan;
  let previous = -16;
  for (const [index, word] of tokens.entries()) {
    const text = word.segment;
    if (index - previous < 16 || !/^[a-z]{4,}$/i.test(text) || /^([a-z])\1+$/i.test(text) || clock.random() >= 0.03) continue;
    const last = text.at(-1)!;
    const kind = Math.floor(clock.random() * 4);
    let correct = last, typo: string;
    if (kind === 0) {
      const adjacent = neighbors[last.toLowerCase()]!;
      typo = adjacent[Math.floor(clock.random() * adjacent.length)]!;
      if (last === last.toUpperCase()) typo = typo.toUpperCase();
    } else if (kind === 1) typo = last + last;
    else if (kind === 2) { correct = text.slice(-2); typo = last; }
    else typo = last === last.toLowerCase() ? last.toUpperCase() : last.toLowerCase();
    plan.set(word.index + text.length - correct.length, { correct, typo });
    previous = index;
  }
  return plan;
}

export function isTypingMode(value: unknown): value is TypingMode {
  return TYPING_MODES.includes(value as TypingMode);
}

export function parseTypingMode(value?: string): TypingMode {
  if (value === undefined) return "keyboard";
  if (isTypingMode(value)) return value;
  throw Error("STELZ_TYPING_MODE must be balanced, keyboard, or instant.");
}

function typingError(message: string, code: string, statusCode = 409) {
  return Object.assign(new Error(message), { code, statusCode });
}

// Called inside Camofox's existing tab lock. Never replay a partially typed value.
export async function typeIntoLocator(target: Target, text: string,
  mode: TypingMode = parseTypingMode(process.env.STELZ_TYPING_MODE), clock: Timing = timing) {
  if (!isTypingMode(mode)) throw Error("Typing mode must be balanced, keyboard, or instant.");
  if (mode === "instant") return target.fill(text, { timeout: 10_000 });
  const deadline = clock.now() + actionBudget;
  const remaining = () => {
    const ms = deadline - clock.now();
    if (ms <= 0) throw typingError("Typing timeout. Stop and start the profile before another browser action.", "typing_timeout");
    return Math.min(ms, 10_000);
  };
  const field = await target.evaluate(el => ({
    tag: el.tagName.toLowerCase(),
    type: (el.getAttribute("type") || "text").toLowerCase(),
  }), undefined, { timeout: remaining() });
  // Date and similar controls require Playwright's specialized fill behavior.
  if (field.tag === "input" && !textInputs.has(field.type)) return target.fill(text, { timeout: remaining() });
  // Match the native newline normalization performed by fill().
  const value = field.tag === "input" ? text.replace(/[\r\n]/g, "") : text.replace(/\r\n?/g, "\n");
  const base = 55 + clock.random() * 35;
  const editableText = field.tag !== "input" || ["text", "search"].includes(field.type);
  const mistakes = editableText ? corrections(value, clock) : new Map<number, Correction>();
  const plan: Step[] = [];
  let duration = 0;
  const append = (segment: string) => {
    const hold = Math.round(15 + clock.random() * 25);
    let gap = Math.round(base * (0.6 + clock.random() * 0.8));
    if (/[.!?,;:\n]$/u.test(segment)) gap += Math.round(120 + clock.random() * 180);
    else if (/\s$/u.test(segment) && clock.random() < 0.2) gap += Math.round(80 + clock.random() * 120);
    duration += hold * Array.from(segment).length + gap;
    plan.push({ text: segment, hold, gap });
  };
  const pause = (ms: number) => { plan.push({ pause: ms }); duration += ms; };
  let skipUntil = 0;
  for (const { segment, index } of segmenter.segment(value)) {
    if (index < skipUntil) continue;
    const mistake = mistakes.get(index);
    if (!mistake) append(segment);
    else {
      for (const letter of mistake.typo) append(letter);
      pause(Math.round(150 + clock.random() * 250));
      for (const _ of mistake.typo) {
        const hold = Math.round(15 + clock.random() * 25), gap = Math.round(base * (0.6 + clock.random() * 0.8));
        plan.push({ backspace: true, hold, gap }); duration += hold + gap;
      }
      pause(Math.round(80 + clock.random() * 170));
      for (const letter of mistake.correct) append(letter);
      skipUntil = index + mistake.correct.length;
    }
    // Select bulk entry before clearing the field. Never fall back after typing.
    if (mode === "balanced" && duration > BALANCED_TYPING_BUDGET_MS) return target.fill(text, { timeout: remaining() });
  }
  remaining();
  try {
    // Preserve replacement and empty-string semantics. This also checks editability.
    await target.fill("", { timeout: remaining() });
    for (const step of plan) {
      if ("backspace" in step) await target.press("Backspace", { delay: step.hold, timeout: remaining() });
      else if ("text" in step) await target.pressSequentially(step.text, { delay: step.hold, timeout: remaining() });
      const gap = "pause" in step ? step.pause : step.gap;
      if (gap >= remaining()) throw typingError("Typing timeout.", "typing_timeout");
      await clock.sleep(gap);
    }
    remaining();
  } catch (error) {
    if (/timeout|timed out/i.test((error as Error).message)) {
      throw typingError("Typing timeout. Input may be incomplete. Stop and start the profile before another browser action.", "typing_timeout");
    }
    throw typingError("Typing stopped. The field may contain incomplete text. Read a fresh snapshot before another action.", "typing_incomplete");
  }
}
