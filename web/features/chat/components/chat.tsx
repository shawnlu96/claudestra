"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatStoreProvider, useChatStore, useChatStoreApi } from "../chat-store";
import { ChatNavContext, useChatNav, type ChatNav } from "./nav-context";
import { Sidebar } from "./sidebar";
import { MessageList } from "./message-list";
import { Composer } from "./composer";
import { Splash } from "./splash";
import { AgentActions } from "./agent-actions";
import { TerminalButton } from "../../terminal/terminal-button";
import { SessionSearchButton } from "./session-search";
import { ManagePanel } from "./manage-panel";
import { ClaudeSwitcher } from "./claude-switcher";
import { CtxBadge } from "./ctx-badge";
import { useLayoutMode, useFlowKeyboard } from "../use-keyboard-viewport";
import { useT } from "@/lib/i18n";
import { isNativeShell } from "@/lib/native";

/** 壳内排障打点 → /api/client-log(仅原生壳;PWA/桌面不发)。 */
function shellLog(msg: string) {
  try {
    void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg: `[shell] ${msg}` }) }).catch(() => {});
  } catch { /* ignore */ }
}
/**
 * v2.21.3+ 运行时错误上报(壳 + PWA 都记,此前只有壳且只记文件名+行号——生产 chunk
 * 全在第 1 行,等于没记)。带完整 JS 栈(含列号):配合 next.config 的
 * productionBrowserSourceMaps,用 `node scripts/resolve-stack.mjs` 还原到源码位置。
 * 背景:壳里两天抓到 18 次 React #185(渲染死循环),光凭 @chunk:1 定位不了。
 * 5 分钟最多 8 条,防死循环类错误刷爆日志。
 */
const errLogWindow: number[] = [];
function reportRuntimeError(kind: string, err: unknown, fallback: string) {
  const now = Date.now();
  while (errLogWindow.length && now - errLogWindow[0] > 5 * 60_000) errLogWindow.shift();
  if (errLogWindow.length >= 8) return;
  errLogWindow.push(now);
  const e = err instanceof Error ? err : null;
  // 20 帧:React 自己的 8 帧(throwIfInfiniteUpdateLoopDetected → dispatchSetState)之后
  // 才轮到我们的调用方——2026-09-03 抓到 24 条 #185 全卡在第 8 帧 dispatchSetState 上
  const stack = (e?.stack || "").split("\n").slice(0, 20).join("\n");
  const msg = `${kind} ${e?.message || fallback}${stack ? `\nstack: ${stack}` : ""}`;
  const tag = isNativeShell() ? "[shell]" : "[pwa]";
  try {
    void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg: `${tag} ${msg}` }) }).catch(() => {});
  } catch { /* ignore */ }
}
/**
 * v2.21.4 React 提交突发上报(追 #185)。layout.tsx 里的内联钩子在同一个宏任务里
 * 数到 ≥30 次 React 提交时派发 cstra:commit-burst,带「本次重渲染的组件名×次数
 * {变动的 hook 序号:次数} fp:函数指纹」——#185 的本质是 50 次连续同步提交,这里
 * 直接看到是谁在链上、它哪个 hook 在变,不再依赖被 Safari 尾调用吃掉的调用栈。
 */
