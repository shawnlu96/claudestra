/** Overview retries are independent of SSE: a healthy stream need not emit another ledger event after a failed read. */
export function collabLoader<T>(opts: {
  fetch: (signal: AbortSignal) => Promise<T>;
  success: (value: T) => void;
  failure: (error: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  let backoff = 2_000;
  async function refetch(): Promise<void> {
    if (disposed) return;
    clearTimeout(timer);
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const value = await opts.fetch(mine.signal);
      if (disposed || mine.signal.aborted) return;
      backoff = 2_000;
      opts.success(value);
    } catch (error) {
      if (disposed || mine.signal.aborted) return;
      opts.failure(error);
      timer = setTimeout(() => void refetch(), backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  return {
    refetch,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}
