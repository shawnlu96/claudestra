"use client";
import { useFullScope } from "../contacts-data";
import { UnmanagedSessions } from "./unmanaged-sessions";
import { ArchivedSessions } from "./archived-sessions";

/**
 * 会话列表下方、版本行之上的附加分组：未纳管会话、归档。sidebar.tsx 在行数上限上，新增分组加在这里。
 * peer 联系人不放这里：在线摘要在顶栏 Peer 按钮上，明细在 Peer 面板（contacts-lines.tsx），不占会话列表的空间。
 * 未纳管会话 / 归档是宿主机的会话清单，只给全权设备：guest、部分 scope 的设备不出入口（点进去也只会 403）。
 */
export function SidebarExtraGroups() {
  const full = useFullScope() === true;
  return (
    <>
      {full && <UnmanagedSessions />}
      {full && <ArchivedSessions />}
    </>
  );
}
