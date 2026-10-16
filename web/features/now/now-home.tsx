"use client";
/**
 * 「今天」总览（UXHOME1 起的「现在」，TODAY1 改名、扩成五块）：要你处理 → 卡住了 → 正在做 → 今天完成 → 团队与额度。一个组件两种排版——
 * NowPage = 桌面没选会话时的主区（message-list.tsx 的空状态），也是侧栏条「整页」盖出来的那层（collab-switch.tsx 见 TODAY_KEY）；
 * NowStrip = 侧栏列表最上方的一条，收起时一行、点开原地展开同样五块的紧凑版。
 * 全局状态（会话列表 / 项目 / 待办 / 团队绑定）+ 各项目台账与产品看板（now-ledgers.ts，只在页面版或侧栏条展开时读）；
 * 选取在 now-model.ts todayView，每块一个文件，这里只排顺序。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "@/lib/i18n";
import { useAsks } from "../asks/asks-store";
import { useChatStore } from "../chat/chat-store";
import { fmtAgo } from "../chat/fmt-time";
import { useChatNav } from "../chat/components/nav-context";
import { usePeerOnline } from "../chat/components/contacts-lines";
import { useSharedBorrowView } from "../borrow/use-borrow-view";
import { remoteRunning as countRemote } from "./now-machines-model";
import { Chevron } from "../chat/components/project-group";
import { Icon } from "../collab/collab-icons";
import { NowDoing } from "./now-doing";
import { NowDone } from "./now-done";
import { useTodayLedgers } from "./now-ledgers";
import { busyLine, todayView, type TodayView } from "./now-model";
import { NowStuck } from "./now-stuck";
import { NowTeam } from "./now-team";
import { FOLD, useNowT, WithSource, type Source, type Translate } from "./now-ui";
import { NowWaits } from "./now-waits";
import { openToday, scrollToSection, subscribeToday, takeTodayRequest } from "./today-nav";

export { TODAY_KEY } from "./today-nav";

/** 侧栏条展开与否，按设备记 */
const OPEN_KEY = "cstra_now_open";
/** 侧栏条展开动效（.2s）走完再滚 */
const STRIP_SETTLE_MS = 220;

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false; // 隐私模式 / 存储被禁：读不到就按收起
  }
}

function writeOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch { /* 隐私模式 / 存储被禁：这次照常展开收起，只是下次打开不记得 */ }
}

const useRemoteRunning = (enabled: boolean): number => countRemote(useSharedBorrowView(enabled).view);