type CommitBurst = { n: number; span: number; walked: number; top: string[] };
let burstReports = 0;
function reportCommitBurst(d: CommitBurst) {
  if (burstReports >= 5 || !d) return;
  burstReports++;
  const tag = isNativeShell() ? "[shell]" : "[pwa]";
  const msg = `[commits] ${d.n} commits in one task (${d.span}ms, walked ${d.walked}) ${tag} top: ${(d.top || []).join(" ; ")}`;
  try {
    void fetch("/api/client-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg }) }).catch(() => {});
  } catch { /* ignore */ }
}
if (typeof window !== "undefined") {
  window.addEventListener("cstra:commit-burst", (e) => reportCommitBurst((e as CustomEvent<CommitBurst>).detail));
  // 钩子可能在本模块挂监听之前就抓到过突发——补报暂存的
  try {
    const w = window as unknown as { __cstraCommitBursts?: CommitBurst[] };
    for (const d of w.__cstraCommitBursts || []) reportCommitBurst(d);
    w.__cstraCommitBursts = [];
  } catch { /* ignore */ }
  window.addEventListener("error", (e) => reportRuntimeError("error", e.error, `${e.message} @${(e.filename || "").split("/").pop()}:${e.lineno}:${e.colno}`));
  window.addEventListener("unhandledrejection", (e) => reportRuntimeError("unhandledrejection", (e as PromiseRejectionEvent).reason, String((e as PromiseRejectionEvent).reason).slice(0, 160)));
}

/** 「会话内容」页的 hash 锚点：存在即处于内容视图，移动端横滑到内容栏 */
const CONTENT_HASH = "#chat";
const isContentHash = () =>
  typeof window !== "undefined" &&
  window.location.hash.split("?")[0] === CONTENT_HASH;
/** 仅移动端（< sm 640px）走 hash 横滑；桌面双栏并存 */
const isNarrow = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(max-width: 639.98px)").matches;

/** Agent 管理页 hash（窄屏伪路由,左滑/返回键退出,同 #terminal 一套导航栈） */
const MANAGE_HASH = "#manage";
const isManageHash = () =>
  typeof window !== "undefined" &&
  window.location.hash.split("?")[0] === MANAGE_HASH;

/** 最短亮灯:active 变 truthy 立即亮,变 null 后至少亮满 minMs 才熄——
 *  秒级完成的同步不再「一闪而过等于没亮」(owner 2026-08-08)。 */
function useMinVisible<T>(active: T | null, minMs = 1200): T | null {
  const [shown, setShown] = useState<T | null>(active);
  const litAtRef = useRef(0);
  useEffect(() => {
    if (active !== null) {
      if (litAtRef.current === 0) litAtRef.current = Date.now();
      setShown(active);
      return;
    }
    const lit = litAtRef.current;
    if (lit === 0) { setShown(null); return; }
    const remain = minMs - (Date.now() - lit);
    if (remain <= 0) { litAtRef.current = 0; setShown(null); return; }
    const t = setTimeout(() => { litAtRef.current = 0; setShown(null); }, remain);
    return () => clearTimeout(t);
  }, [active, minMs]);
  return shown;
}

/** v2.17.2 对齐/连接横幅(owner 2026-08-08:「小徽章太隐蔽,要让用户知道系统
 *  在努力」)。消息区顶部居中的实色浮动 chip,零布局位移;严重度取一:
 *  同步失败(可点重试) > 同步中 > 重连中;最短亮 1.2s,消失 = 已是最新。
 *  空视图(骨架屏/全屏错误态)与历史现场不亮。 */
function SyncBanner() {
  const t = useT();
  const syncState = useChatStore((s) => s.state.syncState);
  const streamDown = useChatStore((s) => s.state.streamDown);
  const loadingHistory = useChatStore((s) => s.state.loadingHistory);
  const historyError = useChatStore((s) => s.state.historyError);
  const browsing = useChatStore((s) => s.state.browsing);
  const active = useChatStore((s) => s.state.activeAgent);
  const store = useChatStoreApi();
  const raw =
    !active || loadingHistory || historyError || browsing
      ? null
      : syncState === "error"
        ? "error"
        : syncState === "syncing"
          ? "syncing"
          : streamDown
            ? "streamDown"
            : null;
  // error 不吃最短亮灯(它本来就常驻到重试);syncing/streamDown 保底 1.2s
  const held = useMinVisible(raw === "error" ? null : raw);
  const kind = raw === "error" ? "error" : held;
  if (!kind) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center">
      {kind === "error" ? (
        <button
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-warning px-4 py-1.5 text-[12.5px] font-semibold text-warning-content shadow-lg"
          onClick={() => store.retrySync()}
        >
          ⚠️ {t("同步失败 · 点按重试")}
        </button>
      ) : (
        <span className="pointer-events-auto flex items-center gap-2 rounded-full border border-base-300/70 bg-base-100/85 px-4 py-1.5 text-[12.5px] font-medium text-base-content/80 shadow-lg backdrop-blur-md">
          <span className="loading loading-spinner w-3.5 text-primary" />
          {kind === "syncing" ? t("正在同步最新消息…") : t("连接断开 · 重连中…")}
        </span>
      )}
    </div>
  );
}

