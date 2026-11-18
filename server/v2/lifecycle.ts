/** Run intent and shutdown phase are separate; an interruption is a shared drain barrier. */
export class RuntimeLifecycle {
  private mode: 'stopped' | 'running' | 'held' = 'stopped';
  private phase: 'open' | 'draining' | 'closed' = 'open';
  private interruption?: Promise<void>;
  private cancellation?: Promise<void>;
  private barriers = 0;
  private readonly mutations = new Set<Promise<unknown>>();
  constructor(private readonly changed: () => void = () => {}) {}

  get closed(): boolean { return this.phase === 'closed'; }
  get shuttingDown(): boolean { return this.phase !== 'open'; }
  get canAcceptRequest(): boolean { return this.phase === 'open' && !this.interruption && !this.cancellation && this.barriers === 0; }
  get canDispatch(): boolean { return this.canAcceptRequest && this.mode === 'running'; }
  start(): boolean {
    if (this.phase !== 'open' || this.cancellation) return false;
    // An owner edit may delay dispatch, but the explicit run intent still applies after it.
    this.mode = 'running'; this.changed(); return true;
  }
  request(): boolean {
    if (!this.canAcceptRequest) return false;
    if (this.mode === 'held') this.mode = 'running';
    return true;
  }
  stop(): void { this.mode = 'stopped'; this.changed(); }
  beginShutdown(): void { this.phase = 'draining'; this.stop(); }
  close(): void { this.phase = 'closed'; this.stop(); }
  interrupt(drain: () => Promise<void>): Promise<void> {
    if (this.mode === 'running') this.mode = 'held';
    if (this.cancellation) return this.cancellation;
    // Release the run drain before waiting for owner writes: an already accepted
    // write may itself be awaiting that drain. Keeping both in one barrier deadlocks.
    const operation = this.drain(drain).then(() => this.settled()).finally(() => {
      if (this.cancellation === operation) this.cancellation = undefined;
      this.changed();
    });
    this.cancellation = operation; return operation;
  }
  /** Owner edits drain old work without changing running/held/stopped intent. */
  mutate<T>(drain: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    if (this.phase !== 'open') return Promise.reject(new Error('运行时正在关闭。'));
    this.barriers++;
    return this.trackMutation(async () => {
      try { await this.drain(drain); return await work(); }
      finally { this.barriers--; }
    });
  }
  trackMutation<T>(work: () => Promise<T>): Promise<T> {
    if (this.phase !== 'open') return Promise.reject(new Error('运行时正在关闭。'));
    const operation = Promise.resolve().then(work).finally(() => { this.mutations.delete(operation); this.changed(); });
    this.mutations.add(operation); return operation;
  }
  async settled(): Promise<void> {
    while (this.mutations.size) await Promise.allSettled([...this.mutations]);
  }
  private drain(drain: () => Promise<void>): Promise<void> {
    if (this.interruption) return this.interruption;
    const operation = Promise.resolve().then(drain).finally(() => { if (this.interruption === operation) this.interruption = undefined; });
    this.interruption = operation; return operation;
  }
}
