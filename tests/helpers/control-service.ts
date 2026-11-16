import type { Binding, ControlTransport } from "../../src/mcp/control-registry.ts";

export function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** A fake service for the control registry. It records each request and enforces one owner for each profile. */
export function service() {
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
