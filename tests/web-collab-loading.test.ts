import { afterEach, expect, test, jest } from "bun:test";
import { collabLoader } from "../web/features/collab/collab-loader";
import { homeView, type LedgerOverview } from "../web/features/collab/collab-model";
import { metricsOf } from "../web/features/collab/v4/v4-model";

const snapshot = { ok: true, exists: true, now: 100, meta: { pms: [] }, items: [], tasks: [] };
afterEach(() => jest.useRealTimers());
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

for (const message of ["TimeoutError", "HTTP 500", "HTTP 403"]) {
  test(`${message}: retries 2s/4s with no stream events, retains data, resets on success`, async () => {
    jest.useFakeTimers();
    let shown: unknown = snapshot;
    let requests = 0, failures = 0;
    const reader = collabLoader({
      fetch: async () => { requests++; if (requests < 3 || requests === 4) throw new Error(message); return { ...snapshot, now: requests }; },
      success: (data) => { shown = data; },
      failure: () => { failures++; },
    });
    await reader.refetch();
    expect(shown).toBe(snapshot);
    jest.advanceTimersByTime(1999); await flush(); expect(requests).toBe(1);
    jest.advanceTimersByTime(1); await flush(); expect(requests).toBe(2);
    jest.advanceTimersByTime(3999); await flush(); expect(requests).toBe(2);
    jest.advanceTimersByTime(1); await flush(); expect(shown).toEqual({ ...snapshot, now: 3 });
    await reader.refetch();
    jest.advanceTimersByTime(2000); await flush(); expect(requests).toBe(5);
    expect(failures).toBe(3);
    reader.dispose();
    jest.advanceTimersByTime(60_000); await flush(); expect(requests).toBe(5);
  });
}

test("dispose and superseded reads cannot replace the current project snapshot", async () => {
  const replies: ((value: number) => void)[] = [];
  const shown: number[] = [];
  const reader = collabLoader({ fetch: () => new Promise<number>((resolve) => replies.push(resolve)), success: (v) => shown.push(v), failure: () => {} });
  const first = reader.refetch(), second = reader.refetch();
  replies[1](2); await second;
  replies[0](1); await first;
  expect(shown).toEqual([2]);
  const third = reader.refetch();
  reader.dispose(); replies[2](3); await third;
  expect(shown).toEqual([2]);
});

test("compact completed cards keep completion dates and overview counters", () => {
  const now = Date.now();
  const ov = { ...snapshot, now, tasks: [{ id: "done", stage: "done", updatedAt: now,
    metrics: { endTs: now - 86_400_000, reviewRounds: 4, p0: 1, p1: 2, reviewWaitPendingMs: null } }] } as unknown as LedgerOverview;
  expect(homeView(ov, now).todayDone).toEqual([]);
  expect(metricsOf(ov, 0, 1)).toMatchObject({ reviewRounds: 4, fixed: 3 });
});

test("retry delay caps at 30s; disposal cancels a scheduled retry", async () => {
  jest.useFakeTimers();
  let requests = 0;
  const reader = collabLoader({
    fetch: async () => { requests++; throw new Error("offline"); }, success: () => {}, failure: () => {},
  });
  await reader.refetch();
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = requests;
    jest.advanceTimersByTime(delay - 1); await flush(); expect(requests).toBe(before);
    jest.advanceTimersByTime(1); await flush(); expect(requests).toBe(before + 1);
  }
  reader.dispose();
  jest.advanceTimersByTime(60_000); await flush(); expect(requests).toBe(7);
});

test("page hidden: a due retry waits for the page to come back, then fetches at once; dispose unsubscribes", async () => {
  jest.useFakeTimers();
  let hidden = false, requests = 0;
  let show: (() => void) | null = null;
  const reader = collabLoader({
    fetch: async () => { requests++; throw new Error("offline"); }, success: () => {}, failure: () => {},
    visibility: { hidden: () => hidden, onShow: (cb) => { show = cb; return () => { show = null; }; } },
  });
  await reader.refetch();
  hidden = true;
  jest.advanceTimersByTime(2000); await flush(); expect(requests).toBe(1);
  jest.advanceTimersByTime(600_000); await flush(); expect(requests).toBe(1);
  hidden = false;
  show!(); await flush(); expect(requests).toBe(2);
  show!(); await flush(); expect(requests).toBe(2); // 没有挂着的重试：回前台不额外拉
  jest.advanceTimersByTime(4000); await flush(); expect(requests).toBe(3);
  reader.dispose();
  expect(show).toBeNull();
});

test("capOf: forbidden reads back off to a longer cap than transient failures", async () => {
  jest.useFakeTimers();
  let requests = 0;
  const reader = collabLoader({
    fetch: async () => { requests++; throw new Error("HTTP 403"); }, success: () => {}, failure: () => {},
    capOf: (e) => ((e as Error).message === "HTTP 403" ? 300_000 : 30_000),
  });
  await reader.refetch();
  for (const delay of [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]) {
    const before = requests;
    jest.advanceTimersByTime(delay - 1); await flush(); expect(requests).toBe(before);
    jest.advanceTimersByTime(1); await flush(); expect(requests).toBe(before + 1);
  }
  reader.dispose();
});
