import { expect, test } from "bun:test";
import { identityKey, readTab, TAB_STATE_CHANGED } from "../../src/browser/tab-state.ts";

const tabId = "79bed5c4-d5b8-4369-9d13-b159451ece91";
const entry = { role: "button", name: "Save", nth: 0 };
const state = (tab: unknown = { refs: new Map([["e1", entry]]), lastSnapshot: "- button \"Save\" [e1]" }) =>
  new Map([["profile-01", { tabGroups: new Map([["default", new Map([[tabId, tab]])]]) }]]);

test("a tab gives the identity key of each ref and its last snapshot", () => {
  const tab = readTab(state(), "profile-01", tabId)!;
  expect([...tab.refs]).toEqual([["e1", identityKey(entry)]]);
  expect(tab.lastSnapshot).toBe('- button "Save" [e1]');
  // The frame of a ref in an iframe is part of its identity.
  expect(identityKey({ ...entry, frameName: "payment", frameUrl: "https://pay.test/" })).not.toBe(identityKey(entry));
  expect(identityKey({ ...entry, frameName: null })).toBe(identityKey(entry));
  expect(identityKey({ ...entry, nth: 1 })).not.toBe(identityKey(entry));
});

test("a missing session or tab is not an error", () => {
  expect(readTab(new Map(), "profile-01", tabId)).toBeUndefined();
  expect(readTab(state(), "profile-01", "another")).toBeUndefined();
  expect(readTab(state(), "profile-02", tabId)).toBeUndefined();
});

test("a changed structure fails closed with one message", () => {
  const broken: unknown[] = [
    undefined, null, {}, [], "sessions",
    new Map([["profile-01", null]]),
    new Map([["profile-01", {}]]),
    new Map([["profile-01", { tabGroups: {} }]]),
    new Map([["profile-01", { tabGroups: new Map([["default", {}]]) }]]),
    new Map([["profile-01", { tabGroups: new Map([["default", new Map([[tabId, null]])]]) }]]),
    state({ lastSnapshot: "" }),
    state({ refs: {} }),
    state({ refs: [["e1", entry]] }),
    state({ refs: new Map([[1, entry]]) }),
    state({ refs: new Map([["e1", null]]) }),
    state({ refs: new Map([["e1", { ...entry, role: 1 }]]) }),
    state({ refs: new Map([["e1", { ...entry, name: undefined }]]) }),
    state({ refs: new Map([["e1", { ...entry, nth: "0" }]]) }),
    state({ refs: new Map([["e1", { ...entry, nth: 0.5 }]]) }),
    state({ refs: new Map([["e1", { ...entry, frameName: 3 }]]) }),
    state({ refs: new Map([["e1", { ...entry, frameUrl: {} }]]) }),
  ];
  for (const value of broken) expect(() => readTab(value, "profile-01", tabId), JSON.stringify(value)).toThrow(TAB_STATE_CHANGED);
  expect(TAB_STATE_CHANGED).toContain("Update Stelz");
});

test("a tab with no snapshot is readable, and its last snapshot is not a string", () => {
  const tab = readTab(state({ refs: new Map(), lastSnapshot: null }), "profile-01", tabId)!;
  expect(tab.refs.size).toBe(0);
  expect(tab.lastSnapshot).toBeNull();
});
