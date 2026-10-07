/**
 * 截图 / 浏览器测试入口（只给 tests/web-collab-unified-browser.test.ts 打包用，生产导航不 import，不注册路由）：
 * 合成多机器——真的项目组 ProjectGroup（挂 UnifiedCollabEntry）+ 真的 N5 侧栏列表 + 真的 CollabSwitch 覆盖层，
 * 中继模式下请求按 /m/<fp>/api/v1/* 打到测试服务器，数据全部合成。
 */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { machines } from "@/lib/machines";
import { ChatStoreProvider } from "../chat/chat-store";
import { ChatNavContext } from "../chat/components/nav-context";
import { ProjectGroup } from "../chat/components/project-group";
import { SharedProjectsEntry } from "./shared-projects/projects-entry";
import { CollabSwitch } from "./collab-switch";
import { closeCollab, useCollabNav } from "./collab-nav";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
/** 每台机器的本机项目（本机 id 不同的两台绑定同一中心项目） */
const PROJECTS: Record<string, { id: string; name: string; emoji: string }[]> = JSON.parse(params.get("projects") ?? "{}");
const MACHINES = Object.keys(PROJECTS);

const subscribe = (cb: () => void) => machines.subscribe(cb);
const current = () => machines.currentFp();

function Probe() {
  const { project } = useCollabNav();
  useEffect(() => { document.body.dataset.open = project ?? ""; }, [project]);
  return null;
}

function Sidebar({ fp }: { fp: string }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return <nav aria-label="侧栏" className="flex h-full flex-col gap-2 overflow-y-auto p-2">
    <div className="flex gap-1 px-1 text-xs">{MACHINES.map((m) => <button key={m} type="button" data-machine={m}
      className={`btn btn-xs ${m === fp ? "btn-primary" : "btn-ghost"}`} onClick={() => void machines.setCurrent(m)}>{m}</button>)}</div>
    <ul className="flex list-none flex-col gap-1.5">
      {(PROJECTS[fp] ?? []).map((p) => <ProjectGroup key={p.id} collapsed={!!collapsed[p.id]} groupBusy={false}
        onToggle={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}
        e={{ kind: "group", id: p.id, items: [], nodes: [], meta: { id: p.id, name: p.name, emoji: p.emoji, dirs: [] } }}>
        <li className="px-2 py-1.5 text-[13px] opacity-60">（合成会话行）</li>
      </ProjectGroup>)}
    </ul>
    <SharedProjectsEntry />
  </nav>;
}

function Harness() {
  const fp = useSyncExternalStore(subscribe, current, () => null);
  const [wantContent, setShow] = useState(false);
  // 视图关掉（改绑 / 换机器）就回到列表，同生产里覆盖层收起后露出会话列表
  const openProject = useCollabNav().project;
  const showContent = wantContent && !!openProject;
  const nav = { showContent, toContent: () => setShow(true), toList: () => { closeCollab(); setShow(false); } };
  // 模拟手机系统返回（视图加载失败时没有返回按钮）
  useEffect(() => { (window as unknown as { __systemBack: () => void }).__systemBack = () => { closeCollab(); setShow(false); }; }, []);
  return <ChatStoreProvider>
    <ChatNavContext.Provider value={nav}>
      <Probe />
      <div className="flex h-screen w-full bg-base-100 text-base-content">
        <aside className={`h-full w-full shrink-0 border-r border-base-300 bg-base-200 sm:block sm:w-72 ${showContent ? "hidden" : "block"}`}>
          {fp && <Sidebar fp={fp} />}
        </aside>
        <main className={`relative h-full min-w-0 flex-1 flex-col sm:flex ${showContent ? "flex" : "hidden"}`}>
          <div className="relative min-h-0 flex-1"><CollabSwitch /></div>
        </main>
      </div>
    </ChatNavContext.Provider>
  </ChatStoreProvider>;
}

const first = params.get("machine") ?? MACHINES[0]!;
void Promise.all(MACHINES.map((fp) => machines.add({ fp, name: fp })))
  .then(() => machines.setCurrent(first))
  .then(() => createRoot(document.getElementById("root")!).render(<Harness />));
