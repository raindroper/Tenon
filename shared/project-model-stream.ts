const maxFrameCharacters = 32 * 1024 * 1024;

export type ProjectModelFailureCode = 'transport_interrupted' | 'missing_terminal' | 'request_timeout' | 'first_response_timeout' | 'downstream_timeout' | 'task_stopped'
  | 'provider_http_error' | 'invalid_stream' | 'provider_failed' | 'provider_incomplete';

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function frameEvent(frame: string): Record<string, unknown> | undefined {
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  }
  if (!data.length) return;
  try { return object(JSON.parse(data.join('\n'))); }
  catch { /* The native client owns interpretation of unrecognized provider frames. */ }
}

function terminalEvent(event: Record<string, unknown>): 'completed' | 'provider_failed' | 'provider_incomplete' | 'invalid_stream' | undefined {
  const response = object(event.response);
  if (event.type === 'response.failed') {
    const error = object(response?.error);
    return error && (typeof error.code === 'string' || typeof error.message === 'string') ? 'provider_failed' : 'invalid_stream';
  }
  if (event.type !== 'response.completed' && event.type !== 'response.incomplete') return;
  if (typeof response?.id !== 'string' || !response.id) return 'invalid_stream';
  if (event.type === 'response.incomplete' || response.status === 'incomplete') return 'provider_incomplete';
  return response.status === undefined || response.status === 'completed' ? 'completed' : 'invalid_stream';
}

/** Holds one unfinished event so a broken transport cannot splice into a terminal error frame. */
export class ProjectModelStream {
  private readonly decoder = new TextDecoder();
  private readonly fragments: string[] = [];
  private pendingLength = 0;
  private pendingNewline = false;
  private afterCarriageReturn = false;
  private outcome?: ReturnType<typeof terminalEvent>;

  constructor(private readonly mapEvent?: (event: Record<string, unknown>) => Record<string, unknown>) {}

  get terminal(): boolean { return this.outcome !== undefined; }
  get failure(): ProjectModelFailureCode | undefined { return this.outcome === 'completed' ? undefined : this.outcome; }

  push(chunk: Uint8Array, observe?: (event: Record<string, unknown>) => void): string {
    if (this.terminal) return '';
    const decoded = this.decoder.decode(chunk, { stream: true });
    if (!decoded) return '';
    const text = (this.afterCarriageReturn && decoded.startsWith('\n') ? decoded.slice(1) : decoded).replace(/\r\n?/g, '\n');
    this.afterCarriageReturn = decoded.endsWith('\r');
    if (!text) return '';
    const frames: string[] = [];
    let start = 0;
    if (this.pendingNewline && text.startsWith('\n')) {
      const frame = this.takeFrame('', 1);
      if (frame === undefined) return this.invalid(frames);
      this.forwardFrame(frame, frames, observe);
      if (this.terminal) return frames.join('');
      start = 1;
    }
    let end = text.indexOf('\n\n', start);
    while (end >= 0) {
      const frame = this.takeFrame(text.slice(start, end));
      if (frame === undefined) return this.invalid(frames);
      this.forwardFrame(frame, frames, observe);
      if (this.terminal) return frames.join('');
      start = end + 2;
      end = text.indexOf('\n\n', start);
    }
    const remainder = text.slice(start);
    if (remainder) {
      this.pendingLength += remainder.length;
      if (this.pendingLength > maxFrameCharacters + 1) return this.invalid(frames);
      this.fragments.push(remainder);
      this.pendingNewline = remainder.endsWith('\n');
    }
    return frames.join('');
  }

  private takeFrame(suffix: string, trim = 0): string | undefined {
    if (this.pendingLength + suffix.length - trim > maxFrameCharacters) return;
    if (!this.fragments.length) return suffix;
    this.fragments.push(suffix);
    const frame = this.fragments.join('');
    this.clear();
    return trim ? frame.slice(0, -trim) : frame;
  }

  private forwardFrame(frame: string, frames: string[], observe?: (event: Record<string, unknown>) => void): void {
    const received = frameEvent(frame);
    const event = received && this.mapEvent ? this.mapEvent(received) : received;
    if (event) {
      observe?.(event);
      this.outcome = terminalEvent(event);
      if (this.outcome === 'invalid_stream') {
        frames.push(projectModelFailureFrame('invalid_stream', '项目模型返回了无效的流式事件。'));
        return;
      }
      // Some compatible gateways label an explicitly incomplete response as completed.
      if (this.outcome === 'provider_incomplete' && event.type === 'response.completed') {
        frames.push('event: response.incomplete\ndata: ' + JSON.stringify({ ...event, type: 'response.incomplete' }) + '\n\n');
        return;
      }
    }
    if (event && event !== received) {
      let emitted = false;
      frame = frame.split('\n').flatMap(line => {
        if (line !== 'data' && !line.startsWith('data:')) return [line];
        if (emitted) return [];
        emitted = true;
        return ['data: ' + JSON.stringify(event)];
      }).join('\n');
    }
    frames.push(frame + '\n\n');
  }

  private clear(): void {
    this.fragments.length = 0;
    this.pendingLength = 0;
    this.pendingNewline = false;
  }

  private invalid(frames: string[]): string {
    this.outcome = 'invalid_stream';
    this.clear();
    return frames.join('') + projectModelFailureFrame('invalid_stream', '项目模型返回了无效的流式事件。');
  }
}

export function projectModelFailureFrame(code: ProjectModelFailureCode, message: string): string {
  const event = { type: 'response.failed', response: { error: { code, message } } };
  return 'event: response.failed\ndata: ' + JSON.stringify(event) + '\n\n';
}
