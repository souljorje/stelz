export type Binding = { readonly profileId: string; readonly instanceId: string };
export type ControlTransport<B extends Binding> = {
  bind(profileId: string): Promise<B>;
  assertCurrent(binding: B): void;
  ended(binding: B): boolean;
  request(binding: B, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
};
type Lease<B> = {
  profileId: string;
  handle: string;
  controllerId: string;
  state: "pending" | "active" | "releasing" | "uncertain" | "released";
  binding?: B;
  pending?: Promise<unknown>;
  release?: Promise<{ profileId: string; released: true }>;
  operations: Set<Promise<unknown>>;
};

// A handle is a capability for one connection and one service lifetime. It is
// never used as the service controller credential and is never persisted.
export function createControlRegistry<B extends Binding>(transport: ControlTransport<B>) {
  const handles = new Map<string, Lease<B>>();
  const profiles = new Map<string, Lease<B>>();
  let closing = false, closed: Promise<void> | undefined;

  function assertOpen() {
    if (closing) throw Error("This MCP connection is closing.");
  }
  function find(profileId: string, handle: string) {
    const lease = handles.get(handle);
    if (!lease || lease.profileId !== profileId) throw Error("The controlHandle does not belong to this profile and connection.");
    return lease;
  }
  function envelope(lease: Lease<B>) {
    return { profileId: lease.profileId, instanceId: lease.binding!.instanceId, controllerId: lease.controllerId };
  }
  function finish(lease: Lease<B>) {
    lease.state = "released";
    if (profiles.get(lease.profileId) === lease) profiles.delete(lease.profileId);
    return { profileId: lease.profileId, released: true as const };
  }
  function detach(lease: Lease<B>): Promise<{ profileId: string; released: true }> {
    if (lease.state === "released") return Promise.resolve(finish(lease));
    if (lease.release) return lease.release;
    lease.state = "releasing"; // Close admission before waiting for outstanding work.
    lease.release = (async () => {
      await Promise.allSettled([...lease.operations]);
      if (lease.binding && !transport.ended(lease.binding)) {
        transport.assertCurrent(lease.binding);
        await transport.request(lease.binding, "release", envelope(lease));
      }
      return finish(lease);
    })().catch(() => {
      lease.state = "uncertain";
      throw Error("Controller cleanup is unconfirmed. Control remains unavailable. Inspect the profile with stelz doctor before operator release or recovery.");
    }).finally(() => { lease.release = undefined; });
    return lease.release;
  }

  async function acquire(profileId: string, label: string, signal?: AbortSignal): Promise<Record<string, unknown> & { controlHandle: string }> {
    assertOpen();
    signal?.throwIfAborted();
    const previous = profiles.get(profileId);
    if (previous) {
      // A proven exit retires the old capability locally. Never contact a
      // replacement service with an old controller credential.
      if (previous.state !== "pending" && previous.binding && transport.ended(previous.binding)) finish(previous);
      else if (previous.state === "uncertain" && !previous.pending) {
        await detach(previous);
        return acquire(profileId, label, signal);
      }
      else throw Error("This connection already has pending, active, or unconfirmed control of the profile. Release it first.");
    }
    const lease: Lease<B> = { profileId, handle: crypto.randomUUID(), controllerId: crypto.randomUUID(), state: "pending", operations: new Set() };
    profiles.set(profileId, lease); // Reserve before the first asynchronous step.
    const pending = (async () => {
      try {
        lease.binding = await transport.bind(profileId);
        if (closing) throw Error("This MCP connection is closing.");
        signal?.throwIfAborted();
        const status = await transport.request(lease.binding, "acquire", {
          profileId, instanceId: lease.binding.instanceId, id: lease.controllerId, pid: process.pid, label,
        });
        transport.assertCurrent(lease.binding);
        if (closing) throw Error("This MCP connection is closing.");
        signal?.throwIfAborted();
        lease.state = "active";
        handles.set(lease.handle, lease);
        return { ...status, controlHandle: lease.handle };
      } catch (error) {
        // Settle the acquire, then revoke its ID. The service remembers
        // revocation even if a request with an uncertain result arrives late.
        await detach(lease);
        throw error;
      }
    })();
    lease.pending = pending;
    try { return await pending; }
    finally { lease.pending = undefined; }
  }

  function run(profileId: string, handle: string, action: string, body: Record<string, unknown> = {}) {
    assertOpen();
    const lease = find(profileId, handle);
    if (lease.state !== "active") throw Error("This controlHandle is released, releasing, or unavailable. Acquire fresh control before browser actions.");
    try { transport.assertCurrent(lease.binding!); }
    catch (error) { lease.state = "uncertain"; throw error; }
    const operation = transport.request(lease.binding!, action, { ...body, ...envelope(lease) });
    lease.operations.add(operation);
    return operation.finally(() => { lease.operations.delete(operation); });
  }
  function release(profileId: string, handle: string) {
    assertOpen();
    return detach(find(profileId, handle));
  }
  function close() {
    closing = true;
    return closed ||= (async () => {
      const leases = [...profiles.values()];
      const results = await Promise.allSettled(leases.map(async lease => {
        if (lease.pending) await lease.pending.catch(() => {});
        await detach(lease);
      }));
      if (results.some(result => result.status === "rejected"))
        throw Error("Some controller cleanup is unconfirmed. Inspect the affected profiles with stelz doctor.");
    })();
  }
  return { acquire, run, release, close };
}
