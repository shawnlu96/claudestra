"use client";
import { useT } from "@/lib/i18n";
import { useChatStore } from "../chat-store";
import { useGuardMark } from "../guard-store";

/**
 * 用户气泡底部的守门标记（owner 2026-09-28「被拦截丢弃的对话…告知用户已被丢弃」）：
 * 乐观气泡的文本与 guard 事件带的原文逐字对上就标——被拦下等放行 / 已丢弃；放行后标记消失（消息会正常进历史）。
 * 刷新后乐观气泡本来就不在（被拦的消息从未进历史），所以标记只需活在本次页面里。
 */
export function GuardMark({ text }: { text: string }) {
  const t = useT();
  const agent = useChatStore((s) => s.state.activeAgent);
  const mark = useGuardMark(agent ?? undefined, text);
  if (!mark) return null;
  return mark === "dropped" ? (
    <div className="mt-1.5 flex items-center gap-1 border-t border-base-content/10 pt-1.5 text-[11px] font-medium text-base-content/45 line-through decoration-base-content/40">
      🗑 {t("已被守门丢弃，未送达 agent")}
    </div>
  ) : (
    <div className="mt-1.5 flex items-center gap-1 border-t border-warning/30 pt-1.5 text-[11px] font-medium text-warning">
      ⛔ {t("已被守门拦下，等待放行")}
    </div>
  );
}
