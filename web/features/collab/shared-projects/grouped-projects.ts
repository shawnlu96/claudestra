/**
 * 侧栏「团队」区该列哪些项目行（UXHOME1）：本机项目此刻在侧栏成组的，组里已有「协作视图」那一行，团队区不再重复；
 * 不成组的（单成员、搜索中、没有会话）保留原来的入口。哪些成组由 sidebar.tsx 已算好的目录条目给，这里不重抄成组规则。
 * 不 import react（tests/web-shared-projects-grouped.test.ts 直接测）。
 */
import { boundProjects, type ProjectSnapshot, type SharedProject } from "@/lib/shared-projects-model";

/** 目录条目里只看这两项；sidebar-entries.ts 的 SidebarEntry 满足它 */
export interface DirectoryEntryLike { kind: string; id?: string }

/** 此刻在侧栏成组的本机项目 id */
export function groupedProjectIds(entries: readonly DirectoryEntryLike[] = []): Set<string> {
  return new Set(entries.flatMap((e) => (e.kind === "group" && e.id ? [e.id] : [])));
}

/** 团队区的行：已绑定、可用的团队项目里，去掉本机项目正成组的那些 */
export function teamAreaProjects(snapshot: ProjectSnapshot, grouped: ReadonlySet<string>): SharedProject[] {
  return boundProjects(snapshot).filter((p) => !grouped.has(p.local!.id));
}
