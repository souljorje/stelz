import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as guard from "../../src/browser/click-guard.ts";

// The plugin decides whether a failed click attempt may have reached the page. The patched server imports it.
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

function flow() {
  const state = {
    remaining: 28000, calls: [] as { timeout: number; force?: boolean }[], dom: 0, mouse: 0,
    click: async (_options: { timeout: number; force?: boolean }) => {},
    domClick: async () => {}, mouseClick: async () => {},
  };
  return Object.assign(state, {
    run: (forceFirst = false) => guard.clickWithFallback({
      click: async options => { state.calls.push(options); await state.click(options); },
      domClick: async () => { state.dom++; await state.domClick(); },
      mouseClick: async () => { state.mouse++; await state.mouseClick(); },
      remainingBudget: () => state.remaining, forceFirst,
    }),
  });
}

test("normal success sends one click, with five seconds reserved for fallback", async () => {
  const f = flow(); await f.run();
  expect(f.calls).toEqual([{ timeout: 23000 }]);
  expect([f.dom, f.mouse]).toEqual([0, 0]);
});

test("an obstruction followed by native dispatch never permits fallback", async () => {
  const f = flow();
  f.click = async () => { throw timeout("intercepts pointer events", "performing click action"); };
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 });
  expect(f.calls).toHaveLength(1); expect([f.dom, f.mouse]).toEqual([0, 0]);
});

for (const reason of ["intercepts pointer events", "not visible", "Timeout 23000ms exceeded"]) {
  test(`a pre-input failure permits one force click: ${reason}`, async () => {
    const f = flow();
    f.click = async options => { if (!options.force) { f.remaining = 5000; throw Error(reason); } };
    await f.run();
    expect(f.calls).toEqual([{ timeout: 23000 }, { timeout: 5000, force: true }]);
    expect([f.dom, f.mouse]).toEqual([0, 0]);
  });
}

for (const forceFirst of [false, true]) test(`an uncertain force click never permits DOM fallback (forceFirst=${forceFirst})`, async () => {
  const f = flow();
  f.click = async options => { throw options.force ? timeout("performing click action") : timeout("intercepts pointer events"); };
  await expect(f.run(forceFirst)).rejects.toMatchObject({ statusCode: 409 });
  expect(f.calls).toHaveLength(forceFirst ? 1 : 2); expect([f.dom, f.mouse]).toEqual([0, 0]);
});

test("a delayed normal completion never starts a second attempt", async () => {
  const f = flow(); let complete!: () => void;
  f.click = () => new Promise<void>(resolve => { complete = resolve; });
  const pending = f.run();
  f.remaining -= 4000; await Promise.resolve();
  expect(f.calls).toEqual([{ timeout: 23000 }]);
  complete(); await pending;
  expect(f.calls).toHaveLength(1); expect([f.dom, f.mouse]).toEqual([0, 0]);
});

for (const stage of ["normal", "force-first", "force", "dom", "mouse"]) test(`exhausted budget prevents the ${stage} attempt`, async () => {
  const f = flow();
  if (stage === "normal" || stage === "force-first") f.remaining = 0;
  f.click = async options => {
    if (stage === "force" || stage === "dom" && options.force) f.remaining = 0;
    throw timeout("intercepts pointer events");
  };
  f.domClick = async () => { f.remaining = 0; throw Error("Element is not an HTMLElement"); };
  await expect(f.run(stage === "force-first")).rejects.toThrow("Click budget exhausted");
  expect(f.calls).toHaveLength(stage === "normal" || stage === "force-first" ? 0 : stage === "force" ? 1 : 2);
  expect(f.dom).toBe(stage === "mouse" ? 1 : 0); expect(f.mouse).toBe(0);
});

test("an uncertain DOM click never permits a mouse fallback", async () => {
  const f = flow();
  f.click = async () => { throw Error("Element not visible"); };
  f.domClick = async () => { throw Error("Execution context was destroyed"); };
  await expect(f.run()).rejects.toMatchObject({ statusCode: 409 });
  expect(f.calls).toHaveLength(2); expect([f.dom, f.mouse]).toEqual([1, 0]);
});

