"use client";
import { useState } from "react";
import { useChatStoreApi } from "../chat-store";
import { useT } from "@/lib/i18n";

/**
 * 侧栏会话行左滑露出的动作钮（从 agent-row.tsx 原样搬出）：置顶 / 归档 / 删除。
 * 只在滑开期间挂载——收回即卸载，「确认?」二次确认态随之复位，不必外面清。
 * 三格总宽由 agent-row.tsx 的 ACTIONS_W 决定（必须与滑动上限、吸附阈值同源）。
 */
export function SwipeActions({
  name,
  width,
  pinned,
  onTogglePin,
  closeSwipe,
}: {
  name: string;
  width: number;
  pinned: boolean;
  onTogglePin: () => void;
  closeSwipe: () => void;
}) {
  const t = useT();
  const store = useChatStoreApi();
  const [archiving, setArchiving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [removing, setRemoving] = useState(false);
  return (
    <div className="absolute inset-y-0 right-0 z-0 flex" style={{ width }}>
      <button
        className="flex flex-1 items-center justify-center bg-base-content/70 text-[13px] font-medium text-base-100"
        onClick={() => {
          onTogglePin();
          closeSwipe();
        }}
      >
        {pinned ? t("取消置顶") : t("置顶")}
      </button>
      {/* v2.23+ 归档：只给当前会话做快照（非破坏性），不动 agent 本身 ——
          owner 2026-09-14「给工作列表的也加入一个左滑归档按钮」 */}
      <button
        className="flex flex-1 items-center justify-center bg-base-300/80 text-[13px] font-medium text-base-content/80"
        onClick={async () => {
          if (archiving) return;
          setArchiving(true);
          const r = await store.archiveAgent(name);
          setArchiving(false);
          closeSwipe();
          if (!r.ok) alert(`${t("归档失败:")}${t(r.error || "操作失败")}`);
        }}
      >
        {archiving ? "…" : t("归档")}
      </button>
      <button
        className="flex flex-1 items-center justify-center bg-error text-[13px] font-medium text-error-content"
        onClick={async () => {
          if (removing) return;
          if (!confirmDel) {
            setConfirmDel(true);
            return;
          }
          setRemoving(true);
          const r = await store.removeAgent(name);
          if (!r.ok) {
            setRemoving(false);
            closeSwipe();
            alert(`${t("删除失败:")}${t(r.error || "操作失败")}`);
          }
          // 成功时本行随列表数据一起消失,无需复位
        }}
      >
        {removing ? "…" : confirmDel ? t("确认?") : t("删除")}
      </button>
    </div>
  );
}
