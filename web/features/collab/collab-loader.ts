/**
 * 总览的取数与失败重试：重试不靠事件流（事件流健康时，读失败之后不一定再来台账事件）。2s 起翻倍退避，封顶由 capOf 按错误定
 * （默认 30s；没权限这类不会自己好的给更长的）。页面隐藏时到点不拉，回到前台立刻补拉一次。单测 tests/web-collab-loading.test.ts。
 */
const FIRST_RETRY_MS = 2_000;
const DEFAULT_CAP_MS = 30_000;

/** 页面可见性：浏览器里由 use-collab.ts 接 document；本模块不碰 DOM（bun 单测直接 import），不给 = 一直可见 */
export interface Visibility {
  hidden: () => boolean;
  onShow: (cb: () => void) => () => void;
}

const ALWAYS_VISIBLE: Visibility = { hidden: () => false, onShow: () => () => {} };

export function collabLoader<T>(opts: {
  fetch: (signal: AbortSignal) => Promise<T>;
  success: (value: T) => void;
  failure: (error: unknown) => void;
  capOf?: (error: unknown) => number;
  visibility?: Visibility;
}) {
  const vis = opts.visibility ?? ALWAYS_VISIBLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let disposed = false;
  let backoff = FIRST_RETRY_MS;
  /** 隐藏期间到点的重试：回到前台再拉 */
  let deferred = false;
  const offShow = vis.onShow(() => {
    if (!deferred || disposed) return;
    deferred = false;
    void refetch();
  });
  function retryLater(error: unknown): void {
    const cap = opts.capOf?.(error) ?? DEFAULT_CAP_MS;
    const wait = Math.min(backoff, cap);
    backoff = Math.min(backoff * 2, cap);
    timer = setTimeout(() => {
      if (vis.hidden()) deferred = true;
      else void refetch();
    }, wait);
  }
  async function refetch(): Promise<void> {
    if (disposed) return;
    clearTimeout(timer);
    deferred = false;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const value = await opts.fetch(mine.signal);
      if (disposed || mine.signal.aborted) return;
      backoff = FIRST_RETRY_MS;
      opts.success(value);
    } catch (error) {
      if (disposed || mine.signal.aborted) return;
      opts.failure(error);
      retryLater(error);
    }
  }
  return {
    refetch,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      offShow();
    },
  };
}
