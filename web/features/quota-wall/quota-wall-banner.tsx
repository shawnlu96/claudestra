"use client";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { wallBanner, type WallResponse } from "./wall-banner-model";

/**
 * 额度闸横幅（bridge/quota-wall.ts）：全机撞额度时顶部一条，写明重置时间、排队几条、恢复后自动送达；
 * 「已恢复」= manager quota-wall clear（点两下确认）。页面可见时 30 秒拉一次 GET /quota/wall；
 * 只给 owner（非 owner 403 / 老 bridge 404 就此不再拉）。关掉的横幅按「这道闸 + 状态」记在本机，状态变了再弹。
 */
const POLL_MS = 30_000;
const DISMISS_KEY = "cstra_quota_wall_dismissed";

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    return ""; // 隐私模式 / 禁用存储：关掉只在这次页面里有效
  }
}

export function QuotaWallBanner({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const [data, setData] = useState<WallResponse | null>(null);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const load = () => {
      if (stop || document.visibilityState !== "visible") return;
      setNow(Date.now());
      api<WallResponse>("/quota/wall", { timeoutMs: 8000 })
        .then((r) => !stop && setData(r))
        .catch((e) => {
          if (e instanceof ApiError && [403, 404].includes(e.status)) {
            stop = true; // 不是 owner / bridge 太老：这个页面里不再拉
            if (timer) clearInterval(timer);
          } else console.debug("额度闸横幅拉取失败（保持上次的横幅，下一次轮询再试）:", e);
        });
    };
    load();
    timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const b = wallBanner(data, now);
  if (!b || dismissed === b.key) return null;

  const dismiss = () => {
    setDismissed(b.key);
    try {
      localStorage.setItem(DISMISS_KEY, b.key);
    } catch {
      /* 存不下：只在这次页面里关掉，刷新后会再出现，无害 */
    }
  };
  const clear = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    api<{ cleared: boolean }>("/quota/wall/clear", { method: "POST", timeoutMs: 8000 })
      .then(() => api<WallResponse>("/quota/wall", { timeoutMs: 8000 }).then(setData))
      .catch(() => {}); // 没清成：横幅照旧挂着，下一次 30 秒轮询会显示真实状态
  };

  const tone = b.tone === "warning" ? "bg-warning text-warning-content" : "bg-info text-info-content";
  return (
    <div className={`pointer-events-none flex justify-center px-4 ${embedded ? "py-1.5" : "fixed inset-x-0 z-[68]"}`}
      style={embedded ? undefined : { top: "calc(env(safe-area-inset-top) + 56px)" }}>
      <div role="status" className={`pointer-events-auto flex max-w-[640px] items-start gap-2 rounded-2xl py-2 pl-3 pr-1.5 text-[12.5px] shadow-lg ${tone}`}>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" aria-hidden>
          {/* lucide gauge */}
          <path d="m12 14 4-4" />
          <path d="M3.34 19a10 10 0 1 1 17.32 0" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{t(b.title)}</div>
          {b.detail.length > 0 && <div className="opacity-85">{b.detail.map((d) => t(d.text, d.vars)).join(" · ")}</div>}
        </div>
        {b.canClear && (
          <button type="button" className="btn btn-ghost btn-xs shrink-0 font-semibold" onClick={clear}>
            {confirming ? t("确认已恢复？") : t("已恢复")}
          </button>
        )}
        <button type="button" aria-label={t("关闭")} className="btn btn-circle btn-ghost btn-xs shrink-0" onClick={dismiss}>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
