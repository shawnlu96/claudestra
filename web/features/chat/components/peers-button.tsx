"use client";
import { useT } from "@/lib/i18n";
import { usePeerOnline } from "./contacts-lines";

/**
 * 侧栏顶部的 Peer 入口：点击打开设置弹窗并直达「Peer 协作」页——设置是统一入口，这里只是一个特定页的快捷方式。
 * 有 peer 时图标旁带在线摘要（状态点 + 在线数），明细（每个 peer 开放给我的 agent 与忙闲）在 Peer 页里；
 * 联系人不再单独占会话列表下方的空间（owner 2026-09-29）。样式与同排的项目 / 用量 / 设置按钮一致。
 */
export function PeersButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const sum = usePeerOnline();
  const label = sum ? `${t("Peer 协作")} · ${t("{n}/{total} 在线", { n: sum.online, total: sum.total })}` : t("Peer 协作");
  return (
    <button
      className="flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg px-1.5 text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      {sum && (
        <span className="flex items-center gap-0.5 text-[11px] font-medium tabular-nums" aria-hidden>
          <span className={`size-1.5 rounded-full ${sum.online ? "bg-success" : "bg-base-content/25"}`} />
          {sum.online}
        </span>
      )}
    </button>
  );
}
