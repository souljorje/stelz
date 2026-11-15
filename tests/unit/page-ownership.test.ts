import { expect, test } from "bun:test";
import * as ownership from "../../src/browser/page-ownership.ts";

// The plugin decides which pages the orphan page reaper may close. The patched server imports it.

test("the reaper closes only pages that Camofox owned and no longer tracks", () => {
  const managed = {}, dropped = {}, leased = {}, person = {};
  for (const page of [managed, dropped, leased]) expect(ownership.ownPage(page)).toBe(page);
  const registered = new Set([managed]);
  expect(ownership.isOrphanPage(dropped, registered, false)).toBe(true);
  expect(ownership.isOrphanPage(managed, registered, false)).toBe(false);
  expect(ownership.isOrphanPage(leased, registered, true)).toBe(false);
  // A tab that a person or a website opened is not registered, but it is not an orphan either.
  expect(ownership.isOrphanPage(person, registered, false)).toBe(false);
});
