/** EventSource hides HTTP status; an error can trigger one bounded, cancellable session check. */
export function createSessionProbe(read: (signal: AbortSignal) => Promise<unknown>, current: () => boolean, expire: () => void) {
  let closed = false; let version = 0;
  let pending: AbortController | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    closed = true; version++; clearTimeout(timeout); pending?.abort(); pending = undefined;
  };
  const check = () => {
    if (closed || !current() || pending) return;
    const controller = new AbortController(); pending = controller; const owner = ++version;
    const timer = setTimeout(() => {
      if (version !== owner) return;
      version++; pending = undefined; controller.abort();
    }, 5000);
    timeout = timer;
    void (async () => {
      try {
        const session = await read(controller.signal);
        if (closed || !current() || version !== owner || controller.signal.aborted) return;
        if (session && typeof session === 'object' && 'required' in session && session.required === true &&
          'authenticated' in session && session.authenticated === false) expire();
      } catch { /* A disconnected network is not evidence that a session has expired. */ }
      finally {
        clearTimeout(timer);
        if (version === owner && pending === controller) pending = undefined;
      }
    })();
  };
  return { check, close };
}
