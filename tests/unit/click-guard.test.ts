import { expect, test } from "bun:test";

// The patched upstream module decides whether a failed click attempt may have reached the page.
const guard = await import(new URL("../../node_modules/@askjo/camofox-browser/lib/stelz-click-guard.js", import.meta.url).href);
const errors = await import(new URL("../../node_modules/@askjo/camofox-browser/lib/browser-errors.js", import.meta.url).href);
// Playwright's call log, as a timed-out click reports it.
const timeout = (...steps: string[]) => Error(["locator.click: Timeout 3000ms exceeded.", "Call log:", "  - waiting for locator('#save')", ...steps].join("\n"));

test("only a click attempt that sent input counts as possibly delivered", () => {
  expect(guard.clickReachedPage(timeout("  - attempting click action", "    - waiting for element to be visible, enabled and stable"))).toBe(false);
  expect(guard.clickReachedPage(timeout("  - attempting click action", '    - <div class="overlay"></div> intercepts pointer events', "  - retrying click action"))).toBe(false);
  expect(guard.clickReachedPage(timeout("  - attempting click action", "    - element is visible, enabled and stable", "    - performing click action"))).toBe(true);
  expect(guard.clickReachedPage(undefined)).toBe(false);
});

test("only a DOM click that rejected the element before clicking may fall back to the mouse", () => {
  expect(guard.domClickRejected(Error("locator.evaluate: Error: Element is not an HTMLElement"))).toBe(true);
  expect(guard.domClickRejected(Error("locator.evaluate: Execution context was destroyed, most likely because of a navigation"))).toBe(false);
  expect(guard.domClickRejected(undefined)).toBe(false);
});

test("an uncertain click is a non-retryable conflict, not a timeout", () => {
  const cause = timeout("    - performing click action"), error = guard.uncertainClickError(cause);
  expect(error.message).toContain("Read a fresh snapshot");
  expect(error.cause).toBe(cause);
  expect(errors.browserErrorStatus(error)).toBe(409);
  expect(errors.isRetryableBrowserError(error)).toBe(false);
  expect(errors.isTimeoutError(error)).toBe(false);
  expect(errors.isElementInteractionError(error)).toBe(false);
});
