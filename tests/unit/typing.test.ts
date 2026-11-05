import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseTypingMode, typeIntoLocator } from "../../packages/stelz/src/browser/typing.ts";

function field(tag = "input", type = "text") {
  let value = "old value", now = 0, call = 0;
  const events: Array<{ action: string; text?: string; ms?: number }> = [];
  const target = {
    evaluate: async () => ({ tag, type }),
    fill: async (text: string) => { events.push({ action: "fill", text }); value = text; },
    pressSequentially: async (text: string, options: { delay: number }) => {
      events.push({ action: "type", text, ms: options.delay }); value += text;
      now += options.delay * Array.from(text).length;
    },
  };
  const clock = {
    random: () => ((call++ * 17) % 29) / 29,
    now: () => now,
    sleep: async (ms: number) => { events.push({ action: "sleep", ms }); now += ms; },
  };
  return { target: target as unknown as Parameters<typeof typeIntoLocator>[0], raw: target, clock,
    events, value: () => value, advance: (ms: number) => { now += ms; } };
}

test("typing defaults to auto and rejects invalid settings", () => {
  expect(parseTypingMode()).toBe("auto");
  expect(parseTypingMode("auto")).toBe("auto");
  expect(parseTypingMode("paced")).toBe("auto");
  expect(parseTypingMode("keyboard")).toBe("keyboard");
  expect(parseTypingMode("instant")).toBe("instant");
  for (const value of ["", "fast", "PACED"]) expect(() => parseTypingMode(value)).toThrow("STELZ_TYPING_MODE");
});

test("paced input replaces existing text and preserves Unicode graphemes", async () => {
  const f = field(), text = "Cafe\u0301 👨‍👩‍👧‍👦 ქართული";
  await typeIntoLocator(f.target, text, "auto", f.clock);
  expect(f.value()).toBe(text);
  expect(f.events[0]).toEqual({ action: "fill", text: "" });
  const typed = f.events.filter(event => event.action === "type").map(event => event.text);
  expect(typed).toContain("e\u0301");
  expect(typed).toContain("👨‍👩‍👧‍👦");
  expect(typed.join("")).toBe(text);
});

test("typing varies key timing and pauses after punctuation", async () => {
  const f = field();
  await typeIntoLocator(f.target, "One. Two, three!", "auto", f.clock);
  const pauses = f.events.filter(event => event.action === "sleep").map(event => event.ms!);
  expect(new Set(pauses).size).toBeGreaterThan(3);
  expect(new Set(f.events.filter(event => event.action === "type").map(event => event.ms)).size).toBeGreaterThan(1);
  expect(pauses[3]).toBeGreaterThan(150);
  expect(pauses[8]).toBeGreaterThan(150);
  expect(f.clock.now()).toBeLessThan(10_000);
});

test("empty text clears the field without typing or pauses", async () => {
  const f = field();
  await typeIntoLocator(f.target, "", "auto", f.clock);
  expect(f.value()).toBe("");
  expect(f.events).toEqual([{ action: "fill", text: "" }]);
});

test("multiline and single-line fields retain native newline normalization", async () => {
  for (const [tag, expected] of [["textarea", "one\ntwo\nthree"], ["input", "onetwothree"]]) {
    const f = field(tag);
    await typeIntoLocator(f.target, "one\r\ntwo\rthree", "auto", f.clock);
    expect(f.value()).toBe(expected!);
  }
});

test("contenteditable and numeric fields use paced typing", async () => {
  for (const [tag, type, text] of [["div", "text", "two words"], ["input", "number", "12.5"]]) {
    const f = field(tag, type);
    await typeIntoLocator(f.target, text!, "auto", f.clock);
    expect(f.value()).toBe(text!);
    expect(f.events.some(event => event.action === "type")).toBe(true);
  }
});

test("specialized form controls and instant mode retain bulk fill", async () => {
  for (const type of ["date", "datetime-local", "month", "time", "week"]) {
    const f = field("input", type);
    await typeIntoLocator(f.target, "2026-11-03", "auto", f.clock);
    expect(f.events).toEqual([{ action: "fill", text: "2026-11-03" }]);
  }
  const f = field(), text = "x".repeat(10_000);
  f.raw.evaluate = async () => { throw Error("Instant mode must not inspect the field"); };
  await typeIntoLocator(f.target, text, "instant", f.clock);
  expect(f.value()).toBe(text);
  expect(f.events).toEqual([{ action: "fill", text }]);
});

