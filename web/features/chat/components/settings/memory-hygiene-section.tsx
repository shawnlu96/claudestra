"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";

/** 记忆卫生(owner 2026-08-26):mem0 定期审查的开关+频率,事实源是 cron 任务 */
export function useMemoryHygiene(open: boolean) {
  const [hyg, setHyg] = useState<{
    exists: boolean;
    enabled: boolean;
    freq: string | null;
    schedule: string | null;
    lastRun: string | null;
    nextRun: string | null;
  } | null>(null);
  const [hygBusy, setHygBusy] = useState(false);
  const [hygMsg, setHygMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    // 记忆卫生状态
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setHygMsg("");
    fetch("/api/memory-hygiene")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setHyg(j);
        else setHygMsg(j?.error || "读取失败");
      })
      .catch(() => setHygMsg("读取失败"));
  }, [open]);

  // 记忆卫生写入:开关/频率共用一条路,bridge 侧同步 cron 任务
  const saveHyg = async (enabled: boolean, freq: string) => {
    setHygBusy(true);
    setHygMsg("");
    try {
      const r = await fetch("/api/memory-hygiene", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, freq }),
      });
      const j = await r.json();
      if (j?.ok) setHyg(j);
      else setHygMsg(j?.error || "保存失败");
    } catch {
      setHygMsg("保存失败");
    } finally {
      setHygBusy(false);
    }
  };

  return { hyg, hygBusy, hygMsg, saveHyg };
}

/** 记忆卫生(owner 2026-08-26:「mem0 会变粪坑」) */
export function MemoryHygieneSection({ hygiene }: { hygiene: ReturnType<typeof useMemoryHygiene> }) {
  const t = useT();
  const { hyg, hygBusy, hygMsg, saveHyg } = hygiene;
  return (
        <Section
          title={t("记忆卫生（mem0）")}
          aside={
            <input
              type="checkbox"
              className="toggle toggle-sm shrink-0"
              checked={!!hyg?.enabled}
              disabled={hygBusy || !hyg}
              onChange={() => void saveHyg(!hyg?.enabled, hyg?.freq && hyg.freq !== "custom" ? hyg.freq : "weekly")}
            />
          }
          desc={t("定期审查 mem0 记忆库:找出过时/矛盾/重复的记忆,出报告供处置——只报告不动手。")}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              {t("频率")}
              <select
                className="select select-sm select-bordered"
                value={hyg?.freq && hyg.freq !== "custom" ? hyg.freq : "weekly"}
                disabled={hygBusy || !hyg?.enabled}
                onChange={(e) => void saveHyg(true, e.target.value)}
              >
                <option value="weekly">{t("每周（周一）")}</option>
                <option value="biweekly">{t("半月（1/15 号）")}</option>
                <option value="monthly">{t("每月（1 号）")}</option>
              </select>
            </label>
            {hyg?.freq === "custom" && hyg.schedule && (
              <span className="text-xs text-base-content/50">
                {t("当前为手工表达式")} <code>{hyg.schedule}</code>
              </span>
            )}
          </div>
          {hyg?.enabled && (hyg.lastRun || hyg.nextRun) && (
            <div className="mt-2 text-xs text-base-content/50">
              {hyg.lastRun ? `${t("上次")} ${new Date(hyg.lastRun).toLocaleString()} · ` : ""}
              {hyg.nextRun ? `${t("下次")} ${new Date(hyg.nextRun).toLocaleString()}` : ""}
            </div>
          )}
          {hygMsg && <div className="mt-2 text-xs text-error/80">{t(hygMsg)}</div>}
        </Section>
  );
}
