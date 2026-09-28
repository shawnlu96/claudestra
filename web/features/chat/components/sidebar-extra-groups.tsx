"use client";
import { useFullScope } from "../contacts-data";
import { ContactsGroup } from "./contacts-group";
import { UnmanagedSessions } from "./unmanaged-sessions";
import { ArchivedSessions } from "./archived-sessions";

/**
 * 会话列表下方、版本行之上的附加分组：联系人（只读 peer 在线）、未纳管会话、归档。sidebar.tsx 在行数上限上，新增分组加在这里。
 * 未纳管会话 / 归档是宿主机的会话清单，只给全权设备：guest、部分 scope 的设备不出入口（点进去也只会 403）。
 */
export function SidebarExtraGroups() {
  const full = useFullScope() === true;
  return (
    <>
      <ContactsGroup />
      {full && <UnmanagedSessions />}
      {full && <ArchivedSessions />}
    </>
  );
}
