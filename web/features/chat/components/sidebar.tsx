"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { hasDraft, subscribeDrafts } from "../drafts";
import { useChatStore, useChatStoreApi, noteSidebarInteraction } from "../chat-store";
import { installTapRescue } from "@/lib/tap-rescue";
import { SettingsModal } from "./settings-modal";
import type { SettingsPageId } from "./settings/nav";
import { ProjectsModal } from "./projects-modal";
import { SidebarBanners } from "./sidebar-banners";
import { StatsPanel } from "./stats-panel";
import { useT, getLang } from "@/lib/i18n";
import { ChatHitRow, type ChatSearchHit } from "./search-hits";
import { SidebarExtraGroups } from "./sidebar-extra-groups";
import { buildSidebarEntries, buildTeams, entryMembers, filterAndRankWorkers, splitDormant, splitMasterKids, type SidebarEntry, type TeamNode } from "../sidebar-entries";
import { MasterTeam, TeamGroup, type RowSlots } from "./team-group";
import { usePersistedSet } from "../use-persisted-set";
import { AgentRow } from "./agent-row";
import { AgentMenu } from "./agent-menu";
import { ProjectMenu } from "./project-menu";
import { SidebarAdminButtons } from "./sidebar-admin-buttons";
import { MachineSwitcher } from "../../machines/machine-switcher";
import { useVersionInfo } from "../../machines/use-version";
import { searchHistory } from "@/lib/api/chat";
import { InviteIntake } from "./invite-intake";
import { Chevron, ProjectGroup } from "./project-group";
import type { AgentSession } from "../type";
import { rowOpenIntent } from "../open-intent";
import { swipeReg } from "./agent-row-swipe";
import { MasterIcon } from "./master-icon";
import { SidebarMediaButton } from "../../media/media-button";

/**
 * 会话列表面板。移动端是全屏「菜单」（w-full，横滑容器的基础页）；桌面端定宽常驻左栏（sm:w-64）。
 * onSelect：选中会话后回调（移动端 = 横滑到内容页 toContent；桌面端空转）。
 */
