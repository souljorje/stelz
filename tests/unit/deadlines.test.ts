import { expect, test } from "bun:test";
import { ACTION_LIMIT_MS, EVALUATE_MAX_MS, OBSERVE_LIMIT_MS, SERVICE_DEADLINE_MS, TYPING_LIMIT_MS, WAIT_MAX_MS, replyTimeout, serviceDeadline } from "../../src/browser/deadlines.ts";
import { deadline, entries } from "../../src/browser/catalog.ts";

test("each layer waits longer than the layer that it calls", () => {
  expect(TYPING_LIMIT_MS).toBe(180_000);
  expect(deadline("tab_type", { observe: "none" })).toBe(TYPING_LIMIT_MS);
  for (const tool of ["tab_navigate", "tab_scroll", "tab_snapshot", "tab_screenshot"]) expect(deadline(tool, {})).toBe(ACTION_LIMIT_MS);
  for (const tool of ["tab_click", "tab_press", "tab_select"]) expect(deadline(tool, {})).toBe(ACTION_LIMIT_MS + OBSERVE_LIMIT_MS);
  for (const [tool, args] of [["tab_type", {}], ["tab_click", {}], ["tab_wait", { timeout: WAIT_MAX_MS }], ["tab_wait", { timeout: WAIT_MAX_MS, contains: "x" }],
    ["tab_evaluate", { timeoutMs: EVALUATE_MAX_MS }]] as const) {
    const limit = deadline(tool, args);
    expect(serviceDeadline(limit), tool).toBeGreaterThan(limit);
    expect(replyTimeout(limit), tool).toBeGreaterThan(serviceDeadline(limit));
  }
  expect(SERVICE_DEADLINE_MS).toBe(serviceDeadline(ACTION_LIMIT_MS));
});

test("no call waits longer than the 240 seconds that the client examples allow", () => {
  // The Codex and Hermes examples allow 240 seconds for one tool call.
  for (const item of entries) for (const extra of [{}, { target: { role: "button", name: "Save" } }, { observe: "diff" }])
    expect(replyTimeout(item.deadline({ timeout: 1e12, timeoutMs: 1e12, ...extra })), item.name).toBeLessThanOrEqual(240_000);
});
