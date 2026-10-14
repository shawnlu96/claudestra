"use client";
/**
 * 「现在」总览（UXHOME1）：谁在干活、等你的事、各项目。一个组件两种排版——
 * NowPage = 桌面没选会话时的主区（message-list.tsx 的空状态）；NowStrip = 侧栏列表最上方的一条，收起时一行、点开原地展开同样的三块。
 * 数据全部来自页面已加载的全局状态（会话列表 / 项目 / 待办 / 团队绑定），选取在 now-model.ts；这里只管排版与点击去向。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { machines } from "@/lib/machines";
import { resolveCollabSource, type CollabSourceChoice } from "@/lib/collab-source-binding";
import { useLang, useT } from "@/lib/i18n";
import { asksStore, useAsks } from "../asks/asks-store";
import { useChatStore, useChatStoreApi } from "../chat/chat-store";
import { fmtAgo } from "../chat/fmt-time";
import { rowOpenIntent } from "../chat/open-intent";
import { useChatNav } from "../chat/components/nav-context";
import { Chevron } from "../chat/components/project-group";
import { closeCollab, openCollab } from "../collab/collab-nav";
import { Icon } from "../collab/collab-icons";
import { BLOCKED_REASON, useCollabBindings, useCollabChoice } from "../collab/team-view-entry";
import { nowTr } from "./now-i18n";
import { nowView, PROJECT_FOLD, type NowProject, type NowView } from "./now-model";

const subscribeMachines = (cb: () => void) => machines.subscribe(cb);
const currentFp = () => machines.currentFp();
const noFp = () => null;
const LOCAL: CollabSourceChoice = { kind: "local" };
const localSource = () => LOCAL;
/** 侧栏条展开与否，按设备记 */
const OPEN_KEY = "cstra_now_open";

type Translate = ReturnType<typeof nowTr>;
type Source = (projectId: string) => CollabSourceChoice;

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false; // 隐私模式 / 存储被禁：读不到就按收起
  }
}

function useNowT(): Translate {
  const lang = useLang(), t = useT();
  return useMemo(() => nowTr(lang, t), [lang, t]);
}

/** 三块的数据；source = 项目 → 协作视图选源。30 秒重算一次，「N 分钟前」才不会停在打开那一刻 */
function useNowView(source: Source): NowView {
  const agents = useChatStore((s) => s.state.agents);
  const projects = useChatStore((s) => s.state.projects);
  const { asks } = useAsks();
  const lang = useLang(), tr = useNowT();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tick 只为让相对时间重算
  return useMemo(() => nowView({ agents, projects, asks }, { lang, t: tr, ago: fmtAgo, source }), [agents, projects, asks, lang, tr, source, tick]);
}