/** 五块的数据；live = 读各项目台账（页面版 / 侧栏条展开）。30 秒重算一次，「N 分钟前」与停留时长才不会停在打开那一刻 */
function useTodayView(source: Source, live: boolean): TodayView {
  const agents = useChatStore((s) => s.state.agents);
  const projects = useChatStore((s) => s.state.projects);
  const { asks } = useAsks();
  const lang = useLang(), tr = useNowT();
  const ids = useMemo(() => projects.map((p) => p.id), [projects]);
  const ledgers = useTodayLedgers(ids, live);
  // 借入在别的机器上跑的单也算在干活（XMACH1）：有伙伴机器才读 GET /borrow（与团队与额度的借入行共用一份轮询）
  const remoteRunning = useRemoteRunning(usePeerOnline() !== null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // now 只管停留时长与「今天」的零点；fmtAgo 自己取当前时刻，now 变了跟着重算
  return useMemo(() => todayView({ agents, projects, asks, ...ledgers, now, remoteRunning }, { lang, t: tr, ago: fmtAgo, source }),
    [agents, projects, asks, ledgers, now, remoteRunning, lang, tr, source]);
}

/** 五块，顺序固定；页面版和侧栏条都是单列 */
function Blocks({ view, fp, page, live }: { view: TodayView; fp: string | null; page: boolean; live: boolean }) {
  const tr = useNowT();
  return (
    <div className={`flex flex-col ${page ? "gap-3" : "gap-2"}`} data-now-blocks>
      <NowWaits view={view} tr={tr} />
      <NowStuck view={view} tr={tr} />
      <NowDoing view={view} fp={fp} tr={tr} />
      <NowDone view={view} tr={tr} />
      <NowTeam view={view} tr={tr} live={live} />
    </div>
  );
}

const waitsText = (view: TodayView, tr: Translate) => (view.waitTotal ? tr("{n} 件要你处理", { n: view.waitTotal }) : tr("没有要你处理的"));
const busyText = (view: TodayView, tr: Translate) => busyLine(view.team, tr);

/** 侧栏条收起时那句（先说要你做的）：两段各自不折行；条宽不够一行（桌面侧栏默认 16rem）时整句换到「今天」下面一行，再窄就后一段另起一行，件数不被省略号吃掉 */
function StripSummary({ view, tr }: { view: TodayView; tr: Translate }) {
  return (
    <span className="order-last flex basis-full flex-wrap gap-x-1 text-[13px] text-base-content/60 @[22rem]:order-none @[22rem]:min-w-0 @[22rem]:flex-1 @[22rem]:basis-0"
      data-now-summary>
      <span className="hidden @[22rem]:inline">· </span>
      <span className="whitespace-nowrap font-medium text-base-content/75">{waitsText(view, tr)}</span>
      <span className="whitespace-nowrap"> · {busyText(view, tr)}</span>
    </span>
  );
}

function PageBody({ source, fp }: { source: Source; fp: string | null }) {
  const tr = useNowT();
  const view = useTodayView(source, true);
  const ref = useRef<HTMLDivElement>(null);
  // 整页是 openToday 盖出来的：挂上时取走那次请求滚过去；开着时再来的请求（「看额度」）也滚
  useEffect(() => {
    let raf = 0;
    const take = () => {
      const req = takeTodayRequest(false);
      if (req?.section) raf = requestAnimationFrame(() => scrollToSection(ref.current, req.section));
    };
    take();
    const off = subscribeToday(take);
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);
  return (
    <div className="h-full w-full min-w-0 flex-1 overflow-y-auto" data-now="page" ref={ref}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
          <h2 className="text-lg font-semibold">{tr("今天")}</h2>
          <p className="text-sm text-base-content/55" data-now-summary>{`${waitsText(view, tr)} · ${busyText(view, tr)}`}</p>
        </header>
        <Blocks view={view} fp={fp} page live />
      </div>
    </div>
  );
}

function StripBody({ source, fp }: { source: Source; fp: string | null }) {
  const tr = useNowT();
  const nav = useChatNav();
  const [open, setOpen] = useState(readOpen);
  const view = useTodayView(source, open);
  const ref = useRef<HTMLDivElement>(null);
  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };
  // 手机上 openToday（QUOTA1 / XMACH1 的「看额度」「看在跑的单」）：展开侧栏条，动效走完再滚到那一块
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribeToday(() => {
      const req = takeTodayRequest(true);
      if (!req) return;
      setOpen(true);
      writeOpen(true);
      clearTimeout(timer);
      timer = setTimeout(() => scrollToSection(ref.current, req.section), STRIP_SETTLE_MS);
    });
    return () => { off(); clearTimeout(timer); };
  }, []);
  return (
    <div className="@container mb-2 rounded-xl border border-base-300 bg-base-100" data-now="strip" data-now-open={open ? "1" : "0"} ref={ref}>
      <div className="flex min-w-0 items-start">
        <button type="button" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-base-300/40"
          aria-expanded={open} title={tr(open ? "收起今天总览" : "展开今天总览")} aria-label={tr(open ? "收起今天总览" : "展开今天总览")} onClick={toggle}>
          <span className="shrink-0 text-[13px] font-semibold">{tr("今天")}</span>
          <StripSummary view={view} tr={tr} />
          <Chevron open={open} className="ml-auto shrink-0 text-base-content/45" />
        </button>
        <button type="button" className="mr-1.5 mt-1.5 hidden shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-base-content/60 transition-colors hover:bg-base-300/50 sm:inline-flex"
          title={tr("打开今天整页")} data-now-full onClick={() => openToday(undefined, nav)}>
          <Icon name="panelRightOpen" size={13} />
          <span>{tr("整页")}</span>
        </button>
      </div>
      {/* 高度动画：grid 行从 0fr 到 1fr；收起时 inert，里面的行不进 Tab 序、读屏也不念 */}
      <div className={`${FOLD} ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="px-2 pb-2"><Blocks view={view} fp={fp} page={false} live={open} /></div>
        </div>
      </div>
    </div>
  );
}

/** 桌面没选会话时的主区；侧栏条「整页」盖出来的那层 */
export const NowPage = () => <WithSource render={(s) => <PageBody {...s} />} />;
/** 侧栏列表最上方的一条（两种宽度都有） */
export const NowStrip = () => <WithSource render={(s) => <StripBody {...s} />} />;
