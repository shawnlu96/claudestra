/**
 * Domd 该不该退回纯文本：先过护栏（lib/chat/md-guard.ts），再试解析。
 * - 附件预览、超过 WORKER_MIN_BYTES 的消息：在 Worker 里试解析，超预算判「太慢」（lib/chat/probe-queue.ts）；
 *   等结论期间先按纯文本显示（不带提示）。
 * - 更短的消息、流式中的消息、Worker 用不了时：主线程同步试解析（./probe），只能兜住栈溢出和树太深，慢的靠护栏，
 *   这条路径多加两条全文累计上限（mdTooHeavy 的 sync）。
 */
import { useEffect, useMemo, useState } from "react";
import { mdTooHeavy, utf8Over } from "@/lib/chat/md-guard";
import { createProbeQueue, type ProbeVerdict, type ProbeWorker } from "@/lib/chat/probe-queue";
import { domdSafe, type StoreProps } from "./probe";

/** heavy = 护栏判定；complex = 试解析出错、树太深或渲染出错；slow = Worker 里试解析超预算 */
export type PlainReason = "heavy" | "complex" | "slow";
export type ProbeMode = "auto" | "worker" | "sync";
export const WORKER_MIN_BYTES = 4 * 1024;

let queue: ReturnType<typeof createProbeQueue> | null = null;
function probeQueue() {
  if (typeof window === "undefined") return null;
  queue ??= createProbeQueue(() => new Worker(new URL("./probe.worker.ts", import.meta.url)) as unknown as ProbeWorker);
  return queue.available() ? queue : null;
}

/** 行内规则里的组件（函数）传不进 Worker，也不影响解析：只留纯数据 */
const plainRules = new WeakMap<object, unknown>();
function cloneableRules(rules: StoreProps["inlineRules"]) {
  if (!rules) return undefined;
  if (!plainRules.has(rules)) plainRules.set(rules, JSON.parse(JSON.stringify(rules)));
  return plainRules.get(rules);
}

/** null = 照常渲染；"pending" = 等 Worker 的结论 */
export function usePlainReason(opts: StoreProps, mode: ProbeMode): PlainReason | "pending" | null {
  const md = opts.initMd;
  const heavy = useMemo(() => typeof md === "string" && mdTooHeavy(md), [md]);
  const q = typeof md === "string" && !heavy && mode !== "sync" ? probeQueue() : null;
  const viaWorker = !!q && (mode === "worker" || utf8Over(md as string, WORKER_MIN_BYTES));
  const [got, setGot] = useState<{ md: string; v: ProbeVerdict | null }>();
  const verdict = viaWorker ? (q.cached(md as string) ?? (got && got.md === md ? got.v : undefined)) : null;
  useEffect(() => {
    if (!viaWorker || verdict !== undefined) return;
    let live = true;
    const text = md as string;
    void q.probe(text, { md: text, inlineRules: cloneableRules(opts.inlineRules) }).then((v) => live && setGot({ md: text, v }));
    return () => {
      live = false;
    };
  }, [md, viaWorker, verdict]); // eslint-disable-line react-hooks/exhaustive-deps -- 结论只随 md 变（行内规则挂载后不变）
  const needSync = typeof md === "string" && !heavy && verdict === null;
  const syncHeavy = useMemo(() => needSync && mdTooHeavy(md as string, { sync: true }), [md, needSync]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：解析结果只随 md 变
  const syncOk = useMemo(() => !needSync || syncHeavy || domdSafe(opts), [md, needSync, syncHeavy]);
  if (typeof md !== "string") return null;
  if (heavy) return "heavy";
  if (verdict === undefined) return "pending";
  if (verdict === "ok") return null;
  if (verdict) return verdict;
  if (syncHeavy) return "heavy";
  return syncOk ? null : "complex";
}
