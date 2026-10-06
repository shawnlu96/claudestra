"use client";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { quota, quotaCodexReset, quotaRetry } from "@/lib/api/system";
import { resetOutcome, type ResetOutcome } from "./quota-reset";
import { quotaPanelData, type QuotaPanelData } from "./quota-view";

/**
 * 用量看板的订阅额度数据（bridge GET /api/v1/quota）：看板打开期间每 60 秒拉一次，页面在后台不拉——
 * 这就是 bridge 判「有人在看」的心跳（没人看它降到 5 分钟一次，也不读 Keychain）。
 * sub = null → 面板退回旧额度卡：非 owner 403 / 老 bridge 404 / 服务没起 503；其它网络错误沿用上一次的卡片组，不来回闪。
 */
export function useSubscriptionQuota(open: boolean) {
  const [sub, setSub] = useState<QuotaPanelData | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = () =>
    quota<unknown>()
      .then((j) => setSub(quotaPanelData(j)))
      .catch((e) => {
        if (e instanceof ApiError && [403, 404, 503].includes(e.status)) setSub(null);
      });

  const retry = (p: "claude" | "codex") => {
    setRetrying(true);
    quotaRetry(p)
      .catch(() => {}) // 重试的结果看下一次快照的「数据」行；这里失败只是没触发成，照样重拉一次
      .then(load)
      .finally(() => setRetrying(false));
  };

  const [resetRunning, setResetRunning] = useState(false);
  const [resetResult, setResetResult] = useState<ResetOutcome | null>(null);
  /** 使用一张 Codex 重置卡：结果留在这里（用掉最后一张后那一行会消失，结果不能跟着丢）；不管成败都重拉快照（bridge 已把事后现拉的数入库） */
  const consumeReset = (key: string) => {
    setResetRunning(true);
    setResetResult(null);
    quotaCodexReset<unknown>(key)
      .then((j) => resetOutcome(200, j))
      .catch((e) => (e instanceof ApiError ? resetOutcome(e.status, e.body) : resetOutcome(0, null)))
      .then(setResetResult)
      .finally(() => {
        setResetRunning(false);
        void load();
      });
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const tick = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [open]);

  return { sub, retrying, retry, reload: load, reset: { run: consumeReset, running: resetRunning, outcome: resetResult } };
}
