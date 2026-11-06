import { alive } from "../profiles/config.ts";
import type { ControllerSummary } from "./control-protocol.ts";
export type Controller = { id: string; pid: number; label: string };
// Ownership lives in the browser service. Client processes do not own browser lifetime.
export function createControllerLease(isAlive: (pid: number) => boolean = alive) {
  let owner: Controller | undefined;
  let releasing = false;
  let active = 0;
  let tail: Promise<void> = Promise.resolve();
  const revoked = new Set<string>();
  const unsettled = new Set<Promise<unknown>>();

  function status(): ControllerSummary | null {
    return owner ? { pid: owner.pid, label: owner.label, activeActions: active + unsettled.size, releasing } : null;
  }

  function acquire(request: Controller) {
    if (typeof request.id !== "string" || !request.id || !Number.isSafeInteger(request.pid) || request.pid < 1 || typeof request.label !== "string") {
      throw Error("Controller details are invalid.");
    }
    if (revoked.has(request.id)) throw Error("This controller ID has been revoked. Acquire with a new ID.");
    if (owner?.id === request.id) throw Error("Profile has an active controller. Release that controller first.");
    if (owner && !releasing && active === 0 && unsettled.size === 0 && !isAlive(owner.pid)) {
      revoked.add(owner.id);
      owner = undefined;
    }
    if (owner) {
      throw Error("Profile has an active controller. Release that controller first.");
    }
    owner = { id: request.id, pid: request.pid, label: request.label };
    return { acquired: true, controller: status() };
  }

  function assertOwner(id: string) {
    if (!owner || owner.id !== id || releasing) throw Error("Acquire this profile before browser actions.");
  }

  async function run<T>(id: string, action: () => Promise<T>): Promise<T> {
    assertOwner(id);
    return runExclusive(action);
  }

  async function runExclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = tail;
    let finish!: () => void;
    tail = new Promise<void>(resolve => { finish = resolve; });
    active++;
    await previous;
    try { return await action(); }
    finally { active--; finish(); }
  }

  async function release(id: string) {
    if (typeof id !== "string" || !id) throw Error("Controller ID is invalid.");
    // Cleanup can arrive before acquire, or after another controller takes over.
    // Retire only this ID for the whole service lifetime.
    revoked.add(id);
    if (!owner || owner.id !== id) return { released: true };
    const previous = owner;
    releasing = true;
    await tail;
    await Promise.allSettled([...unsettled]);
    if (owner === previous) {
      owner = undefined;
      releasing = false;
    }
    return { released: true };
  }

  async function releaseCurrent() {
    return owner ? release(owner.id) : { released: true };
  }

  async function drain() {
    await tail;
  }

  function retain(work: Promise<unknown>) {
    unsettled.add(work);
    void work.then(() => unsettled.delete(work), () => unsettled.delete(work));
  }

  return { status, acquire, assertOwner, run, runExclusive, release, releaseCurrent, drain, retain };
}
