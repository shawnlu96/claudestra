/**
 * 试解析排队（tests/web-probe-queue.test.ts）：一个 Worker 依次试解析，每段有时间预算，超了判「太慢」。
 * 护栏按写法一类类补总会漏，预算兜住所有「慢但不溢出」的写法。耗时由 Worker 自己量（主线程忙着渲染时收消息会晚，
 * 按主线程算预算会变长）；主线程的计时器只负责杀掉卡在解析里的 Worker，下一段再起新的。
 * Worker 起不来（不支持、脚本加载失败、迟迟不开工）→ 之后一律返回 null，调用方退回同步试解析 + 护栏。
 * 结果按 md 原文缓存：消息列表重挂载时直接拿结论，不再先闪一下纯文本。
 */

export const PROBE_BUDGET_MS = 300;
/** 派活后多久还没开工算 Worker 起不来：首个任务要先加载脚本和 do-md，经中继的手机上可能要几秒 */
export const PROBE_START_MS = 10_000;
/** 开工后超过预算这么久还没回结论，就杀掉 Worker：它自己量的耗时已经超了，只是还没算完 */
const KILL_GRACE_MS = 200;
const CACHE_SIZE = 200;

export type ProbeVerdict = "ok" | "complex" | "slow";

/** Worker 里回的消息：开工时 {id, started}，解析完 {id, ok, ms}（ms = Worker 里量的解析耗时） */
export type ProbeReply = { id: number; started?: boolean; ok?: boolean; ms?: number };

export interface ProbeWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: ProbeReply }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

type Opts = { budget?: number; start?: number };

export function createProbeQueue(spawn: () => ProbeWorker, { budget = PROBE_BUDGET_MS, start = PROBE_START_MS }: Opts = {}) {
  const cache = new Map<string, ProbeVerdict>();
  const waiting = new Map<string, ((v: ProbeVerdict | null) => void)[]>();
  const queue: { md: string; payload: unknown }[] = [];
  let worker: ProbeWorker | null = null;
  let broken = false;
  let busy: { id: number; md: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const settle = (md: string, v: ProbeVerdict | null) => {
    if (v) {
      cache.set(md, v);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    }
    for (const resolve of waiting.get(md) ?? []) resolve(v);
    waiting.delete(md);
  };
  const kill = () => {
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
  };
  const fail = () => {
    broken = true;
    kill();
    if (busy) settle(busy.md, null);
    busy = null;
    for (const job of queue.splice(0)) settle(job.md, null);
  };
  const finish = (v: ProbeVerdict) => {
    const md = busy!.md;
    busy = null;
    settle(md, v);
    pump();
  };
  const onReply = ({ data }: { data: ProbeReply }) => {
    if (!busy || data?.id !== busy.id) return;
    clearTimeout(timer);
    if (data.started) {
      // 兜底：Worker 还卡在解析里就只能整个杀掉，下一段重新起
      timer = setTimeout(() => (kill(), finish("slow")), budget + KILL_GRACE_MS);
      return;
    }
    finish(!data.ok ? "complex" : (data.ms ?? 0) > budget ? "slow" : "ok");
  };
  function pump() {
    if (busy || broken || !queue.length) return;
    const job = queue.shift()!;
    try {
      if (!worker) {
        worker = spawn();
        worker.onmessage = onReply;
        worker.onerror = fail;
      }
    } catch {
      queue.unshift(job);
      return fail(); // 没有 Worker / 被 CSP 拦：退回同步路径，错误本身没有别的用处
    }
    busy = { id: ++seq, md: job.md };
    worker.postMessage({ id: busy.id, payload: job.payload });
    timer = setTimeout(fail, start);
  }

  return {
    /** Worker 还能用（没失败过） */
    available: () => !broken,
    /** 已有的结论（没有就 undefined） */
    cached: (md: string) => cache.get(md),
    /** 排队试解析；null = Worker 用不了，调用方自己同步判 */
    probe(md: string, payload: unknown): Promise<ProbeVerdict | null> {
      const hit = cache.get(md);
      if (hit) return Promise.resolve(hit);
      if (broken) return Promise.resolve(null);
      return new Promise((resolve) => {
        const list = waiting.get(md);
        if (list) return void list.push(resolve);
        waiting.set(md, [resolve]);
        queue.push({ md, payload });
        pump();
      });
    },
  };
}
