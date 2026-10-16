"use client";
/**
 * 顶部额度卡（QUOTA1）：额度闸横幅与额度提醒条合成一张卡。每族最多一行（quota-notice-model：用完 > 不再接新活 > 到提醒线），
 * 两族都有就两行叠在同一张卡里；一个关闭按钮，「看额度」打开「今天 · 团队与额度」。用完那一行保留闸的明细与「已恢复」两步确认
 * （POST /quota/wall/clear 后重读）。读数来自 quota-lines-store（同一份轮询），这里不自己拉。
 * 只读：除「已恢复」外不发写请求。独立展示时 fixed 浮层按 web/CLAUDE.md 第 4 条 createPortal 到 body；Chat 里 embedded 进文流插槽。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { machines } from "@/lib/machines";
import { QUOTA_WORDS as Q } from "@/lib/owner-words";
import { useChatNav } from "../chat/components/nav-context";
import { openToday } from "../now/today-nav";
import { quotaNow, reloadQuotaWall, useQuotaLinesReading, useQuotaWallReading } from "./quota-lines-store";
import {
  dismissRows, isRowDismissed, loadNoticeDismiss, mergeNoticeDismiss, noticeRows, NOTICE_DISMISS_KEY,
  type NoticeDismiss, type NoticeRow,
} from "./quota-notice-model";
import css from "./quota-notice.module.css";

const EXIT_MS = 220;

const useMachineFp = () => useSyncExternalStore((cb) => machines.subscribe(cb), () => machines.currentFp() ?? "local", () => "local");

function readDismissed(fp: string): NoticeDismiss {
  try {
    const { map, migrated } = loadNoticeDismiss((k) => localStorage.getItem(k), fp);
    if (migrated) localStorage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(map)); // 旧键只读这一次，之后只写新键
    return map;
  } catch {
    return {}; // 隐私模式 / 禁用存储：关掉只在这次页面里有效
  }
}

/** 用到的 lucide 图标（gauge / circle-pause / triangle-alert / refresh-cw / x）的原始路径，内联画，不引图标库 */
const LUCIDE = {
  gauge: <><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>,
  circlePause: <><circle cx="12" cy="12" r="10" /><line x1="10" x2="10" y1="15" y2="9" /><line x1="14" x2="14" y1="15" y2="9" /></>,
  triangleAlert: <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
};
const Lucide = ({ name, size, className }: { name: keyof typeof LUCIDE; size: number; className?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    {LUCIDE[name]}
  </svg>
);

const TONE: Record<NoticeRow["level"], string> = {
  out: "bg-error text-error-content", stop: "bg-error text-error-content", warn: "bg-warning text-warning-content", recovering: "bg-info text-info-content",
};
const ICON: Record<NoticeRow["level"], keyof typeof LUCIDE> = { out: "gauge", stop: "circlePause", warn: "triangleAlert", recovering: "refresh" };

function Row({ row, confirming, onClear }: { row: NoticeRow; confirming: boolean; onClear: () => void }) {
  const t = useT();
  return (
    <div className={`${css.row} ${TONE[row.level]}`} data-quota-notice-row={row.family} data-level={row.level}>
      <Lucide size={16} name={ICON[row.level]} className={css.icon} />
      <div className={css.text}>
        <div className="font-semibold">{t(row.title.text, row.title.vars)}</div>
        {row.detail.length > 0 && <div className="opacity-85">{row.detail.map((d) => t(d.text, d.vars)).join(" · ")}</div>}
      </div>
      {row.canClear && (
        <button type="button" className="btn btn-ghost btn-xs -my-0.5 shrink-0 font-semibold" onClick={onClear}>
          {confirming ? t("确认已恢复？") : t("已恢复")}
        </button>
      )}
    </div>
  );
}

/** 进出动效：有行就挂上（先收着、下一帧展开）；没行了先收起，走完动效再卸 */
function useShown(rows: NoticeRow[]): { shown: NoticeRow[]; open: boolean } {
  const [last, setLast] = useState<{ sig: string; rows: NoticeRow[] }>({ sig: "", rows: [] });
  const [open, setOpen] = useState(false);
  const has = rows.length > 0;
  const sig = has ? JSON.stringify(rows) : "";
  if (has && last.sig !== sig) setLast({ sig, rows }); // 渲染期调整：记下最后一份行，收起动效期间照它画
  if (!has && open) setOpen(false); // 渲染期调整：没行了即开始收起，下次出现再走一遍展开
  useEffect(() => {
    if (has) {
      const raf = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(raf);
    }
    const timer = setTimeout(() => setLast({ sig: "", rows: [] }), EXIT_MS);
    return () => clearTimeout(timer);
  }, [has]);
  return { shown: has ? rows : last.rows, open: has && open };
}

export function QuotaNotice({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const nav = useChatNav();
  const fp = useMachineFp();
  const lines = useQuotaLinesReading();
  const wall = useQuotaWallReading();
  const [dismissed, setDismissed] = useState<NoticeDismiss>(() => readDismissed(fp));
  const [confirming, setConfirming] = useState(false);
  const unsaved = useRef<NoticeDismiss>({});

  useEffect(() => {
    const sync = () => setDismissed(mergeNoticeDismiss(readDismissed(fp), unsaved.current));
    sync(); // 切机器：按新机器的作用域重读
    const onStorage = (e: StorageEvent) => { if (e.key === NOTICE_DISMISS_KEY || e.key === null) sync(); };
    window.addEventListener("storage", onStorage); // 别的 tab 关掉的，这里也收起
    return () => window.removeEventListener("storage", onStorage);
  }, [fp]);

  const all = noticeRows(lines.fp === fp ? lines.value : null, wall.fp === fp ? wall.value : null, quotaNow(lines, wall));
  const rows = all.filter((r) => !isRowDismissed(dismissed, fp, r));
  const { shown, open } = useShown(rows);

  const dismiss = () => {
    const next = dismissRows(mergeNoticeDismiss(readDismissed(fp), unsaved.current), fp, rows);
    try {
      localStorage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(next));
      unsaved.current = {};
    } catch {
      unsaved.current = next; // 存不下：本页仍记着，下一次同步不会把它撤销
    }
    setDismissed(next);
    setConfirming(false);
  };

  const clear = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    api<{ cleared: boolean }>("/quota/wall/clear", { method: "POST", timeoutMs: 8000 })
      .then(reloadQuotaWall)
      .catch(() => {}); // 没清成：照旧挂着，下一次 30 秒轮询会显示真实状态
  };

  if (shown.length === 0 || typeof document === "undefined") return null;
  const card = (
    <div className={`${css.wrap} ${embedded ? css.embedded : ""}`} data-open={open ? "1" : "0"} data-testid="quota-notice">
      <div className={css.fold}>
        <div role="status" aria-label={t(Q.noticeLabel)} className={`${css.card} bg-base-100 text-base-content`} data-quota-notice>
          <div className={css.rows}>
            {shown.map((r) => <Row key={r.family} row={r} confirming={confirming} onClear={clear} />)}
          </div>
          <div className={css.side}>
            <button type="button" aria-label={t("关闭")} className="btn btn-circle btn-ghost btn-xs" onClick={dismiss}>
              <Lucide size={14} name="x" />
            </button>
            <button type="button" className="btn btn-ghost btn-xs whitespace-nowrap px-1.5 font-medium text-base-content/70" data-quota-notice-open
              onClick={() => openToday("team", nav)}>
              {t(Q.viewQuota)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
  return embedded ? card : createPortal(card, document.body);
}