test("only a DOM rejection before input permits the mouse fallback", async () => {
  const f = flow();
  f.click = async () => { throw Error("Element not visible"); };
  f.domClick = async () => { throw Error("Element is not an HTMLElement"); };
  await f.run();
  expect(f.calls).toHaveLength(2); expect([f.dom, f.mouse]).toEqual([1, 1]);
});

test("an unrelated normal click error is not retried", async () => {
  const f = flow(), error = Error("Invalid selector");
  f.click = async () => { throw error; };
  await expect(f.run()).rejects.toBe(error);
  expect(f.calls).toHaveLength(1); expect([f.dom, f.mouse]).toEqual([0, 0]);
});

test("a mouse fallback timeout after input is a non-retryable conflict", async () => {
  const f = flow(), cause = Error("native mouse up timed out after 100ms");
  f.click = async () => { throw Error("Element not visible"); };
  f.domClick = async () => { throw Error("Element is not an HTMLElement"); };
  f.mouseClick = async () => { throw cause; };
  const error = await f.run().then(() => { throw Error("Expected mouse failure"); }, error => error);
  expect(error.cause).toBe(cause);
  expect(errors.browserErrorStatus(error)).toBe(409);
  expect(errors.isRetryableBrowserError(error)).toBe(false);
  expect(errors.isTimeoutError(error)).toBe(false);
  expect(f.calls).toHaveLength(2); expect([f.dom, f.mouse]).toEqual([1, 1]);
});

// Execute the installed patch's actual sequence with synthetic browser methods. Do not start its server.
const server = readFileSync(new URL("../../node_modules/@askjo/camofox-browser/server.js", import.meta.url), "utf8");
const mouseStart = server.indexOf("const dispatchMouseSequence = async (locator) => {");
const mouseEnd = server.indexOf("// On Google SERPs", mouseStart);
if (mouseStart < 0 || mouseEnd < 0) throw Error("Missing patched mouse sequence");
const mouseSequence = new Function("tabState", "withTimeout", "remainingBudget", "log",
  server.slice(mouseStart, mouseEnd) + "return dispatchMouseSequence;");

function mouseFlow(expireAfter?: string, initialBudget = 1000) {
  let remaining = initialBudget, waits = 0;
  const calls: string[] = [], timeouts: { label: string; timeout: number }[] = [];
  const record = async (name: string) => { calls.push(name); if (expireAfter === name) remaining = 0; };
  const dispatch = mouseSequence({ page: {
    mouse: { move: () => record("move"), down: () => record("down"), up: () => record("up") },
    waitForTimeout: () => record(`wait-${++waits}`),
  } }, (operation: Promise<unknown>, timeout: number, label: string) => {
    timeouts.push({ label, timeout }); return operation;
  }, () => remaining, () => {});
  return { calls, timeouts, run: () => dispatch({ boundingBox: async ({ timeout }: { timeout: number }) => {
    expect(timeout).toBe(Math.min(3000, initialBudget)); await record("box");
    return { x: 0, y: 0, width: 10, height: 10 };
  } }) as Promise<void> };
}

for (const budget of [50, 5000]) test(`mouse fallback bounds the box and sends each native command once (${budget}ms)`, async () => {
  const f = mouseFlow(undefined, budget); await f.run();
  expect(f.calls).toEqual(["box", "move", "wait-1", "down", "wait-2", "up"]);
  expect(f.timeouts).toEqual(["native bounding box", "native mouse move", "native mouse down", "native mouse up"].map((label, index) => ({ label, timeout: index ? budget : Math.min(3000, budget) })));
});

for (const [after, expected] of [
  ["box", ["box"]],
  ["wait-1", ["box", "move", "wait-1"]],
  ["wait-2", ["box", "move", "wait-1", "down", "wait-2"]],
] as const) test(`budget exhaustion after ${after} prevents the next native command`, async () => {
  const f = mouseFlow(after);
  await expect(f.run()).rejects.toThrow("Click budget exhausted");
  expect(f.calls).toEqual([...expected]);
  expect(f.timeouts.every(entry => entry.timeout > 0)).toBe(true);
});

test("an exhausted mouse budget never invokes boundingBox", async () => {
  const f = mouseFlow(undefined, 0);
  await expect(f.run()).rejects.toThrow("no bounding box");
  expect(f.calls).toEqual([]); expect(f.timeouts).toEqual([]);
});
