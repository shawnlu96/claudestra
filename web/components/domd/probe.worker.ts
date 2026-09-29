/**
 * 试解析 Worker（排队与时间预算在 lib/chat/probe-queue.ts）：只回「能不能在预算内安全解析完」，解析结果不跨线程，
 * 主线程拿到 ok 再正式解析渲染。开工先回 started（主线程从这时起算杀 Worker 的兜底），解析耗时在这里量、随结论带回：
 * 主线程忙着渲染时收消息会晚，按主线程算会把预算放宽。首个任务加载脚本的时间不算。
 */
import type { InlineRule } from "@do-md/core-react";
import type { ProbeReply } from "@/lib/chat/probe-queue";
import { domdSafe } from "./probe";

type Job = { id: number; payload: { md: string; inlineRules?: InlineRule[] } };
const scope = self as unknown as { postMessage(m: ProbeReply): void; onmessage: ((e: MessageEvent<Job>) => void) | null };

scope.onmessage = ({ data: { id, payload } }) => {
  scope.postMessage({ id, started: true });
  const t0 = performance.now();
  const ok = domdSafe({ editable: false, initMd: payload.md, inlineRules: payload.inlineRules });
  scope.postMessage({ id, ok, ms: performance.now() - t0 });
};
