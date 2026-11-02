import { alive } from "./config.ts";
export type Controller = { id: string; pid: number; label: string };
// Ownership lives in the browser service. Client processes do not own browser lifetime.
export function createControllerLease(isAlive: (pid: number) => boolean = alive) {
  let owner: Controller | undefined;
  let releasing = false;
  let active = 0;
  let tail: Promise<void> = Promise.resolve();

  function status() {
    return owner ? { ...owner, activeActions: active, releasing } : null;
  }

  function acquire(request: Controller) {
    if (!request.id || !Number.isInteger(request.pid) || request.pid < 1 || typeof request.label !== "string") {
      throw Error("Controller details are invalid.");
    }
    if (owner && !isAlive(owner.pid) && active === 0) {
      owner = undefined;
      releasing = false;
    }
    if (owner && (owner.id !== request.id || releasing)) {
      throw Error("Identity has an active controller. Release that controller first.");
    }
    owner = request;
    return { acquired: true, controller: status() };
  }

  async function run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!owner || owner.id !== id || releasing) throw Error("Acquire this identity before browser actions.");
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
    if (!owner) return { released: true };
    if (owner.id !== id) throw Error("This connection does not control the identity.");
    releasing = true;
    await tail;
    if (owner?.id === id) owner = undefined;
    releasing = false;
    return { released: true };
  }

  async function releaseCurrent() {
    return owner ? release(owner.id) : { released: true };
  }

  async function drain() {
    await tail;
  }

  return { status, acquire, run, runExclusive, release, releaseCurrent, drain };
}