function Block({ title, count, children }: { title: string; count?: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-base-300 bg-base-100 p-3" aria-label={title}>
      <h3 className="mb-1.5 flex items-baseline gap-2 text-[13px] font-semibold text-base-content/80">
        <span>{title}</span>
        {count && <span className="text-[11px] font-normal text-base-content/45">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

const ROW = "flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors";
const ROW_ON = `${ROW} hover:bg-base-300/50`;
const EMPTY = "px-2 py-1 text-[13px] text-base-content/45";

function Waits({ view, tr }: { view: NowView; tr: Translate }) {
  const more = view.waitTotal - view.waits.length;
  return (
    <Block title={tr("等你的事")} count={view.waitTotal ? tr("{n} 件", { n: view.waitTotal }) : undefined}>
      {view.waits.length === 0 ? <p className={EMPTY}>{tr("没有等你的事")}</p> : (
        <ul className="flex list-none flex-col p-0" data-now-waits>
          {view.waits.map((w) => (
            <li key={w.id}>
              <button type="button" className={ROW_ON} data-now-wait={w.id} onClick={() => asksStore.openDrawer(w.id)}>
                <Icon name="circleHelp" size={14} className="shrink-0 text-warning" />
                <span className="min-w-0 flex-1 truncate">{w.title}</span>
                <span className="max-w-[40%] shrink-0 truncate text-[11px] text-base-content/45">{tr("来自 {p}", { p: w.where })}</span>
              </button>
            </li>
          ))}
          {more > 0 && (
            <li>
              <button type="button" className={`${ROW_ON} text-base-content/60`} data-now-wait-more onClick={() => asksStore.openDrawer()}>
                <span className="flex-1">{tr("还有 {n} 件", { n: more })}</span>
                <Icon name="chevronRight" size={13} className="shrink-0" />
              </button>
            </li>
          )}
        </ul>
      )}
    </Block>
  );
}

function Workers({ view, tr, onOpen }: { view: NowView; tr: Translate; onOpen: (name: string) => void }) {
  return (
    <Block title={tr("在干活")} count={view.workers.length ? tr("{n} 个 agent", { n: view.workers.length }) : undefined}>
      {view.workers.length === 0 ? <p className={EMPTY}>{tr("现在没有 agent 在干活")}</p> : (
        <ul className="flex list-none flex-col p-0" data-now-workers>
          {view.workers.map((w) => (
            <li key={w.name}>
              <button type="button" className={ROW_ON} data-now-worker={w.name} onClick={() => onOpen(w.name)}>
                <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
                <span className="max-w-[45%] shrink-0 truncate font-medium">{w.label}</span>
                <span className="min-w-0 flex-1 truncate text-base-content/60" data-now-doing>{w.doing}</span>
                {w.ago && <span className="shrink-0 text-[11px] tabular-nums text-base-content/45" data-now-ago>{w.ago}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function ProjectLine({ p, tr }: { p: NowProject; tr: Translate }) {
  return (
    <>
      <Icon name="listTree" size={14} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
      {p.team && <span className="shrink-0 rounded border border-base-300 px-1 text-[11px] leading-4 text-base-content/55">{tr("团队")}</span>}
      {p.working > 0 && <span className="shrink-0 text-[11px] text-base-content/60" data-now-project-working>{tr("在干活 {n} 个 agent", { n: p.working })}</span>}
      {p.waits > 0 && <span className="shrink-0 text-[11px] font-medium text-warning" data-now-project-waits>{tr("待你处理 {n} 件", { n: p.waits })}</span>}
    </>
  );
}

/** 一行项目：choice = 最终选源（带撤权判断）。停用的行不可点，title 写原因 */
function ProjectRowView({ p, choice, tr, onOpen }: { p: NowProject; choice: CollabSourceChoice; tr: Translate; onOpen: (key: string) => void }) {
  if (choice.kind === "blocked") {
    return (
      <div className={`${ROW} cursor-not-allowed opacity-50`} role="button" aria-disabled data-now-project={p.id} data-collab-blocked={choice.reason}
        title={`${p.name} · ${BLOCKED_REASON[choice.reason]}`}>
        <ProjectLine p={p} tr={tr} />
      </div>
    );
  }
  const key = choice.kind === "center" ? choice.key : p.id;
  return (
    <button type="button" className={ROW_ON} data-now-project={p.id} title={tr("打开 {p} 的协作视图", { p: p.name })} onClick={() => onOpen(key)}>
      <ProjectLine p={p} tr={tr} />
    </button>
  );
}

function BoundProjectRow({ fp, ...rest }: { fp: string; p: NowProject; tr: Translate; onOpen: (key: string) => void }) {
  return <ProjectRowView {...rest} choice={useCollabChoice(fp, rest.p.id).choice} />;
}

function Projects({ view, fp, tr, onOpen }: { view: NowView; fp: string | null; tr: Translate; onOpen: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const folded = view.projects.length > PROJECT_FOLD;
  const shown = folded && !all ? view.projects.slice(0, PROJECT_FOLD) : view.projects;
  return (
    <Block title={tr("各项目")}>
      {view.projects.length === 0 ? <p className={EMPTY}>{tr("还没有项目")}</p> : (
        <ul className="flex list-none flex-col p-0" data-now-projects>
          {shown.map((p) => (
            <li key={p.id}>
              {fp ? <BoundProjectRow fp={fp} p={p} tr={tr} onOpen={onOpen} /> : <ProjectRowView p={p} choice={LOCAL} tr={tr} onOpen={onOpen} />}
            </li>
          ))}
          {folded && (
            <li>
              <button type="button" className={`${ROW_ON} text-base-content/60`} aria-expanded={all} data-now-project-all onClick={() => setAll((v) => !v)}>
                {all ? tr("收起") : tr("展开全部（共 {n} 个）", { n: view.projects.length })}
              </button>
            </li>
          )}
        </ul>
      )}
    </Block>
  );
}

/** 三块本体；page = 主区排版（宽了两列），否则侧栏里单列 */
function Blocks({ view, fp, page }: { view: NowView; fp: string | null; page: boolean }) {
  const tr = useNowT();
  const store = useChatStoreApi();
  const nav = useChatNav();
  const openAgent = (name: string) => {
    closeCollab();
    void store.openAgent(name, rowOpenIntent());
    nav.toContent();
  };
  const openProject = (key: string) => {
    openCollab(key);
    nav.toContent();
  };
  return (
    <div className={page ? "grid gap-3 lg:grid-cols-2" : "flex flex-col gap-2"} data-now-blocks>
      <Waits view={view} tr={tr} />
      <Workers view={view} tr={tr} onOpen={openAgent} />
      <div className={page ? "lg:col-span-2" : undefined}><Projects view={view} fp={fp} tr={tr} onOpen={openProject} /></div>
    </div>
  );
}

function summary(view: NowView, tr: Translate): string {
  return `${tr("{n} 个 agent 在干活", { n: view.workers.length })} · ${tr("{n} 件等你", { n: view.waitTotal })}`;
}

/** 侧栏条收起时那句：两段各自不折行；条宽不够一行（桌面侧栏默认 16rem）时整句换到「现在」下面一行，再窄就「N 件等你」另起一行，件数不被省略号吃掉 */
function StripSummary({ view, tr }: { view: NowView; tr: Translate }) {
  return (
    <span className="order-last flex basis-full flex-wrap gap-x-1 text-[13px] text-base-content/60 @[22rem]:order-none @[22rem]:min-w-0 @[22rem]:flex-1 @[22rem]:basis-0"
      data-now-summary>
      <span className="hidden @[22rem]:inline">· </span>
      <span className="whitespace-nowrap">{tr("{n} 个 agent 在干活", { n: view.workers.length })}</span>
      <span className="whitespace-nowrap font-medium text-base-content/75"> · {tr("{n} 件等你", { n: view.waitTotal })}</span>
    </span>
  );
}

function PageBody({ source, fp }: { source: Source; fp: string | null }) {
  const tr = useNowT();
  const view = useNowView(source);
  return (
    <div className="h-full overflow-y-auto" data-now="page">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
          <h2 className="text-lg font-semibold">{tr("现在")}</h2>
          <p className="text-sm text-base-content/55" data-now-summary>{summary(view, tr)}</p>
        </header>
        <Blocks view={view} fp={fp} page />
      </div>
    </div>
  );
}

function StripBody({ source, fp }: { source: Source; fp: string | null }) {
  const tr = useNowT();
  const view = useNowView(source);
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch { /* 隐私模式 / 存储被禁：这次照常展开收起，只是下次打开不记得 */ }
  };
  return (
    <div className="@container mb-2 rounded-xl border border-base-300 bg-base-100" data-now="strip" data-now-open={open ? "1" : "0"}>
      <button type="button" className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-base-300/40"
        aria-expanded={open} title={tr(open ? "收起现在总览" : "展开现在总览")} onClick={toggle}>
        <span className="shrink-0 text-[13px] font-semibold">{tr("现在")}</span>
        <StripSummary view={view} tr={tr} />
        <Chevron open={open} className="ml-auto shrink-0 text-base-content/45" />
      </button>
      {/* 高度动画：grid 行从 0fr 到 1fr；收起时 inert，里面的行不进 Tab 序、读屏也不念 */}
      <div className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="px-2 pb-2"><Blocks view={view} fp={fp} page={false} /></div>
        </div>
      </div>
    </div>
  );
}

/** 这台机器的团队绑定（项目组入口读的同一份 store）→ 选源函数；没选机器就没有绑定，全按本机 */
function WithBindings({ fp, Body }: { fp: string; Body: typeof PageBody }) {
  const { identities } = useCollabBindings(fp);
  const source = useMemo<Source>(() => (id) => resolveCollabSource(identities, id, fp), [identities, fp]);
  return <Body source={source} fp={fp} />;
}

function Now({ Body }: { Body: typeof PageBody }) {
  const fp = useSyncExternalStore(subscribeMachines, currentFp, noFp);
  return fp ? <WithBindings key={fp} fp={fp} Body={Body} /> : <Body source={localSource} fp={null} />;
}

/** 桌面没选会话时的主区 */
export const NowPage = () => <Now Body={PageBody} />;
/** 侧栏列表最上方的一条（两种宽度都有） */
export const NowStrip = () => <Now Body={StripBody} />;
