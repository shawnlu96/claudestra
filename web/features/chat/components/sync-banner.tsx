"use client";
import { useT } from "@/lib/i18n";
import { useChatStore, useChatStoreApi } from "../chat-store";
import { useMinVisible } from "../use-min-visible";

/** v2.17.2 对齐/连接横幅(owner 2026-08-08:「小徽章太隐蔽,要让用户知道系统
 *  在努力」)。消息区顶部居中的实色浮动 chip,零布局位移;严重度取一:
 *  同步失败(可点重试) > 同步中 > 重连中;最短亮 1.2s,消失 = 已是最新。
 *  空视图(骨架屏/全屏错误态)与历史现场不亮。 */
export function SyncBanner() {
  const t = useT();
  const syncState = useChatStore((s) => s.state.syncState);
  const streamDown = useChatStore((s) => s.state.streamDown);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const historyError = useChatStore((s) => s.state.historyError);
  const browsing = useChatStore((s) => s.state.browsing);
  const active = useChatStore((s) => s.state.activeAgent);
  const store = useChatStoreApi();
  const raw =
    !active || loadingHistory || historyError || browsing
      ? null
      : syncState === "error"
        ? "error"
        : syncState === "syncing"
          ? "syncing"
          : streamDown
            ? "streamDown"
            : null;
  // error 不吃最短亮灯(它本来就常驻到重试);syncing/streamDown 保底 1.2s
  const held = useMinVisible(raw === "error" ? null : raw);
  const kind = raw === "error" ? "error" : held;
  if (!kind) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      {kind === "error" ? (
        <button
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-warning px-4 py-1.5 text-[12.5px] font-semibold text-warning-content shadow-lg"
          onClick={() => store.retrySync()}
        >
          ⚠️ {t("同步失败 · 点按重试")}
        </button>
      ) : (
        <span className="pointer-events-auto flex items-center gap-2 rounded-full border border-base-300/70 bg-base-100/85 px-4 py-1.5 text-[12.5px] font-medium text-base-content/80 shadow-lg backdrop-blur-md">
          <span className="loading loading-spinner w-3.5 text-primary" />
          {kind === "syncing" ? t("正在同步最新消息…") : t("连接断开 · 重连中…")}
        </span>
      )}
    </div>
  );
}
