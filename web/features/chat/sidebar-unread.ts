import { entryMembers, type SidebarEntry } from "./sidebar-entries";
import type { AgentSession } from "./type";

export const memberUnread = (members: AgentSession[]): number => members.reduce((n, a) => n + (a.unread ?? 0), 0);
export const entryUnread = (entry: SidebarEntry): number => memberUnread(entryMembers(entry));
export const entriesUnread = (entries: SidebarEntry[]): number => entries.reduce((n, e) => n + entryUnread(e), 0);
