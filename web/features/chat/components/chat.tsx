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
import { ctxLevel } from "../ctx-level";
import { useT } from "@/lib/i18n";

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
      {/* 上下文占用徽章(2026-07-14 owner:context 超标 web 端毫无提示)。
          色阶按 1M 窗口(owner 定档):≥200k 黄,≥500k 红,≥750k 深红(实色);
          <200k 不打扰(不显示)。 */}
      {typeof info?.contextTokens === "number" && info.contextTokens >= 200_000 && (
        <span
          title={t("当前会话上下文占用(建议在对话里让 agent /compact)")}
          className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px] tabular-nums ${
            {
              deep: "bg-error text-error-content",
              high: "bg-error/15 text-error",
              mid: "bg-warning/15 text-warning",
              none: "bg-base-300 text-base-content/50",
            }[ctxLevel(info.contextTokens)]
          }`}
        >
          ctx {Math.round(info.contextTokens / 1000)}k
        </span>
      )}
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

  // 浏览器返回（系统级手势 / 返回键）：出栈回到会话列表
  useEffect(() => {
    const onPop = () => {
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

  const toContent = useCallback(() => {
    if (!isNarrow()) return; // 桌面双栏并存，无需压栈/位移
    if (!isContentHash()) window.history.pushState(null, "", CONTENT_HASH);
    setShowContent(true);
  }, []);

  const toList = useCallback(() => {
    if (isContentHash()) {
      skipDisableRef.current = true; // 主动返回：保留滑动动画
      window.history.back();
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
    if (dx > 0 && showContent) toList();
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
      {/* PWA 应用壳（对齐 claude-os）：出流的 fixed inset-0 overflow-hidden 就是锁滚动的
          全部——body 里没有流内容 → 文档天然不滚，滚动只在内部 overflow-y-auto。⚠ 不要给
          html/body 加 overflow:hidden（会干扰 viewport-fit 撑满、底部不贴屏底，见 globals.css）。
          安全区 padding 归各面板自己垫、条带色=面板色（不放根层，避免异色面板成色差条）。
          onScroll 归零守卫：overflow:hidden 只是视觉裁剪，程序（iOS 键盘聚焦滚动 /
          scrollIntoView 类调用）仍可给它塞 scrollLeft/scrollTop——残留量会叠在横滑
          translate 上，让会话页「弹过头」渲染不满视窗。任何此类滚动立即归零。 */}
      <div
        className="fixed inset-0 flex overflow-hidden bg-base-100"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollLeft !== 0) el.scrollLeft = 0;
          if (el.scrollTop !== 0) el.scrollTop = 0;
        }}
        onTouchStart={onShellTouchStart}
        onTouchEnd={onShellTouchEnd}
      >
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
            <MessageList />
            <Composer />
          </main>
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
