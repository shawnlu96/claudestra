"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { Section } from "./section";
import { getGuardSettings, putGuardSettings, type GuardSettings } from "@/lib/api/guard";

/** 设置 → 安全 → 入站守门：开关 + 拦截阈值（docs/design-chat-guard.md）。Jev 没配时提示去连接与集成配 key。 */
export function GuardSection() {
  const t = useT();
  const [s, setS] = useState<GuardSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    getGuardSettings()
      .then(setS)
      .catch(() => {} /* 旧 bridge 没这个端点：分区显示为加载中，不影响别的设置 */);
  }, []);
  const save = async (patch: { mode?: "off" | "on"; blockAt?: number }) => {
    setBusy(true);
    setMsg("");
    try {
      setS(await putGuardSettings(patch));
      setMsg("已保存");
    } catch (e) {
      setMsg((e as Error).message || "保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title={t("入站守门（Chat Guard）")}
      desc={t("消息进入 agent 前先用 Jev 判定是否在套取敏感信息或要求破坏性操作；命中即隔离，需你放行。未配 Jev 时不生效。")}
    >
      {!s ? (
        <div className="text-xs text-base-content/50">…</div>
      ) : (
        <>
          <div className="text-[12px] text-base-content/60">
            {t("按会话开启：会话详情里的 Chat Guard 开关，或顶栏的盾牌图标。")}
            {!s.configured && <span className="ml-1 text-warning">{t("未配置 Jev key（连接与集成 → 集成）")}</span>}
          </div>
          <label className="mt-3 flex items-center justify-between gap-3 text-sm">
            <span>
              {t("拦截阈值")} <span className="font-mono text-[12px] text-base-content/60">{s.blockAt.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.01}
              value={s.blockAt}
              disabled={busy}
              className="range range-xs w-40"
              onChange={(e) => setS({ ...s, blockAt: Number(e.target.value) })}
              onMouseUp={(e) => void save({ blockAt: Number((e.target as HTMLInputElement).value) })}
              onTouchEnd={(e) => void save({ blockAt: Number((e.target as HTMLInputElement).value) })}
            />
          </label>
          {msg && <div className="mt-2 text-right text-xs text-base-content/60">{t(msg)}</div>}
        </>
      )}
    </Section>
  );
}
