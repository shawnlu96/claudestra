"use client";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { useChatStoreApi } from "../chat-store";
import { setAgentGuard } from "../agent-info";
import { openSettings } from "../settings-open";
import { CenteredModal } from "./centered-modal";

/**
 * Chat Guard 的按会话开关（owner 2026-09-28）：默认关；打开时 bridge 先确认 Jev 配好且能通，不通回 409 jev_not_configured /
 * jev_failed → 这里弹框，给「打开设置 → 集成」直达。会话详情里的行与顶栏盾牌共用这一个 hook + 弹框。
 */
export function useGuardToggle(name: string | undefined, onChanged?: () => void) {
  const store = useChatStoreApi();
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<{ code: string; error: string } | null>(null);
  const toggle = async (on: boolean) => {
    if (!name) return;
    setBusy(true);
    try {
      const r = await setAgentGuard(name, on);
      if (!r.ok) setPrompt({ code: r.code ?? "error", error: r.error });
      else {
        void store.refreshAgents();
        onChanged?.();
      }
    } finally {
      setBusy(false);
    }
  };
  return { busy, prompt, closePrompt: () => setPrompt(null), toggle };
}

export function GuardPrompt({ p, onClose }: { p: { code: string; error: string }; onClose: () => void }) {
  const t = useT();
  const notConfigured = p.code === "jev_not_configured";
  return (
    <CenteredModal onClose={onClose}>
      <div className="p-5">
        <h3 className="text-base font-semibold">{t("无法开启 Chat Guard")}</h3>
        <p className="mt-2 text-[13px] text-base-content/80">
          {notConfigured ? t("Chat Guard 依赖 Jev（TypeSafe）判定，还没有配置 API key。") : t("Jev 连接测试没有通过：")}
          {!notConfigured && <span className="ml-1 font-mono text-[12px] text-error">{p.error}</span>}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>{t("取消")}</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              onClose();
              openSettings("connect");
            }}
          >
            {t("打开设置 → 集成")}
          </button>
        </div>
      </div>
    </CenteredModal>
  );
}
