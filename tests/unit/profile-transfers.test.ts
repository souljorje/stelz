import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfileTransferManager } from "../../packages/stelz/src/api/profile-transfers.ts";
import { createUiApp, createUiSessionState } from "../../packages/stelz/src/api/ui-app.ts";
import type { UiModel } from "../../packages/stelz/src/api/contracts.ts";
import type { ProfileArchiveManifest } from "../../packages/stelz/src/profiles/profile-transfer-types.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const manifest: ProfileArchiveManifest = { format: "stelz-profiles", version: 1, createdAt: new Date().toISOString(),
  source: { stelzVersion: "test", platform: process.platform, arch: process.arch, engineSha256: "a".repeat(64) },
  profiles: [{ id: "work", storage: "native", proxy: { url: "http://private-user:private-password@proxy.test:8080" } }], directories: ["profiles", "profiles/work"], files: [] };
const preview = { revision: "b".repeat(64), source: manifest.source, compatible: true, issues: [],
  profiles: [{ sourceId: "work", id: "work-copy", name: "work-copy", storage: "native" as const, proxyDisplay: "http://proxy.test:8080", proxyUnavailable: false, issues: [] }] };
async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 1000; n++) { if (predicate()) return; await Bun.sleep(1); }
  throw Error("Transfer did not reach the expected phase.");
}
async function fixture(exportGate: Promise<void> = Promise.resolve()) {
  const directory = await mkdtemp(join(tmpdir(), "stelz-transfer-api-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const state = createUiSessionState(), uploads: string[] = [];
  const manager = createProfileTransferManager({ directory,
    busy: delta => { state.activeMutations += delta; },
    reserve: ids => { if (ids.some(id => state.pending.has(id))) throw Object.assign(Error("Busy profile"), { status: 409 }); for (const id of ids) state.pending.set(id, "export"); },
    release: ids => { for (const id of ids) state.pending.delete(id); },
    operations: {
      async export(input) { await exportGate; input.signal?.throwIfAborted(); input.onPhase?.("packing"); await writeFile(input.outputFile, "PKsyntheticZIP"); return manifest; },
      async read(input) { uploads.push(await readFile(input.archiveFile, "utf8")); input.signal?.throwIfAborted(); return manifest; },
      async inspect() { return preview; },
      async import(input) { return { profiles: input.profiles.map(p => ({ sourceId: p.sourceId, id: p.id, name: p.name ?? p.id })) }; },
    },
  });
  cleanups.push(() => manager.dispose());
  const app = createUiApp({ assets: {}, model: {} as UiModel, sessionState: state, transfers: manager });
  const origin = "http://127.0.0.1:9380";
  const request = (path: string, init: RequestInit = {}, auth = true) => app.fetch(new Request(origin + path, {
    ...init, headers: { Host: "127.0.0.1:9380", Origin: origin, "Content-Type": "application/json", ...(auth ? { Cookie: `stelz_ui_9380=${state.session}` } : {}), ...init.headers },
  }), { origin });
  return { manager, state, request, uploads, directory };
}

test("transfer routes preserve session/origin checks and expose only sanitized import previews", async () => {
  const f = await fixture();
  const create = { method: "POST", body: JSON.stringify({ kind: "import" }) };
  expect((await f.request("/api/profile-transfers", create, false)).status).toBe(401);
  expect((await f.request("/api/profile-transfers", { ...create, headers: { Origin: "https://foreign.test" } })).status).toBe(403);
  const response = await f.request("/api/profile-transfers", create);
  expect(response.status).toBe(202);
  const { transfer } = await response.json(), path = `/api/profile-transfers/${transfer.id}`;
  expect((await f.request(path + "/archive", { method: "PUT", headers: { "Content-Type": "text/plain" }, body: "PKfile" })).status).toBe(415);
  expect((await f.request(path + "/archive", { method: "PUT", headers: { "Content-Type": "application/zip" }, body: "PKfile" }, false)).status).toBe(401);
  expect((await f.request(path + "/archive", { method: "PUT", headers: { "Content-Type": "application/zip" }, body: "PKfile" })).status).toBe(202);
  await waitFor(() => f.manager.status(transfer.id).phase === "ready");
  const status = await (await f.request(path)).json();
  expect(status.transfer.preview.profiles[0]).toMatchObject({ id: "work-copy", proxyDisplay: "http://proxy.test:8080" });
  expect(JSON.stringify(status)).not.toMatch(/private-user|private-password/);
  expect(f.uploads).toEqual(["PKfile"]);
  const commit = await f.request(path + "/import", { method: "POST", body: JSON.stringify({ revision: preview.revision, profiles: [{ sourceId: "work", id: "work-copy", name: "Copy" }] }) });
  expect(commit.status).toBe(202);
  await waitFor(() => f.manager.status(transfer.id).phase === "complete");
  expect(f.manager.status(transfer.id).result?.profiles).toEqual([{ sourceId: "work", id: "work-copy", name: "Copy" }]);
  expect(f.state.activeMutations).toBe(0);
});

test("export reserves selected profiles and prevents shutdown until the native download completes", async () => {
  let complete!: () => void;
  const gate = new Promise<void>(resolve => { complete = resolve; });
  const f = await fixture(gate);
  const response = await f.request("/api/profile-transfers", { method: "POST", body: JSON.stringify({ kind: "export", profileIds: ["work"] }) });
  const { transfer } = await response.json();
  expect(f.state.pending.get("work")).toBe("export");
  expect((await f.request("/api/shutdown", { method: "POST", body: "{}" })).status).toBe(409);
  const second = await f.request("/api/profile-transfers", { method: "POST", body: JSON.stringify({ kind: "import" }) });
  expect(second.status).toBe(409);
  complete();
  await waitFor(() => f.manager.status(transfer.id).phase === "ready");
  expect(f.state.pending.size).toBe(0);
  const download = await f.request(`/api/profile-transfers/${transfer.id}/download`);
  expect(download.headers.get("content-type")).toBe("application/zip");
  expect(download.headers.get("content-disposition")).toContain(".stelz-profiles.zip");
  expect(await download.text()).toBe("PKsyntheticZIP");
  await waitFor(() => f.state.activeMutations === 0);
  expect((await f.request("/api/shutdown", { method: "POST", body: "{}" })).status).toBe(200);
});

test("cancellation discards staged uploads and concurrent create requests cannot start two jobs", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.manager.create({ kind: "import" }), f.manager.create({ kind: "import" }).catch(e => e)]);
  const job = responses.find(r => r.id), error = responses.find(r => r.status === 409);
  expect(job).toBeDefined(); expect(error).toBeDefined();
  expect((await f.manager.cancel(job.id)).phase).toBe("cancelled");
  expect(f.state.activeMutations).toBe(0);
  expect(await Bun.file(join(f.directory, job.id, ".transfer.json")).exists()).toBe(false);
});
