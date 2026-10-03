"use client";
/**
 * 「已完成」区往下翻（bridge i28-V1p）：总览只带已完成卡的窗口，更早的从 ov.doneCursor 起一页页拉 GET /ledger/:project/done。
 * 点「更多」或按钮滚进视野就拉下一页；失败保留已翻到的页、按 collab-loader 的退避自动重试（页面隐藏暂停、回前台补拉）。
 * 总览重拉后窗口往新挪了，掉出窗口的几张从新游标补一段（ledger-done.ts gapClosed），不重不漏。老 bridge 没有游标 = 不出按钮。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { byDone, chainLoadMore, chainOnOverview, chainOnPage, fetchLedgerDone, newChain, type DoneChain, type DonePage } from "@/lib/api/ledger-done";
import { collabLoader } from "./collab-loader";
import type { LedgerOverview, LedgerTaskView, Tr } from "./collab-model";
import { Icon } from "./collab-icons";
import { StepDots } from "./collab-step-line";
import { stepLineView } from "./collab-step-line-model";
import s from "./collab.module.css";
import { pageVisibility } from "./use-collab";
import v from "./v4/v4.module.css";

export interface DonePages {
  /** 翻到的、不在总览里的已完成卡（含 cancelled，列的时候按筛选再挑），按完成时刻倒序 */
  pages: LedgerTaskView[];
  /** 还有没有更早的可翻；老 bridge = false */
  more: boolean;
  loading: boolean;
  error: string | null;
  loadMore: () => void;
}

export function useDonePages(project: string, ov: LedgerOverview): DonePages {
  const [chain, setChain] = useState<DoneChain>(() => newChain(ov));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = useRef({ chain, ov, failed: false });
  const loader = useRef<ReturnType<typeof collabLoader<DonePage>> | null>(null);
  const apply = useCallback((c: DoneChain) => {
    st.current.chain = c;
    setChain(c);
    setLoading(c.job !== null);
    if (c.job) void loader.current?.refetch();
  }, []);

  useEffect(() => {
    const r = collabLoader<DonePage>({
      fetch: (signal) => fetchLedgerDone(project, st.current.chain.job!.before, signal),
      success: (page) => {
        st.current.failed = false;
        setError(null);
        apply(chainOnPage(st.current.chain, page, st.current.ov));
      },
      failure: (e) => {
        st.current.failed = true;
        setError(e instanceof Error ? e.message : String(e));
      },
      visibility: pageVisibility,
    });
    loader.current = r;
    return () => r.dispose();
  }, [project, apply]);

  // 总览重拉：窗口挪了就从新游标补一段，回到总览里的卡从页里去掉（ledger-done.ts chainOnOverview）
  useEffect(() => {
    st.current.ov = ov;
    const cur = st.current.chain;
    const c = chainOnOverview(cur, ov);
    if (c.job !== cur.job) apply(c);
    else if (c.pages !== cur.pages || c.next !== cur.next || c.anchor !== cur.anchor) {
      st.current.chain = c;
      setChain(c);
    }
  }, [ov, apply]);

  const loadMore = useCallback(() => {
    const cur = st.current;
    // 失败后在等退避：点一下立刻重拉同一单；正在拉就不重复发
    if (cur.chain.job) return void (cur.failed && loader.current?.refetch());
    const c = chainLoadMore(cur.chain);
    if (c) apply(c);
  }, [apply]);
  return { pages: chain.pages, more: chain.next !== null, loading, error, loadMore };
}

/** 「更多」：点它、或它滚进视野（滚到底）就拉下一页；失败显示在重试，点一下立刻再拉 */
export function DoneMoreButton({ d, tr }: { d: DonePages; tr: Tr }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { more, loading, loadMore } = d;
  useEffect(() => {
    const el = ref.current;
    if (!el || !more || loading || typeof IntersectionObserver === "undefined") return;
    // 每翻完一页重新观察一次：按钮还在视野里（列表短）时观察者不会再报变化，靠重新 observe 的首报接着翻
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && loadMore());
    io.observe(el);
    return () => io.disconnect();
  }, [more, loading, loadMore, d.pages.length]);
  if (!more) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 0" }}>
      {d.error && <span role="status" style={{ color: "var(--warn)", fontSize: "var(--fs-3)", padding: "0 6px" }}>{tr("没取到，正在重试")}</span>}
      <button ref={ref} type="button" className={s.ib} style={{ width: "100%" }} disabled={loading && !d.error} onClick={loadMore}>
        <Icon name={d.error ? "rotateCcw" : "chevronDown"} />
        {loading && !d.error ? tr("加载中…") : d.error ? tr("重试") : tr("更多")}
      </button>
    </div>
  );
}

const shown = (t: LedgerTaskView) => t.stage === "done" || t.stage === "verified";

/** 手机「更早完成」：最近窗口之外（含今日溢出）的已完成卡，默认收起；翻页卡保留步骤小点 */
export function MobileEarlierDone(props: { project: string; ov: LedgerOverview; todayDone: readonly string[]; onPick: (id: string) => void; tr: Tr }) {
  const { ov, tr } = props;
  const d = useDonePages(props.project, ov);
  const [open, setOpen] = useState(false);
  const today = new Set(props.todayDone);
  const rows = [...ov.tasks.filter((t) => shown(t) && !today.has(t.id)), ...d.pages.filter(shown)].sort(byDone);
  if (!rows.length && !d.more) return null;
  return (
    <section className={v.msec}>
      <button type="button" className={s.ib} style={{ width: "100%", justifyContent: "space-between" }} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{tr("更早完成")}</span>
        <Icon name={open ? "chevronUp" : "chevronDown"} />
      </button>
      {open && (
        <div className={v.og} style={{ marginTop: 6 }}>
          {rows.map((t) => {
            const steps = stepLineView(t.stepLine, t.stage);
            return (
              <button key={t.id} type="button" className={v.ot} onClick={() => props.onPick(t.id)}>
                <span className={`${v.dot} ${v.green}`} />
                <span className={v.tid}>{t.id}</span>
                <span className={v.ott}>{t.title}</span>
                <span className={v.ost}>{tr(t.stage === "done" ? "已完成" : t.stage)}</span>
                {steps && steps.slots.some((x) => x.filled) && <div style={{ gridColumn: "2 / 4", minWidth: 0 }}><StepDots v={steps} tr={tr} /></div>}
              </button>
            );
          })}
          <DoneMoreButton d={d} tr={tr} />
        </div>
      )}
    </section>
  );
}
