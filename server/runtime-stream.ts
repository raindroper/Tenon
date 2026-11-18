import type { ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeView, RuntimeViewDelta, RuntimeViewScope } from '../shared/runtime-view.js';
import type { RuntimeApi } from './runtime.js';

interface Snapshot { id: string; view: RuntimeView }
interface Peer {
  response: ServerResponse; scope: RuntimeViewScope; blocked: boolean; delta: boolean;
  sent?: Snapshot; latest?: Snapshot; allowed(): boolean; close(): void;
}

function stateDelta(previous: Snapshot, next: RuntimeView): RuntimeViewDelta | undefined {
  const replace = Object.fromEntries(Object.entries(next).filter(([key, value]) =>
    value !== undefined && !isDeepStrictEqual(previous.view[key as keyof RuntimeView], value)));
  const remove = (['mediaJobs', 'devices', 'projectWorkspaces', 'projectOperations'] as const).filter(key => previous.view[key] !== undefined && next[key] === undefined);
  if (Object.keys(replace).length || remove.length) return { base: previous.id, replace, ...(remove.length ? { remove } : {}) };
}

/** Live transport for the existing public snapshot, with one bounded pending update per reader. */
export class RuntimeStateStream {
  private readonly peers = new Set<Peer>();
  private detach?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private reading = false;
  private dirty = false;
  private closed = false;
  private revision = 0;

  constructor(private readonly runtime: RuntimeApi, private readonly serialize: (value: unknown) => string) {}

  connect(response: ServerResponse, allowed: () => boolean = () => true, scope: RuntimeViewScope = {}, delta = false): void {
    if (this.closed) { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no', connection: 'keep-alive' });
    response.flushHeaders();
    const peer: Peer = { response, scope, blocked: false, delta, allowed, close: () => {
      this.peers.delete(peer); response.off('drain', drain); response.off('close', peer.close);
      if (!this.peers.size) this.idle();
    } };
    const drain = () => {
      peer.blocked = false;
      if (peer.latest) { const latest = peer.latest; peer.latest = undefined; this.sendState(peer, latest, new Map()); }
    };
    response.on('drain', drain); response.on('close', peer.close); this.peers.add(peer);
    this.send(peer, 'retry: 2000\n\n');
    if (!this.peers.has(peer)) return;
    if (!this.detach) this.detach = this.runtime.subscribe(() => this.invalidate());
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        // This is transport liveness only: no snapshot, state revision or runtime activity changes.
        const frame = `: keepalive\n\nevent: heartbeat\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`;
        for (const value of this.peers) this.send(value, frame);
      }, 15000);
      this.heartbeat.unref();
    }
    // Reconnection reads the selected durable page again, including text received while offline.
    this.invalidate();
  }

  private canSend(peer: Peer): boolean {
    if (peer.response.destroyed || peer.response.writableEnded) { peer.close(); return false; }
    if (!peer.allowed()) {
      peer.close(); peer.response.end('event: session-expired\ndata: {}\n\n'); return false;
    }
    return true;
  }

  private send(peer: Peer, frame: string): void {
    if (this.canSend(peer) && !peer.blocked) peer.blocked = !peer.response.write(frame);
  }

  private sendState(peer: Peer, snapshot: Snapshot, frames: Map<Snapshot | undefined, string | undefined>): void {
    if (!this.canSend(peer)) return;
    if (peer.blocked) { peer.latest = snapshot; return; }
    const base = peer.delta ? peer.sent : undefined;
    if (!frames.has(base)) {
      const data = base ? stateDelta(base, snapshot.view) : snapshot.view;
      const event = base ? 'state-delta' : 'state';
      frames.set(base, data ? `id: ${snapshot.id}\nevent: ${event}\ndata: ${this.serialize(data)}\n\n` : undefined);
    }
    const frame = frames.get(base);
    if (!frame) return;
    peer.blocked = !peer.response.write(frame);
    if (peer.delta) peer.sent = snapshot;
  }

  private invalidate(): void {
    this.dirty = true;
    if (this.closed || this.reading || this.timer || !this.peers.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 30);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.reading || this.closed || !this.peers.size) return;
    this.reading = true; this.dirty = false;
    try {
      const groups = new Map<string, Peer[]>();
      for (const peer of this.peers) {
        const key = JSON.stringify([peer.scope.caseId, peer.scope.before]);
        const group = groups.get(key);
        if (group) group.push(peer); else groups.set(key, [peer]);
      }
      await Promise.all([...groups.values()].map(async peers => {
        try {
          const view = await this.runtime.snapshot(peers[0].scope);
          if (this.closed) return;
          const snapshot = { id: String(++this.revision), view };
          const frames = new Map<Snapshot | undefined, string | undefined>();
          for (const peer of peers) if (this.peers.has(peer)) this.sendState(peer, snapshot, frames);
        } catch {
          // The browser reconnects this page without replaying an owner command.
          for (const peer of peers) if (this.peers.has(peer)) { peer.close(); peer.response.end(); }
        }
      }));
    } finally {
      this.reading = false;
      if (this.dirty) this.invalidate();
    }
  }

  private idle(): void {
    this.detach?.(); this.detach = undefined; clearTimeout(this.timer); this.timer = undefined;
    clearInterval(this.heartbeat); this.heartbeat = undefined;
  }

  close(): void {
    this.closed = true; this.idle();
    // These are outbound views only; disconnecting them never cancels accepted runtime work.
    for (const peer of [...this.peers]) { peer.close(); peer.response.destroy(); }
  }
}
