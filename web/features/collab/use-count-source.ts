"use client";
/**
 * 计数源（UXNUM1）：什么时候算载完、20 秒后还缺几个 feature、看者本机的周额度；以及把同一份计数递给产品卡 / 子 DAG 框头的 context。
 * 团队版「载完」= 列表里每个 feature 都拉到了详情（读团队源已有的 last()，不改 team-source-shared.ts），且看板模型到了；
 * 本机项目总览一到、看板到了就算载完。没载完时各处显示骨架；20 秒后仍缺 feature 照常出数，并给出缺几个。
 * 一旦出过数就不再退回骨架：之后的补拉 / 轮询只换数字，不闪。
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { fetchQuotaLines } from "../lend/lend-quota-api";
import { countSnap, missingFeatures, quotaPcts, type CountBoard, type CountState, type QuotaFamilyPct } from "./count-words";
import type { LedgerOverview } from "./collab-model";

/** 20 秒后照常出数（429 退避、读失败的 feature 不再挡着整页） */
export const LATE_MS = 20_000;

export interface CountInput {
  project: string;
  ov: Pick<LedgerOverview, "tasks" | "doneRest"> | null;
  /** 看板模型（谁在干活的四栏）；null = 还没到 */
  board: CountBoard | null;
  /** 看板还在等（本机 /work 没回、团队合并要的本机看板没回） */
  boardPending: boolean;
  /** 看板读失败、手上也没有上一份（老 bridge 没有 /work、读不到）：不再等它，状态词整格不出，已知指标照常出；之后读到了再出数 */
  boardFailed?: boolean;
  /** 协作源（useCollabSource）：团队源带 last() */
  source: object;
  /** 测试用：缺省 LATE_MS */
  lateMs?: number;
}

export function useCountState(a: CountInput): CountState {
  const [late, setLate] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setLate(a.project), a.lateMs ?? LATE_MS);
    return () => clearTimeout(t);
  }, [a.project, a.lateMs]);
  const missing = missingFeatures(a.source);
  const isLate = late === a.project;
  const complete = a.ov !== null && missing === 0 && a.board !== null && !a.boardPending;
  // 渲染期调整状态（React「根据 props 调整 state」的写法）：到齐那一刻记下，之后补拉不再退回骨架
  if (complete && shown !== a.project) setShown(a.project);
  const open = complete || shown === a.project || isLate;
  return useMemo((): CountState => {
    if (a.ov && !a.board && (isLate || a.boardFailed)) return { status: "none" };
    if (!a.ov || !a.board || !open) return { status: "loading" };
    return { status: "ready", snap: countSnap(a.board, a.ov), missing: missing ?? 0 };
  }, [a.ov, a.board, a.boardFailed, open, isLate, missing]);
}

/**
 * 一份按轮（rev）重拉的结果是不是这一轮的：重拉期间调用方还留着上一轮的结果（同一个对象），每个新结果（对象换了）记下当时的 rev。
 * rev 变后旧请求已中止，下一个结果就是这一轮的。settled = 这份结果已经是最终态（不是 loading）
 */
export function useRoundFresh(value: object, settled: boolean, rev: number): boolean {
  const [seen, setSeen] = useState<{ value: object; rev: number } | null>(null);
  // 渲染期调整状态（同上 useCountState）
  if (settled && seen?.value !== value) setSeen({ value, rev });
  return settled && (seen?.value !== value || seen.rev === rev);
}

/** 产品卡、子 DAG 框头（含手机 MobileDag 节头）读同一份计数；没给 = 老调用方（单测直接挂组件），照旧显示 feature 自带的计数 */
export const CountContext = createContext<CountState | null>(null);
export const useCountContext = () => useContext(CountContext);

const QUOTA_POLL_MS = 60_000;
/** 看者这台机器 bridge 的 /lend/quota-lines（本机版、团队版同一份）；403 / 404 / 读失败 / 全空 = null */
export function useWeekQuota(): QuotaFamilyPct[] | null {
  const [got, setGot] = useState<QuotaFamilyPct[] | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      if (document.hidden) return;
      fetchQuotaLines().then((v) => { if (live) setGot(quotaPcts(v)); },
        // 读失败只是这一格不出（顶部黄条另有自己的提示），下一轮再读
        (e: Error) => console.warn(`[collab] 读周额度失败：${e.message}`));
    };
    read();
    const t = setInterval(read, QUOTA_POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);
  return got;
}
