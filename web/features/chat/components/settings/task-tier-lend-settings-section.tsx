"use client";
/**
 * 出借方「接受降档建议」开关（TIER3b，bridge local-api/task-tier-lend-settings.ts：GET / PUT /settings/task-tier-lend）。独立组件，不动角色表组件。
 * 403 / 404 = 这台设备不给看（guest、部分 scope、peer）或 bridge 太旧：整块不渲染。409 = 别处先改了，按回包里的现值刷新。
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

interface TierLendView { ok: true; status: "missing" | "ok" | "invalid" | "unreadable"; acceptDowngrade: boolean; rev: number }
const PATH = "/settings/task-tier-lend";

export function TaskTierLendSettingsSection() {
  const t = useT();
  const [view, setView] = useState<TierLendView | null | "hidden">(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<TierLendView>(PATH, { timeoutMs: 8000 })
      .then((v) => { if (live) setView(v); })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setView("hidden");
        else setErr(e instanceof Error ? e.message : String(e));
      });
    return () => { live = false; };
  }, []);

  const toggle = useCallback(async () => {
    if (!view || view === "hidden") return;
    setBusy(true);
    setErr(null);
    try {
      setView(await api<TierLendView>(PATH, { method: "PUT", json: { rev: view.rev, acceptDowngrade: !view.acceptDowngrade }, timeoutMs: 8000 }));
    } catch (e) {
      const cur = e instanceof ApiError && e.status === 409 ? e.body.current : null;
      if (cur && typeof cur === "object") setView(cur as TierLendView);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [view]);

  if (view === "hidden") return null;
  const v = view;
  return (
    <Section
      title={t("出借：接受降档建议")}
      aside={<input type="checkbox" className="toggle toggle-sm shrink-0" checked={v?.acceptDowngrade === true} disabled={busy || !v} onChange={() => void toggle()} />}
      desc={t("借入方随单建议更低的模型或推理档时，在你的出借授权内照建议起 worker；只降不升，security 卡不降。关闭后完全按授权起。")}
    >
      {v && (v.status === "invalid" || v.status === "unreadable") ? <div className="text-xs text-warning">{t("设置文件无效，当前按不接受降档执行")}</div> : null}
      {err ? <div className="text-xs text-error">{err}</div> : null}
    </Section>
  );
}