export function Sidebar({ onSelect }: { onSelect: () => void }) {
  const store = useChatStoreApi();
  const t = useT();
  const agents = useChatStore((s) => s.state.agents);
  const projects = useChatStore((s) => s.state.projects);
  const loading = useChatStore((s) => s.state.loadingAgents);
  const ready = useChatStore((s) => s.state.agentsReady);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  const compactingLive = useChatStore((s) => s.state.compacting);
  const listTouchY = useRef<number | null>(null);
  // 触摸丢 click 兜底(lib/tap-rescue.ts):回弹 / 减速尾巴期间点行也能进
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    return installTapRescue(el, { name: "list", log: (m) => store.clientLog(m) });
  }, [store]);
  // 桌面侧栏拖拽调宽(owner 2026-07-24):右缘手柄,localStorage 持久化。
  // 移动端 w-full 不受影响(宽度变量只在 sm+ 生效)。
  const [sbWidth, setSbWidth] = useState<number | null>(() => {
    if (typeof window === "undefined") return null;
    const v = Number(localStorage.getItem("cstra_sbw"));
    return Number.isFinite(v) && v >= 200 && v <= 560 ? v : null;
  });
  const resizingRef = useRef(false);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (!resizingRef.current) return;
      // aside 起自视口左缘,clientX 即目标宽度
      setSbWidth(Math.min(560, Math.max(200, Math.round(ev.clientX))));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setSbWidth((w) => {
        try {
          if (w) localStorage.setItem("cstra_sbw", String(w));
        } catch { /* 隐私模式 */ }
        return w;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  // 相对时间标签保鲜:30s 心跳整列表重渲染(行数少,代价可忽略)
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  // 用户置顶(owner 2026-07-14:左滑加置顶):localStorage 偏好,纯前端排序——
  // master 恒第一,置顶组其次(保持组内原相对顺序),其余在后
  const [pinnedList, setPinnedList] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const v = JSON.parse(localStorage.getItem("cstra_pinned") || "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  });
  const togglePin = (name: string) => {
    setPinnedList((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      try {
        localStorage.setItem("cstra_pinned", JSON.stringify(next));
      } catch {
        /* 隐私模式 */
      }
      return next;
    });
  };
  // agent 搜索（2026-07-13 owner）：名称/用途 大小写不敏感即时过滤，纯前端
  const [query, setQuery] = useState("");
  // 设置弹窗：null = 关；否则是打开时直达的页(⚙️ → 通用，Peer 按钮 → peers)
  const [settingsPage, setSettingsPage] = useState<SettingsPageId | null>(null);
  // 左下角版本徽标(owner 2026-07-31):当前机器的版本+commit,挂载时拉一次
  const verInfo = useVersionInfo();
  const [showStats, setShowStats] = useState(false);
  const q = query.trim().toLowerCase();
  // 多选管理(owner 2026-07-16:「agent 页面做管理功能,多选删除」)
  const [manage, setManage] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const exitManage = () => {
    setManage(false);
    setSel(new Set());
    setConfirmBatch(false);
  };
  const toggleSel = (name: string) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const batchRemove = async () => {
    if (batchBusy || sel.size === 0) return;
    if (!confirmBatch) {
      setConfirmBatch(true);
      return;
    }
    setBatchBusy(true);
    const failed: string[] = [];
    for (const name of sel) {
      const r = await store.removeAgent(name);
      if (!r.ok) failed.push(name);
    }
    setBatchBusy(false);
    exitManage();
    if (failed.length) alert(`${t("部分删除失败:")}${failed.join(", ")}`);
  };
  // 聊天记录全局搜索（2026-07-14 owner:「compact 后忘事,模糊记得有件事——
  // 搜聊天记录找回」）。跨会话正文检索,按钮触发不自动搜(全盘扫描,省请求)。
  const [chatHits, setChatHits] = useState<ChatSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchChat = async () => {
    const term = query.trim();
    if (term.length < 2 || searching) return;
    setSearching(true);
    try {
      setChatHits((await searchHistory(term)) as ChatSearchHit[]);
    } catch {
      setChatHits([]);
    }
    setSearching(false);
  };
  const pinSet = new Set(pinnedList);
  // 大总管独立入口(owner 2026-07-14:「跟普通 agent 区分开」)——不进列表、
  // 不参与搜索过滤,常驻列表区顶部的边框卡片
  const master = agents.find((a) => a.pinnedMaster);
  // 大总管卡不走 AgentRow，【草稿】标单独订阅一份（agent-row.tsx 同款）
  const masterDraft = useSyncExternalStore(subscribeDrafts, () => (master ? hasDraft(master.name) : false), () => false);
  const workers = agents.filter((a) => !a.pinnedMaster);
  // 只按「置顶」分层,⚠ 未读不参与排序——规则与缘由见 sidebar-entries.ts
  const filtered = filterAndRankWorkers(workers, q, pinSet, master?.name);
  // v2.21+ project 分组(owner 2026-08-28)。搜索时退回平铺(结果直给,不折叠)。
  // 组序 = 组内最近活动(filtered 已按活动排,Map 插入序即组的活动序);未分组沉底。
  const [showProjects, setShowProjects] = useState(false);
  const [collapsedProjects, toggleProjectCollapse] = usePersistedSet("cstra_proj_collapsed");
  const [collapsedTeams, toggleTeam] = usePersistedSet("cstra_team_collapsed"); // 派发者（及大总管）下挂的执行者
  // 「💤 沉寂」组的展开态:默认折叠,会话内记忆即可(不持久化——每次进来先收起)
  const [dormantOpen, setDormantOpen] = useState(false);
  const projMeta = new Map(projects.map((p) => [p.id, p] as const));
  // 单成员 project 不成组;整组全员沉寂才下沉「💤 沉寂」——规则见 sidebar-entries.ts
  const entries = buildSidebarEntries(filtered, q, projMeta, master?.name); // 先按 parent 挂树再分组
  const { awake: underMaster, dormantRows } = splitMasterKids(q ? [] : buildTeams(filtered, master?.name).underMaster);
  const { activeEntries, dormantEntries } = splitDormant([...entries, ...dormantRows]);
  // 三处列表（搜索平铺 / 单人行 / 组内行）共用一份行 props
  const rowProps = (a: AgentSession) => ({
    a,
    active: active === a.name,
    busyLive: active === a.name && streaming,
    compacting: a.compacting || (active === a.name && compactingLive),
    pinned: pinSet.has(a.name),
    onTogglePin: () => togglePin(a.name),
    onSelect,
    manage,
    checked: sel.has(a.name),
    onToggleCheck: () => toggleSel(a.name),
  });
  const busyOf = (i: AgentSession) => i.busy || (active === i.name && streaming);
  const row = (a: AgentSession, s?: RowSlots & { projEmoji?: string }) => <AgentRow key={a.name} {...rowProps(a)} {...s} />;
  const team = (n: TeamNode, projEmoji?: string) => (
    <TeamGroup key={`t:${n.a.name}`} node={n} collapsed={collapsedTeams.has(n.a.name)} busy={n.children.some(busyOf)}
      onToggle={() => toggleTeam(n.a.name)} row={(a, s) => row(a, a === n.a ? { ...s, projEmoji } : s)} />
  );

  return (
    <aside
      className="relative flex w-full shrink-0 flex-col border-r border-base-300 bg-base-200 sm:w-[var(--sb-w,16rem)]"
      style={sbWidth ? ({ "--sb-w": `${sbWidth}px` } as React.CSSProperties) : undefined}
    >
      {/* 桌面拖宽手柄:压住右缘 5px,悬停显色提示可拖 */}
      <div
        className="absolute inset-y-0 -right-[2px] z-10 hidden w-[5px] cursor-col-resize hover:bg-primary/30 active:bg-primary/40 sm:block"
        onPointerDown={startResize}
      />
      {/* 安全区顶部由面板自己垫（bg=base-200，条带与列表同色无缝）；列表靠轮询 + 回前台重连自动刷新，没有刷新按钮 */}
      <div
        className="px-4 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <div className="flex items-center pb-2.5">
          <span className="font-semibold">{t("会话")}</span>
          {/* 多机切换（中继模式 ≥2 台才出现）：同一个 store 换数据源——断流、清空、从新机器重拉（chat-store.resetForMachine） */}
          <span className="ml-auto"><MachineSwitcher onSwitched={() => store.resetForMachine()} /></span>
          {/* 项目管理 / 多选删除 / Peer / 用量看板：只给全权设备（sidebar-admin-buttons.tsx） */}
          <SidebarAdminButtons
            manage={manage}
            onProjects={() => setShowProjects(true)}
            onToggleManage={() => (manage ? exitManage() : setManage(true))}
            onPeers={() => setSettingsPage("peers")}
            onStats={() => setShowStats(true)}
          />
          {/* 图片与文件：guest 也能用（/media 按 scope 过滤、非全权只给可信文件），不藏 */}
          <SidebarMediaButton />
          <button
            className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title={t("设置")}
            aria-label={t("设置")}
            onClick={() => setSettingsPage("general")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <label className="flex items-center gap-2 rounded-lg bg-base-300/60 px-2.5 py-1.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="shrink-0 opacity-40">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setChatHits(null); // 换词后旧结果失效
            }}
            placeholder={t("搜索会话 / 聊天记录…")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="search"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void searchChat();
              }
            }}
            className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-base-content/35 [&::-webkit-search-cancel-button]:hidden"
          />
          {query && (
            <button
              className="shrink-0 text-xs text-base-content/40"
              aria-label={t("清除搜索")}
              onClick={() => {
                setQuery("");
                setChatHits(null);
              }}
            >
              ✕
            </button>
          )}
        </label>
        {/* 聊天记录全局搜索入口:输入 ≥2 字符出现,点击(或回车)才扫全部会话 */}
        {query.trim().length >= 2 && chatHits === null && (
          <button
            className="mt-1.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-base-content/60 transition-colors hover:bg-base-300/60"
            onClick={() => void searchChat()}
            disabled={searching}
          >
            {searching ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <span className="opacity-60">💬</span>
            )}
            {searching ? t("正在搜聊天记录…") : t("搜聊天记录「{q}」", { q: query.trim() })}
          </button>
        )}
      </div>

      <SidebarBanners />

      {/* 2026-09-11 回弹恢复(owner:「没回弹总以为是卡住了」)。回弹/减速尾巴期间
          点行丢 click 的问题改由容器上的 installTapRescue 兜底:抬手 450ms 没等到真 click
          就向按下时的行派发合成 click(lib/tap-rescue.ts),手感不动。 */}
      {/* touch-pan-y + overscroll-contain：iOS 到边界时滚动链会穿透到不可滚的
          fixed 应用壳，橡皮筋吃掉手势看着像「滑不动」（BgLines 同款修法）。 */}
      <div
        ref={listRef}
        // select-none + touch-callout none:长按会话行是想看操作/滑动,不是选文本
        // (owner 2026-09-02);列表一滚动就把滑开的行收回(微信同款)
        className="flex-1 touch-pan-y select-none overflow-y-auto overscroll-contain px-2 pb-3 [-webkit-touch-callout:none]"
        style={{ WebkitOverflowScrolling: "touch" }}
        // 交互期冻结 roster 重排的信号源(v2.17.2 串台补刀,见 chat-store
        // noteSidebarInteraction):触碰/滚动期间列表顺序不动
        onPointerDown={noteSidebarInteraction}
        onScroll={() => {
          noteSidebarInteraction();
          swipeReg.closeAll();
        }}
        // 容器级纵向位移追踪:手指落在行间空隙/分组头上往上下拖、或列表短到滚不动,
        // 都收回滑开的行(行内手势与 onScroll 覆盖不到这两种)
        onTouchStart={(e) => {
          listTouchY.current = e.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(e) => {
          noteSidebarInteraction();
          const y0 = listTouchY.current;
          const y = e.touches[0]?.clientY;
          if (swipeReg.cur && y0 !== null && typeof y === "number" && Math.abs(y - y0) > 6) {
            listTouchY.current = null; // 收一次就够
            swipeReg.closeAll();
          }
        }}
      >
        {/* 首拉未完成（!ready）时绝不显示「暂无会话」——SSR 首帧就渲染空态
            是入场卡顿的观感元凶（2026-07-13）；入场期由全屏 Splash 盖住。 */}
        {(!ready || loading) && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">{t("加载中…")}</div>
        )}
        {ready && !loading && agents.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">{t("暂无会话")}</div>
        )}
        {/* 聊天记录搜索结果:跨会话正文命中,点击进对应会话(已删 agent 只读展示) */}
        {chatHits !== null && (
          <div className="mb-2 rounded-xl border border-base-300 bg-base-100 p-1.5">
            <div className="flex items-center px-1.5 pb-1 pt-0.5 text-[11px] text-base-content/45">
              <span>💬 {t("聊天记录")} · {chatHits.length ? (getLang() === "en" ? `${chatHits.length} hit${chatHits.length > 1 ? "s" : ""}` : `${chatHits.length} 条命中`) : t("无命中")}</span>
              <button
                className="ml-auto rounded px-1 text-base-content/40 hover:text-base-content/70"
                aria-label={t("关闭搜索结果")}
                onClick={() => setChatHits(null)}
              >
                ✕
              </button>
            </div>
            {chatHits.length === 0 && (
              <div className="px-1.5 pb-1.5 text-xs text-base-content/40">
                {t("对话正文里没有「")}{query.trim()}{t("」")}
              </div>
            )}
            <div className="flex flex-col">
              {chatHits.map((h, i) => {
                const canOpen = agents.some((a) => a.name === h.agent);
                return (
                  <ChatHitRow
                    key={`${h.agent}-${h.sessionId}-${h.seq}-${i}`}
                    hit={h}
                    q={query.trim()}
                    canOpen={canOpen}
                    onOpen={() => {
                      // 先进会话再跳历史现场(gen 竞态由 openGen 守卫,跳转必胜出)
                      void store.openAgent(h.agent).then(() => store.jumpToContext(h.sessionId, h.seq));
                      onSelect();
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
        {/* 大总管独立入口卡:边框实卡与普通行区分,常驻不受搜索影响 */}
        {master && (
          <button
            className={`mb-2 flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors ${
              active === master.name
                ? "border-primary/40 bg-primary/10"
                : "border-base-300 bg-base-100 hover:bg-base-300/40"
            }`}
            onClick={() => { void store.openAgent(master.name, rowOpenIntent()); onSelect(); }}
          >
            <span
              className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                active === master.name ? "bg-primary/15 text-primary" : "bg-base-300/60 text-base-content/65"
              }`}
            >
              <MasterIcon className="size-[18px]" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] font-medium sm:text-sm">{t(master.displayName)}</span>
              <span className="truncate text-[11px] text-base-content/45">{t("总控调度 · 新建会话找它")}</span>
            </span>
            {masterDraft && active !== master.name && (
              <span className="badge badge-outline badge-warning badge-xs shrink-0">{t("草稿")}</span>
            )}
            {(master.busy || master.compacting || (active === master.name && streaming)) && (
              <span className={`size-2 shrink-0 rounded-full ${master.compacting || (active === master.name && compactingLive) ? "bg-info" : "bg-warning"}`} />
            )}
          </button>
        )}
        {master && (
          <MasterTeam masterName={master.name} kids={underMaster} collapsed={collapsedTeams.has(master.name)} busy={underMaster.some(busyOf)} onToggle={() => toggleTeam(master.name)} row={(a) => row(a)} />
        )}
        {agents.length > 0 && filtered.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">{t("没有匹配「")}{query.trim()}{t("」的会话")}</div>
        )}
        {/* 不用 daisyUI menu 类——它给每行自带 :hover/:active 按压高亮，iOS 上
            手指一碰就闪（滑动时「一直触发 hover 特效」，2026-07-13 真机）；
            行样式本来就是自定义的。 */}
        {q ? (
          <ul className="flex w-full list-none flex-col gap-0.5 p-0">
            {filtered.map((a) => row(a))}
          </ul>
        ) : (
          /* v2.21+ 方案 A(owner 2026-08-28):统一两级树——仅 ≥2 成员的 project
             出组头(树形缩进),单人项目合并为一行(自定义 emoji 前缀);
             >30 天沉寂的整体收进底部默认折叠的「💤 沉寂」 */
          (() => {
            const renderEntry = (e: SidebarEntry) => {
              if (e.kind === "row") return team(e, (e.a.projectId && projMeta.get(e.a.projectId)?.emoji) || undefined);
              // 组头 / 组块样式与拖拽放置在 project-group.tsx
              return (
                <ProjectGroup
                  key={`g:${e.id}`}
                  e={e}
                  collapsed={collapsedProjects.has(e.id)}
                  groupBusy={e.items.some(busyOf)}
                  onToggle={() => toggleProjectCollapse(e.id)}
                >
                  {e.nodes.map((n) => team(n))}
                </ProjectGroup>
              );
            };
            return (
              <ul className="flex w-full list-none flex-col gap-0.5 p-0">
                {activeEntries.map(renderEntry)}
                {dormantEntries.length > 0 && (
                  <li key="__dormant__" className="mt-1 rounded-xl bg-base-300/15 p-1">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[12px] font-medium text-base-content/45 transition-colors hover:bg-base-300/40 hover:text-base-content/70"
                      onClick={() => setDormantOpen((v) => !v)}
                    >
                      <Chevron open={dormantOpen} />
                      <span>💤 {t("沉寂")}</span>
                      <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/35">
                        {dormantEntries.reduce((n, e) => n + entryMembers(e).length, 0)}
                      </span>
                    </button>
                    {dormantOpen && (
                      <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5 opacity-75">
                        {dormantEntries.map(renderEntry)}
                      </ul>
                    )}
                  </li>
                )}
              </ul>
            );
          })()
        )}
      </div>

      {/* 多选管理操作条:替换底部品牌行,删除按钮二次确认 */}
      {manage ? (
        <div
          className="flex items-center gap-2 border-t border-base-300 px-3 pt-2"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
        >
          <span className="text-xs text-base-content/50">
            {getLang() === "en" ? `${sel.size} selected` : `已选 ${sel.size} 个`}{sel.size > 0 && t(" · 归档保留")}
          </span>
          <button
            className={`btn btn-sm ml-auto ${sel.size ? "btn-error" : "btn-disabled"}`}
            disabled={!sel.size || batchBusy}
            onClick={() => void batchRemove()}
          >
            {batchBusy ? (
              <span className="loading loading-spinner loading-xs" />
            ) : confirmBatch ? (
              t("确认删除 {n} 个?", { n: sel.size })
            ) : getLang() === "en" ? (
              `Delete${sel.size ? ` ${sel.size}` : ""}`
            ) : (
              `删除${sel.size ? ` ${sel.size} 个` : ""}`
            )}
          </button>
        </div>
      ) : (
        <>
          {/* 附加分组（联系人 / 未纳管会话 / 归档，sidebar-extra-groups.tsx）。
              放在版本行**之上** —— 版本行是页面收尾元素，功能分区压在它下面很反常
              （视觉审查 P2-5）。样式复用项目组头，不再自创一套。 */}
          {!manage ? <SidebarExtraGroups /> : null}
          {/* 底部安全区：max() 取大不叠加——home 条区高度只算一次，不再「env+间距」双层 */}
          <div
            className="border-t border-base-300 px-4 pt-2 text-xs opacity-50"
            style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
          >
            Claudestra Web
            {verInfo?.version ? (
              <span className="ml-1 font-mono">
                v{verInfo.version}
                {verInfo.commit ? ` · ${verInfo.commit}` : ""}
              </span>
            ) : null}
          </div>
        </>
      )}
      <SettingsModal open={settingsPage !== null} initialPage={settingsPage ?? "general"} onClose={() => setSettingsPage(null)} />
      <StatsPanel open={showStats} onClose={() => setShowStats(false)} />
      <ProjectsModal open={showProjects} onClose={() => setShowProjects(false)} />
      <AgentMenu />
      <ProjectMenu />
      <InviteIntake />
    </aside>
  );
}
