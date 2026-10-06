"use client";
/**
 * 网页顶部额度提醒条（QWARN1）：本机 Claude / Codex 任一族本周用量到了实际提醒线 / 停接线，顶栏下方出一条非模态提醒，
 * 写明家族、已用百分比、重置时间、是否已停止接新单；两族各一行、各自可关。数据只读 QLINE1 的 GET /lend/quota-lines
 * （lend-quota-api.fetchQuotaLines，同一 client / 认证），页面可见时 60 秒拉一次；403（非 owner 全权）/ 404（老 bridge）= null，
 * 整条消失并不再拉；401（凭据失效）同样清空已显示的读数并停拉；其他错误保留上次显示、下次再试。回包按发出顺序落地（LoadGate），
 * 慢的旧回包不覆盖已显示的新状态。只显示，不发任何写请求（不改线、不撤单、不动模型 / 额度）。
 * 显示与关掉的规则在 quota-warning-model.ts；切机器时清空旧机器的读数，关掉记录按机器 fp 分开。
 * fixed 浮层按 web/CLAUDE.md 第 4 条 createPortal 到 body。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "@/lib/api/client";
import { machines } from "@/lib/machines";
import { fetchQuotaLines } from "./lend-quota-api";
import { finishLoad, newLoadGate, startLoad } from "./lend-model";
import type { QuotaLinesView } from "./lend-quota-model";
import { useWarnT } from "./quota-warning-i18n";
import {
  DISMISS_KEY, FAMILY_LABEL, isDismissed, mergeDismissed, observeDismissed, parseDismissed,
  warnTexts, warningItems, withDismissed, type DismissMap, type WarnItem,
} from "./quota-warning-model";
import css from "./quota-warning.module.css";

const POLL_MS = 60_000;

function readDismissed(): DismissMap {
  try {
    return parseDismissed(localStorage.getItem(DISMISS_KEY));
  } catch {
    return {}; // 隐私模式 / 禁用存储：关掉只在这次页面里有效
  }
}

const useMachineFp = () => useSyncExternalStore((cb) => machines.subscribe(cb), () => machines.currentFp() ?? "local", () => "local");

/** 用到的 lucide 图标（circle-pause / triangle-alert / x）的原始路径，内联画，不引图标库 */
const LUCIDE = {
  circlePause: <><circle cx="12" cy="12" r="10" /><line x1="10" x2="10" y1="15" y2="9" /><line x1="14" x2="14" y1="15" y2="9" /></>,
  triangleAlert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
};
const Lucide = ({ name, size, className }: { name: keyof typeof LUCIDE; size: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {LUCIDE[name]}
  </svg>
);

function Row({ it, onDismiss }: { it: WarnItem; onDismiss: () => void }) {
  const { t, when } = useWarnT();
  const tx = warnTexts(it);
  const detail = [t(tx.status), it.resetAt === null ? t("重置时间未知") : t("重置 {when}", { when: when(it.resetAt) }), ...(it.lastKnown ? [t("上次读数")] : [])];
  return (
    <div role="status" className={`${css.row} ${it.level === "stop" ? "bg-error text-error-content" : "bg-warning text-warning-content"}`}
      data-quota-warning={it.family} data-level={it.level}>
      <Lucide size={16} name={it.level === "stop" ? "circlePause" : "triangleAlert"} className={css.icon} />
      <div className={css.text}>
        <div className="font-semibold">{t(tx.title, { family: FAMILY_LABEL[it.family], pct: it.usedPct })}</div>
        <div className="opacity-85">{detail.join(" · ")}</div>
      </div>
      <button type="button" aria-label={t("关闭")} className="btn btn-circle btn-ghost btn-xs shrink-0" onClick={onDismiss}>
        <Lucide size={14} name="x" />
      </button>
    </div>
  );
}

export function QuotaWarningBanner() {
  const { t } = useWarnT();
  const fp = useMachineFp();
  const [data, setData] = useState<{ fp: string; view: QuotaLinesView | null } | null>(null);
  const [dismissed, setDismissed] = useState<DismissMap>(readDismissed);
  const [now, setNow] = useState(() => Date.now());

  const unsaved = useRef<DismissMap>({});
  const persist = useCallback((next: DismissMap) => {
    try {
      localStorage.setItem(DISMISS_KEY, JSON.stringify(next));
      unsaved.current = {};
    } catch {
      unsaved.current = next; // 存不下时仍保留本页的关闭和配置失效记录，下一次同步不能撤销它们。
    }
    setDismissed(next);
  }, []);

  useEffect(() => {
    let stop = false;
    const gate = newLoadGate(); // 每台机器（每次 effect）一份：旧机器 / 旧请求的回包都落不了地
    let timer: ReturnType<typeof setInterval> | null = null;
    const halt = () => {
      stop = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
    function load() {
      if (stop || document.visibilityState !== "visible") return;
      setNow(Date.now());
      const ticket = startLoad(gate);
      fetchQuotaLines()
        .then((view) => {
          if (stop || !finishLoad(gate, ticket, true)) return; // 比已落地的更旧：丢掉
          if (view) {
            const current = mergeDismissed(readDismissed(), unsaved.current);
            const next = observeDismissed(current, fp, view);
            if (next !== current) persist(next);
            else setDismissed(current);
          }
          setData({ fp, view });
          if (view === null) halt(); // 403 / 404：这台机器不给看，本页不再拉
        })
        .catch((e) => {
          if (stop) return;
          if (e instanceof ApiError && e.status === 401) { // 凭据失效（不论先后都生效）：清掉已显示的读数再停拉；client 已标需重新配对
            setData({ fp, view: null });
            return halt();
          }
          if (!finishLoad(gate, ticket, false)) return;
          console.debug("额度提醒条拉取失败（保持上次显示，下一次轮询再试）:", e);
        });
    }
    load();
    timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return halt;
  }, [fp, persist]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === DISMISS_KEY || e.key === null) setDismissed(mergeDismissed(readDismissed(), unsaved.current)); };
    window.addEventListener("storage", onStorage); // 别的 tab 关掉的，这里也收起
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const dismiss = useCallback((it: WarnItem) => {
    const next = withDismissed(mergeDismissed(readDismissed(), unsaved.current), fp, it);
    persist(next);
  }, [fp, persist]);

  const items = warningItems(data?.fp === fp ? data.view : null, now).filter((it) => !isDismissed(dismissed, fp, it));
  if (items.length === 0 || typeof document === "undefined") return null;
  return createPortal(
    <div className={css.wrap} aria-label={t("出借额度提醒")} data-testid="quota-warning">
      {items.map((it) => <Row key={it.family} it={it} onDismiss={() => dismiss(it)} />)}
    </div>,
    document.body,
  );
}
