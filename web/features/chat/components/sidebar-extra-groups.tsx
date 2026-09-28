"use client";
import { ContactsGroup } from "./contacts-group";
import { UnmanagedSessions } from "./unmanaged-sessions";
import { ArchivedSessions } from "./archived-sessions";

/** 会话列表下方、版本行之上的附加分组：联系人（只读 peer 在线）、未纳管会话、归档。sidebar.tsx 在行数上限上，新增分组加在这里 */
export function SidebarExtraGroups() {
  return (
    <>
      <ContactsGroup />
      <UnmanagedSessions />
      <ArchivedSessions />
    </>
  );
}