function TopBar() {
  const t = useT();
  const active = useChatStore((s) => s.state.activeAgent);
  const agents = useChatStore((s) => s.state.agents);
  const streaming = useChatStore((s) => s.state.streaming);
  const nav = useChatNav();
  const info = agents.find((a) => a.name === active);
  const busy = streaming || !!info?.busy;
  // 大总管「聊天 + UI」双轨(2026-07-14 owner):生命周期操作不必经过 LLM。
  // 全屏独立页(不再是居中弹框);窄屏配 #manage hash,系统返回/左滑即退出。
  const [showManage, setShowManage] = useState(false);
  useEffect(() => {
    if (!showManage) return;
    const onPop = () => {
      if (!isManageHash()) setShowManage(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [showManage]);
  const openManage = () => {
    if (isNarrow() && !isManageHash()) window.history.pushState(null, "", MANAGE_HASH);
    setShowManage(true);
  };
  const closeManage = () => {
    if (isManageHash()) window.history.back();
    else setShowManage(false);
  };
  return (
    // 安全区顶部由面板自己垫（bg=base-100，条带与内容同色无缝）
    <header
      className="flex min-h-12 shrink-0 items-center gap-2 border-b border-base-300 bg-base-100 px-3 sm:px-4"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* 移动端：返回会话列表（走 history.back 触发系统返回同款滑动）。桌面端双栏，隐藏 */}
      <button
        className="btn btn-ghost btn-sm -ml-1 px-2 sm:hidden"
        onClick={nav.toList}
        aria-label={t("返回会话列表")}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>
      <span className="truncate font-semibold">
        {info ? t(info.displayName) : active || "Claudestra"}
      </span>
      {/* 回合进行中的显眼标识(owner 2026-07-24:「只显示在聊天框里太不明显」)——
          顶栏脉冲徽章,streaming(本会话流式)或 agent busy 都亮 */}
      {busy && (
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-1.5 rounded-full bg-info" />
          </span>
          {t("思考中")}
        </span>
      )}
      {/* 上下文占用徽章(2026-07-14 owner:context 超标 web 端毫无提示)——v2.21.3+
          点开是「什么时候压」建议卡 + 一键存记忆+Compact,见 ctx-badge.tsx */}
      {info && <CtxBadge agent={info} />}
      {/* 会话级模型/effort 徽章 + 快速切换（owner 2026-07-23） */}
      {info && <ClaudeSwitcher agent={info} />}
      {info?.cwd && (
        <span className="hidden truncate font-mono text-xs opacity-50 sm:inline">
          {info.cwd}
        </span>
      )}
      {/* 右侧操作组：终端（master 也有）+ 会话操作区（清空/重启/停止，大总管不渲染）。
          ⚠ 外层统一 ml-auto 靠右——两个子组件各自 ml-auto 会均分剩余空间（auto margin
          语义），终端按钮会浮到中间。内层残留的 ml-auto 无自由空间，无害。 */}
      {info && (
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {info.pinnedMaster && (
            <button
              className="btn btn-ghost btn-sm px-2 text-[13px]"
              title={t("Agent 管理(生命周期操作,不经过 LLM)")}
              onClick={openManage}
            >
              {t("管理")}
            </button>
          )}
          <SessionSearchButton agentName={info.name} />
          <TerminalButton agent={info} />
          <AgentActions agent={info} />
        </span>
      )}
      <ManagePanel open={showManage} onClose={closeManage} />
    </header>
  );
}

function ChatInner() {
  const store = useChatStoreApi();
  const agents = useChatStore((s) => s.state.agents);
  const activeAgent = useChatStore((s) => s.state.activeAgent);

  // ── 移动端 hash 横滑：会话列表(基础页) ↔ 会话内容(#chat 压栈页) ──
  const [showContent, setShowContent] = useState(false);
  // 首帧禁用过渡：带 #chat 进入（如会话中刷新页面）时直接定位到内容页，
  // 不从列表滑一下（用户反馈的「进来有偏移」）。首帧定位后再开启过渡。
  // popstate（含 iOS 左滑返回）时也临时关动画避免闪屏。
  const [disableTransition, setDisableTransition] = useState(true);
  // 主动 history.back() 触发的 popstate 保留滑动动画
  const skipDisableRef = useRef(false);

  // 首帧按当前 hash 初始化定位，随后开启过渡
  useLayoutEffect(() => {
    // 带 #terminal / #manage 刷新进入：页面态不可恢复（termId 已随连接销毁 /
    // showManage 初始 false），降级回会话内容页（#chat），避免 hash 悬空。
    // #terminal 额外留恢复标记——TerminalButton 挂载后自动重开终端页
    // (iOS PWA 冷恢复=整页重载,用户本来就在终端里,别把人丢回聊天框)
    const hash0 = window.location.hash.split("?")[0];
    if (["#terminal", "#manage"].includes(hash0)) {
      if (hash0 === "#terminal") {
        try {
          sessionStorage.setItem("cstra_term_restore", String(Date.now()));
        } catch {
          /* 隐私模式 */
        }
      }
      window.history.replaceState(null, "", "#chat");
    }
    setShowContent(isContentHash());
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setDisableTransition(false)),
    );
  }, []);

  // v2.21.1+ 跨端已读补清(owner 2026-08-30):打开/回前台时,把别处已读的
  // agent 的存量系统通知从本机通知中心里静默关掉。iOS 收不到 dismiss push
  // (静默 push 有展示惩罚),这条是它唯一的清理通路;其他平台是兜底。
  useEffect(() => {
    void import("@/lib/push/client").then((m) => m.cleanupReadNotifications());
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void import("@/lib/push/client").then((m) => m.cleanupReadNotifications());
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // 浏览器返回（系统级手势 / 返回键）：出栈回到会话列表
  useEffect(() => {
    const onPop = () => {
      if (isNativeShell()) shellLog(`popstate hash=${window.location.hash} content=${isContentHash()}`);
      if (!skipDisableRef.current) setDisableTransition(true);
      setShowContent(isContentHash());
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setDisableTransition(false)),
      );
      skipDisableRef.current = false;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 布局模式(use-keyboard-viewport 模块,死路清单见该文件头):
  // shell = fixed 壳(默认,稳定但 iOS 键盘期 caret 错位);
  // flow = Telegram 式文档流(开关开)——无 fixed 祖先,键盘用真实 document
  // 滚动揭示输入框,caret 天然正确,零 JS 补偿。
  const layoutMode = useLayoutMode();
  useFlowKeyboard(layoutMode === "flow");

  const toContent = useCallback(() => {
    if (!isNarrow()) return; // 桌面双栏并存，无需压栈/位移
    // state 打标:只有我们自己压的条目才允许 history.back()(见 toList)
    if (!isContentHash()) window.history.pushState({ cstra: "chat" }, "", CONTENT_HASH);
    setShowContent(true);
  }, []);

  // v2.21.3+ 快速返回白屏(owner 2026-09-02):history.back() 的 popstate 是异步的,
  // 连点两下返回 / 连续左滑时第二次仍看到 hash 在 → 再 back 一次 → 出栈到 PWA 之前
  // 的空白页,只能重开 app。两道闸:① back 在途期间忽略重复触发;② 只对我们自己
  // pushState 打过标的条目 back——刷新/深链带 #chat 进来的基础条目没有标,直接
  // replaceState 摘掉 hash,不动栈。
  const backInFlightRef = useRef(false);
  const toList = useCallback(() => {
    // 壳内排障打点(owner 2026-09-03「返回失效」,iOS 上看不到 console):记走了哪个分支
    if (isNativeShell()) {
      const st0 = window.history.state as { cstra?: string } | null;
      shellLog(`toList hash=${window.location.hash} state=${JSON.stringify(st0)} inflight=${backInFlightRef.current} len=${window.history.length}`);
    }
    if (isContentHash()) {
      if (backInFlightRef.current) return;
      const st = window.history.state as { cstra?: string } | null;
      if (st?.cstra === "chat") {
        backInFlightRef.current = true;
        skipDisableRef.current = true; // 主动返回：保留滑动动画
        // 一次性监听:这次 back 的 popstate 到达即解锁(不放进共享的 popstate effect——
        // React Compiler 不允许 effect 用过的 ref 再被后定义的回调改写)
        window.addEventListener("popstate", () => { backInFlightRef.current = false; }, { once: true });
        window.history.back();
        // popstate 没来(极端情况)也别永久锁死
        setTimeout(() => { backInFlightRef.current = false; }, 800);
      } else {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        setShowContent(false);
      }
    } else {
      setShowContent(false);
    }
  }, []);

  // ── v2.15+ iOS 几何 bug 根治（2026-07-27 用户双截图:输入光标画到卡片
  //    左下角、📎 的原生文件菜单飘到屏幕中部）:横滑 transform **常驻**会让
  //    iOS 给原生 UI(caret / 菜单锚点)算出错位坐标。方案:只在滑动动画的
  //    300ms 里用 transform,停稳后换成 margin 表达(margin 不建 containing
  //    block,原生 UI 定位恢复正常)。回程用 FLIP:先以 transform 无过渡摆回
  //    旧位,下一帧再开过渡滑向新位——动画观感与原来完全一致。
  type SlideAnim = { from: boolean; to: boolean; running: boolean };
  const [slideAnim, setSlideAnim] = useState<SlideAnim | null>(null);
  const prevShowRef = useRef(showContent);
  useLayoutEffect(() => {
    if (prevShowRef.current === showContent) return;
    const from = prevShowRef.current;
    prevShowRef.current = showContent;
    // 无动画直达(首帧定位/popstate 闪避)或桌面双栏:立即停稳
    if (disableTransition || !isNarrow()) {
      setSlideAnim(null);
      return;
    }
    setSlideAnim({ from, to: showContent, running: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showContent]);
  useEffect(() => {
    if (!slideAnim || slideAnim.running) return;
    // 双 rAF:确保「旧位置 + 无过渡」先被绘制,再切到目标位开动画(FLIP)
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setSlideAnim((a) => (a && !a.running ? { ...a, running: true } : a))),
    );
    return () => cancelAnimationFrame(id);
  }, [slideAnim]);
  useEffect(() => {
    if (!slideAnim?.running) return;
    // transitionEnd 的兜底(后台 tab 不派发/被打断):400ms 强制停稳
    const t = setTimeout(() => setSlideAnim(null), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideAnim?.running]);

  // ── 移动端横滑手势（2026-07-13 owner）：会话页右滑 → 回列表；列表页左滑 →
  //    进入已选会话（未选过不动）。起点在横向可滚容器内（代码块等）不启用，
  //    避免劫持其滚动；纵向为主的手势（滚消息列表）用比例阈值排除。
  const swipeRef = useRef<{ x: number; y: number; hscroll: boolean } | null>(null);
  const onShellTouchStart = (e: React.TouchEvent) => {
    if (!isNarrow() || e.touches.length !== 1) {
      swipeRef.current = null;
      return;
    }
    let el = e.target as HTMLElement | null;
    let hscroll = false;
    while (el && el !== e.currentTarget) {
      if (el.scrollWidth - el.clientWidth > 4) {
        hscroll = true;
        break;
      }
      el = el.parentElement;
    }
    const t = e.touches[0];
    swipeRef.current = { x: t.clientX, y: t.clientY, hscroll };
  };
  const onShellTouchEnd = (e: React.TouchEvent) => {
    const s = swipeRef.current;
    swipeRef.current = null;
    if (!s || s.hscroll) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    // 原生壳里右滑返回交给 WKWebView 的系统手势(AppDelegate 已开启)——JS 再做一次
    // 就是双重后退,会退过基础页到白屏
    if (dx > 0 && showContent) { if (!isNativeShell()) toList(); }
    else if (dx < 0 && !showContent && activeAgent) toContent();
  };

  const nav = useMemo<ChatNav>(
    () => ({ showContent, toContent, toList }),
    [showContent, toContent, toList],
  );

  // 画布色跟随当前面板：列表页(base-200) / 会话页(base-100)。iOS 给安全区/布局视口外
  // 的条带涂的是 html 画布色（body 不设 bg 才轮得到 html，见 globals.css + layout.tsx），
  // 跟随后条带与所在页同色 → 列表页上下色差消失（claude-os 未解决的问题）。
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("canvas-list", !showContent);
    return () => el.classList.remove("canvas-list");
  }, [showContent]);

  // 通知深链(owner 2026-07-16「点通知切到具体 agent」):
  // ① 冷启动:openWindow("/chat?agent=x") → 读 URL 参数打开对应会话;
  // ② 已有窗口:SW notificationclick postMessage → 原地切会话,无整页刷新。
  useEffect(() => {
    const qa = new URLSearchParams(window.location.search).get("agent");
    if (qa) {
      window.history.replaceState(null, "", window.location.pathname);
      void store.openAgent(qa);
      toContent();
    }
    // v2.22+ 原生壳:绑定 APNs 插件事件(token 登记 / 点通知直达),已授权则静默刷新 token
    if (isNativeShell()) {
      void import("@/lib/push/native").then((m) => {
        m.bindNativePushListeners((agent) => {
          void store.openAgent(agent);
          toContent();
        });
        void m.refreshNativeRegistration();
      });
    }
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; agent?: string };
      if (d?.type === "cstra-open-agent" && d.agent) {
        void store.openAgent(d.agent);
        toContent();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, [store, toContent]);

  // 会话恢复：iOS 把后台页整个回收重载后，URL 还带 #chat 但 store 是全新的
  // （activeAgent=""）——之前就卡在空内容页要手动返回重选（2026-07-12 真机）。
  // agents 列表首次到位后：上次会话还在 → 自动重开；不在 → 退回列表页。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || activeAgent || agents.length === 0) return;
    restoredRef.current = true;
    let saved = "";
    try { saved = localStorage.getItem("cstra_last_agent") || ""; } catch { /* 隐私模式 */ }
    if (saved && agents.some((a) => a.name === saved)) {
      void store.openAgent(saved);
    } else if (isContentHash()) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      setShowContent(false);
    }
  }, [agents, activeAgent, store]);

  useEffect(() => {
    store.loadAgents();
    void store.loadProfile();
    // Web Push 的 Service Worker(sw.js 只做推送,不拦资源缓存);注册失败静默
    // ——非 HTTPS/不支持的环境本来就没有推送,设置页开关那里会给明确提示
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    // 回前台时若流断了则重连，并立即刷一次列表（后台期间可能有新 agent）。
    // iOS PWA 从 App 切换器/锁屏回来有时只发 focus/pageshow 不发 visibilitychange
    // (2026-07-14 真机:断流旧帧一直挂着,历史/回复全缺)——三个事件都挂同一
    // handler,5s 节流防连发触发多次对齐。
    let lastAlign = 0;
    const onVisible = () => {
      // 进后台时刻是回前台快路径的判据(<5min → SSE 断点重放,不全量重拉)
      if (document.visibilityState === "hidden") {
        store.noteHidden();
        return;
      }
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAlign < 5_000) return;
      lastAlign = now;
      store.maybeReconnect();
      store.refreshAgents();
      // iOS PWA 从后台回来偶发合成层黑屏（GPU 层被回收后未重绘,2026-07-13
      // 真机）——需要强制一次重绘。⚠ 不能用 display:none 切换:那会拆掉整棵
      // 布局树,iOS 重建后触摸滚动区域经常注册失败,整页卡死不能滚(2026-07-21
      // 用户报「跳回 PWA 经常无法滚动」)。改用 transform nudge:同步加/撤
      // translateZ(0),中间态的强制 reflow 留下 sticky invalidation → compositor
      // 重提交、重新光栅化被回收的 GPU 层,但布局树全程不动,滚动容器无恙。
      requestAnimationFrame(() => {
        document.body.style.transform = "translateZ(0)";
        void document.body.offsetHeight;
        document.body.style.transform = "";
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("pageshow", onVisible);
    // 轮询感知本端之外的 roster 变化（master/CLI/其他端 创建/kill/restart agent）——
    // 无实时事件可挂，只能轮询；仅前台，diff-guard 只在列表真变时才 re-render。
    // ⚠ 间隔受 Bridge 限流约束：web-ui token 限 30 req/min（bridge.ts SlidingWindowLimiter，
    // 每 token 独立）。这条轮询和「持久 SSE 流 + 历史 + 发送」共用同一 token 的额度，
    // 太密会把额度打爆 → Bridge 429 → BFF 转 502 → SSE 流被掐断（实时推送失效）+ 列表间歇 502。
    // 4s(=15/min) 曾把额度吃掉一半引发此故障；15s(=4/min) 留足 26/min 给交互。别再调低。
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") store.refreshAgents();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("pageshow", onVisible);
      clearInterval(poll);
    };
  }, [store]);

  return (
    <ChatNavContext.Provider value={nav}>
      {/* PWA 应用壳,两种模式（use-keyboard-viewport 的 LayoutMode）:
          shell(默认) = fixed inset-0 overflow-hidden(对齐 claude-os):出流锁滚动,
          但 iOS 键盘期 fixed 壳被 vv pan 顶出屏,caret/原生菜单错位。
          flow(实验开关) = in-flow h-dvh(Telegram Web 式):无 fixed 祖先,键盘用
          真实 document 滚动揭示输入框,caret 天然正确;键盘关时文档滚动范围为 0,
          橡皮筋由 overscroll-none 抑制。
          通用:安全区 padding 归各面板自己垫;⚠ 不要给 html/body 加 overflow:hidden。
          onScroll 归零守卫(壳自身的 scrollTop/Left,非 window):overflow:hidden 只是
          视觉裁剪,程序滚动残留会叠在横滑位移上,任何此类滚动立即归零。 */}
      <div
        id="cstra-shell"
        className={
          layoutMode === "flow"
            ? // flow(Telegram 式):in-flow 的 h-dvh 容器,无 fixed 祖先——键盘用
              // 真实 document 滚动揭示输入框,caret 天然正确。overscroll-none
              // 抑制根滚动器的橡皮筋(键盘关时滚动范围为 0)。
              "relative h-dvh w-full overflow-hidden overscroll-none bg-base-100"
            : "fixed inset-0 overflow-hidden bg-base-100"
        }
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
          if (el.scrollTop !== 0) el.scrollTop = 0;
        }}
        onTouchStart={onShellTouchStart}
        onTouchEnd={onShellTouchEnd}
      >
        {/* 内容层:两种模式都是铺满根的 flex 行(kb 钉扎已随 flow 模式废弃) */}
        <div className="absolute inset-0 flex overflow-hidden">
        {/* 横滑容器：移动端 sidebar + main 各 w-full 并排溢出，showContent 时整体 -100% 切到内容；
            桌面端（sm+）sidebar 定宽 + main flex-1 双栏并存，位移恒 0。
            ⚠ transform 只在动画的 300ms 内出现,停稳态用 relative+left——常驻
            transform 会让 iOS 把 caret/原生菜单锚点画到错位坐标(见 SlideAnim 注释)。
            ⚠ 停稳态绝不能用负 margin:margin 参与 flex 可用空间计算,flex-1 项
            会被挤崩(2026-07-27 崩版事故);relative+left 是纯视觉偏移,布局树不动。 */}
        <div
          onTransitionEnd={(e) => {
            if (e.target === e.currentTarget && e.propertyName === "transform") setSlideAnim(null);
          }}
          className={`flex min-h-0 w-full flex-1 ${
            slideAnim
              ? `transform-gpu will-change-transform ${
                  slideAnim.running ? "transition-transform duration-300 ease-out" : "transition-none"
                } ${
                  (slideAnim.running ? slideAnim.to : slideAnim.from)
                    ? "-translate-x-full sm:translate-x-0"
                    : "translate-x-0"
                }`
              : `relative transition-none ${showContent ? "left-[-100%] sm:left-0" : "left-0"}`
          }`}
        >
          <Sidebar onSelect={toContent} />

          <main className="flex w-full min-w-0 shrink-0 flex-col bg-base-100 sm:w-0 sm:flex-1">
            <TopBar />
            {/* 对齐横幅锚点:零高度 relative 壳,chip 绝对定位悬浮在消息区顶部,
                不产生布局位移。⚠ 不能 fixed——本容器在横滑 transform 内(规则 5b) */}
            <div className="relative">
              <SyncBanner />
            </div>
            <MessageList />
            <Composer />
          </main>
        </div>
        </div>
        {/* 全屏启动页：在横滑 transform 容器之外（规则 5.5——fixed 不能在
            transform 祖先内定位），盖住整个入场加载过程 */}
        <Splash />
      </div>
    </ChatNavContext.Provider>
  );
}

export function Chat() {
  return (
    <ChatStoreProvider>
      <ChatInner />
    </ChatStoreProvider>
  );
}
