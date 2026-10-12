"use client";
import { useT } from "@/lib/i18n";
import { useGuardMark } from "../guard-store";

/**
 * 用户气泡底部的守门标记（owner 2026-09-28）。两个来源：
 * - 本页实时：发送接口回 guarded 时按气泡 id 记下，之后的 guard 事件按 messageId 认回这个气泡 → 拦下等放行 / 已丢弃（guard-store marks）；
 * - 持久记录：历史加载时 lib/chat/history-guard.ts 把隔离区的 dropped 合成气泡、给放行过的消息打 guard="released"。
 */
export function GuardMark({ id, guard, guardBy }: { id: string; guard?: "dropped" | "released"; guardBy?: string }) {
  const t = useT();
  const live = useGuardMark(id);
  const state = live ?? guard ?? null;
  if (!state) return null;
  const by = guardBy ? ` · ${guardBy}` : "";
  if (state === "dropped") {
    return (
      <div className="mt-1.5 flex items-center gap-1 border-t border-base-content/10 pt-1.5 text-[11px] font-medium text-base-content/45 line-through decoration-base-content/40">
        🗑 {t("已被守门丢弃，未送达 agent")}{by}
      </div>
    );
  }
  if (state === "released") {
    return (
      <div className="mt-1.5 flex items-center gap-1 border-t border-base-content/10 pt-1.5 text-[11px] font-medium text-base-content/50">
        🛡 {t("触发过守门，已人工放行")}{by}
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex items-center gap-1 border-t border-warning/30 pt-1.5 text-[11px] font-medium text-warning">
      ⛔ {t("已被守门拦下，等待放行")}
    </div>
  );
}
