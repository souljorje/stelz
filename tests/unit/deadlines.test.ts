import { expect, test } from "bun:test";
import { ACTION_LIMIT_MS, SERVICE_DEADLINE_MS, TYPING_LIMIT_MS, actionLimit, replyTimeout, serviceDeadline } from "../../src/browser/deadlines.ts";

test("each layer waits longer than the layer that it calls", () => {
  expect(TYPING_LIMIT_MS).toBe(180_000);
  expect(actionLimit("camofox_type")).toBe(TYPING_LIMIT_MS);
  for (const tool of ["camofox_click", "camofox_navigate", "camofox_scroll", "camofox_snapshot", "camofox_screenshot"]) expect(actionLimit(tool)).toBe(ACTION_LIMIT_MS);
  for (const tool of ["camofox_type", "camofox_click"]) {
    expect(serviceDeadline(tool)).toBeGreaterThan(actionLimit(tool));
    expect(replyTimeout(tool)).toBeGreaterThan(serviceDeadline(tool));
  }
  expect(SERVICE_DEADLINE_MS).toBe(serviceDeadline("camofox_click"));
  // The Codex and Hermes examples allow 240 seconds for one tool call.
  expect(replyTimeout("camofox_type")).toBeLessThanOrEqual(240_000);
});