test("long auto input selects bulk entry before clearing existing contents", async () => {
  const f = field();
  const text = "x".repeat(10_000);
  await typeIntoLocator(f.target, text, "auto", f.clock);
  expect(f.events).toEqual([{ action: "fill", text }]);
  expect(f.value()).toBe(text);
});

test("auto changes methods at the 10-second estimated threshold", async () => {
  for (const [length, paced] of [[208, true], [209, false]] as const) {
    const f = field(); f.clock.random = () => 0; // 15 ms hold + 33 ms pause per character.
    await typeIntoLocator(f.target, "x".repeat(length), "auto", f.clock);
    expect(f.events.filter(event => event.action === "type").length).toBe(paced ? length : 0);
    expect(f.value()).toBe("x".repeat(length));
  }
});

test("keyboard mode replaces long Unicode text with key events and no pacing", async () => {
  const f = field("textarea"), text = "Hello 👋 ქართული\n".repeat(500);
  f.clock.random = () => { throw Error("Keyboard mode must not generate pacing"); };
  await typeIntoLocator(f.target, text, "keyboard", f.clock);
  expect(f.events).toEqual([{ action: "fill", text: "" }, { action: "type", text, ms: 0 }]);
  expect(f.value()).toBe(text);
});

test("keyboard failures retain partial input without replay or bulk fallback", async () => {
  const f = field(), type = f.raw.pressSequentially;
  let attempts = 0;
  f.raw.pressSequentially = async (text, options) => {
    attempts++;
    await type(text.slice(0, 2), options);
    throw Error("Keyboard interrupted");
  };
  await expect(typeIntoLocator(f.target, "hello", "keyboard", f.clock)).rejects.toMatchObject({ code: "typing_incomplete" });
  expect(attempts).toBe(1);
  expect(f.value()).toBe("he");
  expect(f.events).toEqual([{ action: "fill", text: "" }, { action: "type", text: "he", ms: 0 }]);
});

test("partial typing failures never retry or fall back to bulk fill", async () => {
  const f = field(), type = f.raw.pressSequentially;
  f.raw.pressSequentially = async (text, options) => {
    if (text === "c") throw Error("Sensitive caller text must not appear in the error");
    await type(text, options);
  };
  await expect(typeIntoLocator(f.target, "abcd", "auto", f.clock)).rejects.toMatchObject({ code: "typing_incomplete", statusCode: 409 });
  expect(f.value()).toBe("ab");
  expect(f.events.filter(event => event.action === "fill")).toEqual([{ action: "fill", text: "" }]);
});

test("a typing deadline prevents further characters", async () => {
  const f = field(), type = f.raw.pressSequentially;
  f.raw.pressSequentially = async (text, options) => { await type(text, options); f.advance(45_000); };
  await expect(typeIntoLocator(f.target, "abcd", "auto", f.clock)).rejects.toMatchObject({ code: "typing_timeout" });
  expect(f.value()).toBe("a");
  expect(f.events.some(event => event.action === "sleep")).toBe(false);
});

test("service secrets select the typing mode and include overrides in the configuration hash", async () => {
  const home = mkdtempSync(join(tmpdir(), "stelz-typing-config-"));
  const script = `import { typingMode, configurationHash } from ${JSON.stringify(join(import.meta.dir, "../../packages/stelz/src/profiles/config.ts"))};
console.log(JSON.stringify({mode:typingMode(),hash:configurationHash({id:"typing",port:9479,mode:"direct"})}));`;
  const env: NodeJS.ProcessEnv = { ...process.env, STELZ_HOME: home };
  delete env.STELZ_TYPING_MODE;
  const read = async (override?: string) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
      env: { ...env, ...(override === undefined ? {} : { STELZ_TYPING_MODE: override }) }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code) throw Error(err);
    return JSON.parse(out) as { mode: string; hash: string };
  };
  try {
    const initial = await read();
    writeFileSync(join(home, "secrets.env"), "STELZ_TYPING_MODE=instant\n");
    const instant = await read();
    expect(instant.mode).toBe("instant");
    expect(instant.hash).not.toBe(initial.hash);
    expect(await read("auto")).toEqual(initial);
    await expect(read("typo")).rejects.toThrow("STELZ_TYPING_MODE");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
