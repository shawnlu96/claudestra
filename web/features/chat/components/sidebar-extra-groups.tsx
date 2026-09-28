"use client";
import { UnmanagedSessions } from "./unmanaged-sessions";
import { ArchivedSessions } from "./archived-sessions";

/**
 * 会话列表下方、版本行之上的附加分组：未纳管会话、归档。sidebar.tsx 在行数上限上，新增分组加在这里。
 * peer 联系人不放这里：在线摘要在顶栏 Peer 按钮上，明细在 Peer 面板（contacts-lines.tsx），不占会话列表的空间。
 */
export function SidebarExtraGroups() {
  return (
    <>
      <UnmanagedSessions />
      <ArchivedSessions />
    </>
  );
}
