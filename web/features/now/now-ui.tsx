"use client";
/**
 * 「今天」各块共用的小件（TODAY1）：词表、块外框、行样式、选源（团队绑定）、点击去向。
 * 块文件（now-waits / now-stuck / now-doing / now-done / now-team）和 now-projects 都从这里取，now-home.tsx 只排顺序。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { resolveCollabSource, type CollabSourceChoice } from "@/lib/collab-source-binding";
import { useLang, useT } from "@/lib/i18n";
import { useChatStoreApi } from "../chat/chat-store";
import { rowOpenIntent } from "../chat/open-intent";
import { useChatNav } from "../chat/components/nav-context";
import { closeCollab, openCollab, openCollabTask } from "../collab/collab-nav";
import { useCollabBindings } from "../collab/team-view-entry";
import { nowTr } from "./now-i18n";

export type Translate = ReturnType<typeof nowTr>;
export type Source = (projectId: string) => CollabSourceChoice;

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;
export const LOCAL: CollabSourceChoice = { kind: "local" };
const localSource = () => LOCAL;

export const ROW = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors";
export const ROW_ON = `${ROW} hover:bg-base-300/50`;
export const EMPTY = "px-2 py-1 text-[13px] text-base-content/45";
/** 块与行的高度展开：grid 行 0fr ↔ 1fr，同 UXHOME1 侧栏条；motion-reduce 下不动 */
export const FOLD = "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none";

export function useNowT(): Translate {
  const lang = useLang(), t = useT();
  return useMemo(() => nowTr(lang, t), [lang, t]);
}

/** 一块：hook = 块的 DOM 钩子（data-now-waits 等），页面滚动与测试都按它找 */
export function Block({ title, count, hook, children }: { title: string; count?: string; hook: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 scroll-mt-4 rounded-xl border border-base-300 bg-base-100 p-3" aria-label={title} {...{ [`data-now-${hook}`]: "" }}>
      <h3 className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold text-base-content/80">
        <span>{title}</span>
        {count && <span className="text-[11px] font-normal text-base-content/45">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const FOLD_MS = 220;

/** 就地展开的一段（「还有 K 条」「其余 K 个项目」）：展开时才挂上（收起的行不在 DOM 里），先 0fr 下一帧 1fr 走高度动效；收起走完动效再卸 */
export function Fold({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [entered, setEntered] = useState(open);
  // 渲染期调整：展开即挂上，收起即开始收（不等 effect 再渲一轮）
  if (open && !mounted) setMounted(true);
  if (!open && entered) setEntered(false);
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    const timer = setTimeout(() => setMounted(false), FOLD_MS);
    return () => clearTimeout(timer);
  }, [open]);
  const shown = open && entered;
  if (!mounted) return null;
  return (
    <div className={`${FOLD} ${shown ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
      <div className="min-h-0 overflow-hidden" inert={!open}>{children}</div>
    </div>
  );
}

/** 点击去向：开会话 / 开项目 / 开项目里的某个任务；都落到主区（手机从列表页切过去） */
export function useOpeners() {
  const store = useChatStoreApi();
  const nav = useChatNav();
  return useMemo(() => ({
    agent: (name: string) => {
      closeCollab();
      void store.openAgent(name, rowOpenIntent());
      nav.toContent();
    },
    project: (key: string) => {
      openCollab(key);
      nav.toContent();
    },
    task: (project: string, task: string) => {
      openCollab(project);
      openCollabTask(task);
      nav.toContent();
    },
  }), [store, nav]);
}

/** 拿到选源后画什么（render prop：调用而不是当组件挂，换了函数也不重挂里面的组件） */
export type Render = (p: { source: Source; fp: string | null }) => React.ReactNode;

/** 这台机器的团队绑定（项目组入口读的同一份 store）→ 选源函数；没选机器就没有绑定，全按本机 */
function WithBindings({ fp, render }: { fp: string; render: Render }) {
  const { identities } = useCollabBindings(fp);
  const source = useMemo<Source>(() => (id) => resolveCollabSource(identities, id, fp), [identities, fp]);
  return render({ source, fp });
}

export function WithSource({ render }: { render: Render }) {
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  return fp ? <WithBindings key={fp} fp={fp} render={render} /> : render({ source: localSource, fp: null });
}
