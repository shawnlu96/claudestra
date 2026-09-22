"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { autoCompactOptions, fmtTokens, type AutoCompactState } from "./auto-compact-options";
import { Section } from "./section";

/** 自动存记忆+Compact(owner 2026-08-27「设置里看不到」):阈值+闲置门槛,写 config.json */
export function useAutoCompact(open: boolean) {
  const [ac, setAc] = useState<AutoCompactState | null>(null);
  const [acBusy, setAcBusy] = useState(false);
  const [acMsg, setAcMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    // autoCompact 配置
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时重置：拆分前与语音 Key 同属一个 effect（那条 warning 留在 groq-key-section），不新增基线
    setAcMsg("");
    fetch("/api/auto-compact")
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setAc(j);
        else setAcMsg(j?.error || "读取失败");
      })
      .catch(() => setAcMsg("读取失败"));
  }, [open]);

  // autoCompact 写入:两个下拉共用一条路,POST 后用 bridge 回读的状态刷新
  const saveAc = async (patch: { window?: number; idleHours?: number; emergency?: boolean }) => {
    setAcBusy(true);
    setAcMsg("");
    try {
      const r = await fetch("/api/auto-compact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (j?.ok) setAc(j);
      else setAcMsg(j?.error || "保存失败");
    } catch {
      setAcMsg("保存失败");
    } finally {
      setAcBusy(false);
    }
  };

  return { ac, acBusy, acMsg, saveAc };
}

/** 自动存记忆+Compact(owner 2026-08-27:「设置里看不到」) */
export function AutoCompactSection({ autoCompact }: { autoCompact: ReturnType<typeof useAutoCompact> }) {
  const t = useT();
  const { ac, acBusy, acMsg, saveAc } = autoCompact;
  // 当前生效值(null=未设→用默认);选项表兜住手工改过的非标准值
  const { acWindow, acIdle, acWindowOpts, acIdleOpts } = autoCompactOptions(ac);
  return (
        <Section
          title={t("自动存记忆 + Compact")}
          desc={t("常规线:上下文超过阈值且闲置满时长后,先抢救记忆再压缩上下文,对所有 agent 生效;实际触发线取「此阈值」与「该 agent 真实窗口 85%」的较小者。救命线:涨到真实窗口 93%(1M = 930K)时无视闲置门槛强制触发一次——Claude Code 自己在 ~967K 裸压且不存记忆,这是最后一道兜底,常规线关了它也在。")}
        >
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              {t("上下文阈值")}
              <select
                className="select select-sm select-bordered"
                value={acWindow === null ? "" : String(acWindow)}
                disabled={acBusy || !ac}
                onChange={(e) => void saveAc({ window: Number(e.target.value) })}
              >
                {acWindowOpts.map((w) => (
                  <option key={w} value={String(w)}>
                    {fmtTokens(w)}
                    {ac && w === ac.defaults.window ? ` (${t("默认")})` : ""}
                  </option>
                ))}
                <option value="0">{t("关闭")}</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              {t("闲置时长")}
              <select
                className="select select-sm select-bordered"
                value={acIdle === null ? "" : String(acIdle)}
                disabled={acBusy || !ac || acWindow === 0}
                onChange={(e) => void saveAc({ idleHours: Number(e.target.value) })}
              >
                {acIdleOpts.map((h) => (
                  <option key={h} value={String(h)}>
                    {h === 0 ? t("立即") : `${h} ${t("小时")}`}
                    {ac && h === ac.defaults.idleHours ? ` (${t("默认")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            {/* 救命线独立于常规线:window=0 时也可用(这正是它存在的意义) */}
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                className="toggle toggle-sm toggle-error"
                checked={ac?.emergency !== false}
                disabled={acBusy || !ac}
                onChange={(e) => void saveAc({ emergency: e.target.checked })}
              />
              {t("93% 救命线")}
            </label>
          </div>
          {acMsg && <div className="mt-2 text-xs text-error/80">{t(acMsg)}</div>}
        </Section>
  );
}
