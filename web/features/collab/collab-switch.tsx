"use client";
import { SharedCollabContent } from "./dag/shared-navigation";
import { closingCollab as closingCollabOnly } from "./dag/shared-closing";
export { CollabSidebarGate } from "./collab-sidebar";
/**
 * 协作视图挂在会话主区域上面的一层（main 里一行 <CollabSwitch />）：打开时盖住聊天，聊天在底下照常挂着，
 * 关掉就是原来的会话、不用重载。点侧栏任何会话都先关掉它（closingCollab 包住 Sidebar 的 onSelect）。
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { markRead } from "../chat/scoped-requests";
import { machines } from "@/lib/machines";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { CollabPaneBoundary } from "@/components/boundaries";
import { CollabView } from "./collab-view";
import { closeCollab, takeReleasedReads, useCollabNav } from "./collab-nav";
import { CollabSidebarRail } from "./collab-sidebar";
import { NowPage, TODAY_KEY } from "../now/now-home";
import { RosterPage } from "./team/roster-page";
import { leaveV2Main, V2MainHost } from "../nav/v2-host";
import { useNavV2 } from "../nav/nav-v2";
import { ProjectV2Page } from "./project-v2-page";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;

const leaving = new WeakMap<() => void, () => void>();
/** 点侧栏会话 / 通知直达：先收起协作视图；电脑新版宿主在主区盖着今天等页时也退回「会话」露出聊天。同一个 fn 包出同一个函数 */
export function closingCollab(fn: () => void): () => void {
  let w = leaving.get(fn);
  if (!w) {
    const inner = closingCollabOnly(fn);
    w = () => { leaveV2Main(); inner(); };
    leaving.set(fn, w);
  }
  return w;
}

/** 关掉协作视图后等会话切换落定（侧栏点会话是双 rAF 后才 openAgent）再判断停在哪个会话 */
const SETTLE_MS = 400;

/** notices = 聊天顶上的同步条与更新提示：电脑新版宿主盖住聊天时由它挂一份 */
export function CollabSwitch({ notices }: { notices?: ReactNode } = {}) {
  const { project, view } = useCollabNav();
  const store = useChatStoreApi();
  // 会话从别处换了（通知直达、深链、⌘K）：别让它被盖在协作视图底下
  const active = useChatStore((st) => st.state.activeAgent);
  const seen = useRef(active);
  useEffect(() => {
    if (seen.current !== active) closeCollab();
    seen.current = active;
  }, [active]);
  // 切机器（哪怕没选中会话）：协作视图是上一台机器的台账，收起来；此刻动作 / 推进记录随组件卸载一起清掉
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  const seenFp = useRef(fp);
  useEffect(() => {
    if (seenFp.current !== fp) closeCollab();
    seenFp.current = fp;
  }, [fp]);
  // 收起后如果停在的正是盖着期间被拦下已读的那个会话，替它补一次（markActiveRead 有 5s 节流，被吞的那次已经占了额度）
  useEffect(() => {
    if (project) return;
    const held = takeReleasedReads();
    if (!held.length) return;
    const timer = setTimeout(() => {
      const cur = store.state.activeAgent;
      if (cur && held.includes(cur)) void markRead(cur).catch(() => undefined); // 失败无感：下一次打开 / 看着时收到回复会再补
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [project, store]);
  const v2 = useNavV2();
  const content = project && <SharedCollabContent project={project} fallback={<CollabView project={project} />} />;
  return (
    <>
      <V2MainHost on={v2} notices={notices} />
      {project && (
        <div className="absolute inset-0 z-[45] flex bg-base-100">
          {project === TODAY_KEY ? <NowPage onClose={closeCollab} /> : (
            <>
              <CollabSidebarRail />
              <CollabPaneBoundary key={`${view ?? ""}:${project}`} onClose={closeCollab}>
                {view === "team" ? <RosterPage project={project} /> : v2 ? <ProjectV2Page progress={content} {...projectProps(fp, project)} /> : content}
              </CollabPaneBoundary>
            </>
          )}
        </div>
      )}
    </>
  );
}

/** 协作层里的项目页没有宿主的入口 / 子页，只传机器与项目；返回 = 收起协作视图 */
const projectProps = (fp: string | null, project: string) =>
  ({ fp, project, from: null, narrow: false, onBack: closeCollab, open: () => undefined, items: [], version: null });
