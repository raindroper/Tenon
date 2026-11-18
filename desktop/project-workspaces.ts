import { projectRootsOverlap } from '../shared/project-path.js';

interface Workspace {
  root: string;
  writable: boolean;
}
interface Waiter {
  workspace: Workspace;
  signal: AbortSignal;
  abort(): void;
  resolve(release: () => void): void;
}

function conflicts(left: Workspace, right: Workspace): boolean {
  return (left.writable || right.writable) && projectRootsOverlap(left.root, right.root);
}

/** Scheduling by the actual directories also catches aliases and junctions. */
export class ProjectWorkspaces {
  private readonly held = new Map<string, Workspace>();
  private readonly waiting = new Map<string, Waiter>();

  constructor(private readonly oneAtATime = false) {}

  restore(id: string, workspace: Workspace): void { this.held.set(id, workspace); }

  acquire(id: string, workspace: Workspace, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(id);
        reject(signal.reason);
        this.advance();
      };
      this.waiting.set(id, { workspace, signal, abort, resolve });
      signal.addEventListener('abort', abort, { once: true });
      this.advance();
    });
  }

  private advance(): void {
    const blocked: Workspace[] = [];
    for (const [id, waiter] of this.waiting) {
      if ((this.oneAtATime && this.held.size > 0)
        || [...this.held.values(), ...blocked].some(workspace => conflicts(workspace, waiter.workspace))) {
        blocked.push(waiter.workspace);
        continue;
      }
      this.waiting.delete(id);
      waiter.signal.removeEventListener('abort', waiter.abort);
      this.held.set(id, waiter.workspace);
      waiter.resolve(() => {
        if (this.held.get(id) !== waiter.workspace) return;
        this.held.delete(id);
        this.advance();
      });
    }
  }
}
