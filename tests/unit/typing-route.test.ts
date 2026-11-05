import { expect, test } from "bun:test";
import { upstreamTyping } from "../helpers/upstream-typing.ts";

test("Stelz typing retains its upstream tab lock beyond the handler deadline", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const entered: string[] = [];
  const route = upstreamTyping(async text => { entered.push(text); if (text === "first") await gate; });
  let replied = false;
  const first = route.call({ text: "first", typingMode: "keyboard", pressEnter: true }).then(response => { replied = true; return response; });
  try {
    await route.advance(0);
    await route.advance(30_001);
    expect(replied).toBe(false);
    const second = route.call({ text: "second", typingMode: "instant" });
    await route.advance(0);
    expect(entered).toEqual(["first"]);
    expect(route.events).toEqual([]);
    finish();
    expect(await first).toEqual({ code: 200, payload: { ok: true } });
    expect(await second).toEqual({ code: 200, payload: { ok: true } });
    expect(entered).toEqual(["first", "second"]);
    expect(route.events).toEqual(["Enter"]);
    expect(route.refreshes()).toBe(0);
  } finally { finish(); await first; }
});

test("Stelz typing timeouts remain terminal and cannot submit or request a retry", async () => {
  const route = upstreamTyping(async () => { throw Error("Keyboard timed out after 45000ms"); });
  const response = await route.call({ typingMode: "keyboard", pressEnter: true });
  expect(response.code).toBe(409);
  expect(response.payload).toMatchObject({ code: "typing_timeout", retryable: false });
  expect(response.payload.error).toContain("Stop and start");
  expect(response.payload.recovery).toBeUndefined();
  expect(route.events).toEqual([]);
  expect(route.refreshes()).toBe(0);
});

test("ordinary upstream typing keeps its original handler deadline", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const route = upstreamTyping(() => gate);
  const action = route.call();
  try {
    await route.advance(0);
    await route.advance(30_001);
    expect((await action).payload.code).toBe("page_changed");
  } finally { finish(); }
});
