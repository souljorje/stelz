import { expect, test } from "bun:test";
import { createControlRegistry, type Binding, type ControlTransport } from "../../src/mcp/control-registry.ts";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function service() {
  const owners = new Map<string, string>(), lifetimes = new Map<string, string>();
  const revoked = new Set<string>(), sent: { binding: Binding; action: string; body: Record<string, unknown> }[] = [];
  let acquireGate: ReturnType<typeof deferred> | undefined;
  let workGate: ReturnType<typeof deferred> | undefined;
  let failRelease = false, loseAcquireResponse = false, recordChanged = false;
  const transport: ControlTransport<Binding> = {
    async bind(profileId) {
      if (!lifetimes.has(profileId)) lifetimes.set(profileId, crypto.randomUUID());
      return { profileId, instanceId: lifetimes.get(profileId)! };
    },
    assertCurrent(binding) {
      if (recordChanged || binding.instanceId !== lifetimes.get(binding.profileId)) throw Error("Recorded service changed.");
    },
    ended(binding) { return binding.instanceId !== lifetimes.get(binding.profileId); },
    async request(binding, action, body) {
      transport.assertCurrent(binding);
      sent.push({ binding, action, body });
      if (action === "acquire") {
        if (owners.has(binding.profileId) || revoked.has(String(body.id))) throw Error("Already controlled.");
        owners.set(binding.profileId, String(body.id));
        await acquireGate?.promise;
        if (loseAcquireResponse) throw Error("Lost acquire response.");
        return { acquired: true, profileId: binding.profileId, controller: { label: "test" } };
      }
      if (action === "release") {
        if (failRelease) throw Error("Release unavailable.");
        revoked.add(String(body.controllerId));
        if (owners.get(binding.profileId) === body.controllerId) owners.delete(binding.profileId);
        return { released: true };
      }
      if (owners.get(binding.profileId) !== body.controllerId) throw Error("Wrong controller.");
      await workGate?.promise;
      return { completed: true, profileId: binding.profileId };
    },
  };
  return { transport, owners, sent, revoked,
    blockAcquire() { return acquireGate = deferred(); },
    blockWork() { return workGate = deferred(); },
    failRelease(value: boolean) { failRelease = value; },
    loseAcquireResponse() { loseAcquireResponse = true; },
    changeRecord() { recordChanged = true; },
    restart(id: string) { lifetimes.set(id, crypto.randomUUID()); owners.delete(id); },
  };
}

test("handles route multiple profiles, use separate credentials, and reject mismatches before dispatch", async () => {
  const s = service(), registry = createControlRegistry(s.transport), foreign = createControlRegistry(s.transport);
  const a = await registry.acquire("alpha", "test"), b = await registry.acquire("beta", "test");
  expect(a.controlHandle).not.toBe(b.controlHandle);
  expect(a.controlHandle).not.toBe(s.owners.get("alpha"));
  const count = s.sent.length;
  expect(() => registry.run("beta", a.controlHandle, "tool")).toThrow("does not belong");
  expect(() => foreign.run("alpha", a.controlHandle, "tool")).toThrow("does not belong");
  expect(() => registry.run("alpha", "unknown", "tool")).toThrow("does not belong");
  expect(s.sent).toHaveLength(count);
  await registry.release("alpha", a.controlHandle);
  expect(await registry.run("beta", b.controlHandle, "tool")).toMatchObject({ profileId: "beta" });
  await registry.close();
  expect(s.owners.size).toBe(0);
});

test("same and separate connection acquisition races admit exactly one owner", async () => {
  const s = service(), registry = createControlRegistry(s.transport), other = createControlRegistry(s.transport);
  const gate = s.blockAcquire();
  const first = registry.acquire("alpha", "one");
  await expect(registry.acquire("alpha", "two")).rejects.toThrow("pending");
  await expect(other.acquire("alpha", "three")).rejects.toThrow("Already controlled");
  gate.resolve();
  const acquired = await first;
  expect(s.owners.size).toBe(1);
  await expect(registry.acquire("alpha", "one")).rejects.toThrow("active");
  await registry.release("alpha", acquired.controlHandle);
  await other.close(); await registry.close();
});

test("release blocks new actions and resume immediately, waits for admitted actions, and keeps tombstones", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  const { controlHandle } = await registry.acquire("alpha", "test"), gate = s.blockWork();
  const action = registry.run("alpha", controlHandle, "tool");
  let finished = false;
  const release = registry.release("alpha", controlHandle).then(() => { finished = true; });
  expect(() => registry.run("alpha", controlHandle, "resume")).toThrow("releasing");
  expect(() => registry.run("alpha", controlHandle, "pause")).toThrow("releasing");
  await Promise.resolve(); expect(finished).toBe(false);
  gate.resolve(); await action; await release;
  const next = await registry.acquire("alpha", "next");
  const owner = s.owners.get("alpha"), count = s.sent.length;
  expect(await registry.release("alpha", controlHandle)).toMatchObject({ released: true });
  expect(s.sent).toHaveLength(count); expect(s.owners.get("alpha")).toBe(owner);
  expect(next.controlHandle).not.toBe(controlHandle);
  await registry.close();
});

