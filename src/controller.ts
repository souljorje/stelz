import { alive } from "./config.ts";
export type Controller = { id: string; pid: number; label: string };
// Ownership lives in the browser service. Client processes do not own browser lifetime.
export class ControllerLease {
  private owner?: Controller;
  private releasing = false;
  private active = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private isAlive: (pid: number) => boolean = alive) {}
  status() { return this.owner ? { ...this.owner, activeActions: this.active, releasing: this.releasing } : null; }
  acquire(request: Controller) {
    if (!request.id || !Number.isInteger(request.pid) || request.pid < 1 || typeof request.label !== "string") throw Error("Controller details are invalid.");
    if (this.owner && !this.isAlive(this.owner.pid) && this.active === 0) { this.owner = undefined; this.releasing = false; }
    if (this.owner && (this.owner.id !== request.id || this.releasing)) throw Error("Identity has an active controller. Release that controller first.");
    this.owner = request;
    return { acquired: true, controller: this.status() };
  }
  async run<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!this.owner || this.owner.id !== id || this.releasing) throw Error("Acquire this identity before browser actions.");
    const previous = this.tail;
    let finish!: () => void;
    this.tail = new Promise<void>(resolve => { finish = resolve; });
    this.active++;
    await previous;
    try { return await action(); }
    finally { this.active--; finish(); }
  }
  async release(id: string) {
    if (!this.owner) return { released: true };
    if (this.owner.id !== id) throw Error("This connection does not control the identity.");
    this.releasing = true;
    await this.tail;
    if (this.owner?.id === id) this.owner = undefined;
    this.releasing = false;
    return { released: true };
  }
  async releaseCurrent() { return this.owner ? this.release(this.owner.id) : { released: true }; }
  async drain() { await this.tail; }
}
