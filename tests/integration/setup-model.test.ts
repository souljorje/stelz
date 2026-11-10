import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareModel } from "../../src/browser/setup.ts";
import { isPreparedModel } from "../../src/browser/camoufox.ts";
import { fixtureModel } from "../helpers/geoip-fixture.ts";

test("setup copies a prepared model repeatedly without network access or changes to the current model", async () => {
  const root = mkdtempSync(join(tmpdir(), "stelz-setup-model-")), current = join(root, "current");
  fixtureModel(join(current, "fpgen"));
  const snapshot = () => Object.fromEntries(readdirSync(join(current, "fpgen")).sort()
    .map(name => [name, readFileSync(join(current, "fpgen", name)).toString("base64")]));
  const before = snapshot(), request = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = Object.assign(async () => { requests++; throw Error("Offline fixture"); }, { preconnect: request.preconnect });
  try {
    for (const name of ["first", "repeated"]) {
      const stage = join(root, name); mkdirSync(stage);
      await prepareModel(stage, current);
      expect(isPreparedModel(join(stage, "fpgen"))).toBe(true);
      expect(readFileSync(join(stage, "fpgen/values.dat"), "utf8")).toBe("{}");
      expect(snapshot()).toEqual(before);
    }
    expect(requests).toBe(0);
  } finally { globalThis.fetch = request; rmSync(root, { recursive: true, force: true }); }
});