test("cancellation and shutdown settle a pending acquire and reconcile the service owner", async () => {
  for (const cancel of [true, false]) {
    const s = service(), registry = createControlRegistry(s.transport), gate = s.blockAcquire(), controller = new AbortController();
    const acquisition = registry.acquire("alpha", "test", controller.signal);
    const rejected = acquisition.then(() => undefined, error => error);
    await Promise.resolve();
    expect(s.owners.has("alpha")).toBe(true);
    if (cancel) controller.abort();
    const closing = registry.close();
    await expect(registry.acquire("beta", "test")).rejects.toThrow("closing");
    gate.resolve(); expect(await rejected).toBeInstanceOf(Error); await closing;
    expect(s.owners.size).toBe(0); expect(s.revoked.size).toBe(1);
  }
});

test("lost acquire response triggers cleanup without releasing another controller", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  s.loseAcquireResponse();
  await expect(registry.acquire("alpha", "test")).rejects.toThrow("Lost acquire response");
  expect(s.owners.size).toBe(0);
  expect(s.revoked.size).toBe(1);
  await registry.close();
});

test("uncertain cleanup blocks reacquisition until it succeeds", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  const { controlHandle } = await registry.acquire("alpha", "test");
  s.failRelease(true);
  await expect(registry.release("alpha", controlHandle)).rejects.toThrow("unconfirmed");
  expect(() => registry.run("alpha", controlHandle, "tool")).toThrow("unavailable");
  await expect(registry.acquire("alpha", "test")).rejects.toThrow("unconfirmed");
  s.failRelease(false);
  await registry.release("alpha", controlHandle);
  await registry.acquire("alpha", "next"); await registry.close();
});

test("restart and port reuse retire old handles without dispatching to the new lifetime", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  const old = await registry.acquire("alpha", "test");
  s.restart("alpha");
  expect(() => registry.run("alpha", old.controlHandle, "tool")).toThrow("changed");
  const next = await registry.acquire("alpha", "next");
  const count = s.sent.length, owner = s.owners.get("alpha");
  await registry.release("alpha", old.controlHandle);
  expect(s.sent).toHaveLength(count); expect(s.owners.get("alpha")).toBe(owner);
  expect(await registry.run("alpha", next.controlHandle, "tool")).toMatchObject({ completed: true });
  await registry.close();
});

test("a changed record with a live original service remains unavailable instead of redirecting", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  const old = await registry.acquire("alpha", "test"); s.changeRecord();
  const count = s.sent.length;
  expect(() => registry.run("alpha", old.controlHandle, "tool")).toThrow("changed");
  await expect(registry.release("alpha", old.controlHandle)).rejects.toThrow("unconfirmed");
  await expect(registry.acquire("alpha", "new")).rejects.toThrow("unconfirmed");
  await expect(registry.close()).rejects.toThrow("unconfirmed");
  expect(s.sent).toHaveLength(count);
});

test("operator handoff prevents old operations and old release preserves the next owner", async () => {
  const s = service(), registry = createControlRegistry(s.transport), next = createControlRegistry(s.transport);
  const old = await registry.acquire("alpha", "test"); s.owners.delete("alpha");
  const acquired = await next.acquire("alpha", "next");
  await expect(registry.run("alpha", old.controlHandle, "tool")).rejects.toThrow("Wrong controller");
  await registry.release("alpha", old.controlHandle);
  expect(await next.run("alpha", acquired.controlHandle, "tool")).toMatchObject({ completed: true });
  await registry.close(); await next.close();
});

test("a busy profile does not block actions or release on another profile", async () => {
  const s = service(), registry = createControlRegistry(s.transport), gate = s.blockWork();
  const a = await registry.acquire("alpha", "test"), b = await registry.acquire("beta", "test");
  const action = registry.run("alpha", a.controlHandle, "tool");
  expect(await registry.release("beta", b.controlHandle)).toMatchObject({ released: true });
  expect(s.owners.has("alpha")).toBe(true);
  gate.resolve(); await action; await registry.close();
});

test("disconnect releases idle profiles while another acquisition is pending", async () => {
  const s = service(), registry = createControlRegistry(s.transport);
  await registry.acquire("alpha", "test");
  const gate = s.blockAcquire();
  const pending = registry.acquire("beta", "test").catch(error => error);
  await Promise.resolve();
  const closing = registry.close();
  for (let i = 0; i < 10 && s.owners.has("alpha"); i++) await Promise.resolve();
  expect(s.owners.has("alpha")).toBe(false);
  expect(s.owners.has("beta")).toBe(true);
  gate.resolve(); await pending; await closing;
  expect(s.owners.size).toBe(0);
});
