"use client";
/**
 * 声明了、但没生效的借入（borrow-model stalePeers）：一条不漏地列出来，图标 + 短原因，删除；联系人还在的（声明的项目全失效）
 * 还能点笔重选项目，原地换成选择表单。删除走 dropPeer（淡出 → 立刻不再渲染），失败抖被点的按钮。
 */
import { useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import type { BorrowView } from "./borrow-api";
import type { StalePeer, StaleReason } from "./borrow-model";
import { dropPeer, type Feed } from "./borrow-feed";
import { NewPeer } from "./borrow-new-peer";
import { CircleAlertIcon, PencilIcon, ServerIcon, TrashIcon } from "./icons";
import { fadeOut, shake } from "./motion";

const REASON_TEXT: Record<StaleReason, string> = {
  contact_gone: "联系人已删除", contact_disabled: "联系人已禁用", fp_changed: "对方实例换了", projects_gone: "项目都已失效",
};

export function StaleEntry({ s, view, canWrite, feed }: { s: StalePeer; view: BorrowView; canWrite: boolean; feed: Feed }) {
  const t = useT();
  const row = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [repick, setRepick] = useState(false);
  if (repick) return <NewPeer peer={s.peer} view={view} onCancel={() => setRepick(false)} onChanged={feed.load} />;
  const drop = async (el: HTMLElement) => {
    setBusy(true);
    await dropPeer(s.peer, feed, { fade: () => fadeOut(row.current), fail: () => shake(el) });
    setBusy(false);
  };
  return (
    <div ref={row} className="flex min-w-0 items-center gap-2 rounded-lg bg-base-100 px-3 py-2 text-[12px] text-base-content/45">
      <ServerIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-mono line-through">{s.peer}</span>
      <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-warning/80">
        <CircleAlertIcon className="size-3 shrink-0" />
        <span className="truncate">{t(REASON_TEXT[s.reason])}</span>
      </span>
      {canWrite && (
        <span className="ml-auto inline-flex shrink-0 items-center">
          {s.canRepick && (
            <button className="btn btn-ghost btn-xs btn-square" disabled={busy} aria-label={t("重选项目")} onClick={() => setRepick(true)}>
              <PencilIcon className="size-3.5" />
            </button>
          )}
          <button className="btn btn-ghost btn-xs btn-square" disabled={busy} aria-label={t("移除")} onClick={(e) => void drop(e.currentTarget)}>
            <TrashIcon className="size-3.5" />
          </button>
        </span>
      )}
    </div>
  );
}
