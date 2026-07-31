"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { SettingsModal } from "./settings-modal";
import { InstallBanner } from "./install-banner";
import { PushBanner } from "./push-banner";
import { StatsPanel } from "./stats-panel";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";
import { fmtAgo } from "../fmt-time";
import { useT, getLang } from "@/lib/i18n";
import { ChatHitRow, type ChatSearchHit } from "./search-hits";

/** 大总管图标（lucide network,调度/编排语义）——替代 👑(owner 2026-07-15:
 *  「皇冠不要了,显得更专业一点」)。 */
function MasterIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <path d="M12 12V8" />
    </svg>
  );
}

function StatusDot({ status, busy }: { status: AgentSession["status"]; busy?: boolean }) {
  if (status === "active") {
    // 运行中：实心核心点 + 柔和呼吸外晕（cstra-breathe，替换生硬的 animate-ping）。
    // 正在干活（tmux 非空闲 / 本端流式中）→ 黄色；空闲 → 绿色。
    const tone = busy ? "bg-warning" : "bg-success";
    return (
      <span className="relative flex size-2.5 shrink-0 items-center justify-center">
        <span className={`animate-cstra-breathe absolute inline-flex size-2.5 rounded-full ${tone}`} />
        <span className={`relative inline-flex size-2 rounded-full ${tone}`} />
      </span>
    );
  }
  return (
    <span className="inline-flex size-2.5 shrink-0 rounded-full bg-base-content/25" />
  );
}


/**
 * 会话列表行——纯选择项。会话操作（清空/重启/停止）已迁到会话详情顶栏
 * （agent-actions.tsx），列表保持干净。
 */
function AgentRow({
  a,
  active,
  busyLive,
  pinned,
  onTogglePin,
  onSelect,
  manage = false,
  checked = false,
  onToggleCheck,
}: {
  a: AgentSession;
  active: boolean;
  /** 本端正在流式对话（active agent 的实时忙碌,比 15s 轮询的 busy 快） */
  busyLive: boolean;
  /** 用户置顶(localStorage 偏好,master 恒顶不算) */
  pinned: boolean;
  onTogglePin: () => void;
  onSelect: () => void;
  /** 多选管理模式(owner 2026-07-16):行首 checkbox,点行=选中,禁左滑 */
  manage?: boolean;
  checked?: boolean;
  onToggleCheck?: () => void;
}) {
  const store = useChatStoreApi();
  const t = useT(); // 也订阅语言切换,保证 fmtAgo 标签随切换重渲
  // 相对时间(owner 2026-07-14):x秒前/x分钟前/x小时x分前/x天前;
  // Sidebar 的 30s tick 让它保鲜
  const lastAt = fmtAgo(a.lastActivityTs);
  // 左滑删除(owner 2026-07-14:「临时起的 agent 污染列表,永久删除」):
  // 横滑露出红色删除钮,二次点击确认后 removeAgent(kill + registry 条目删,
  // 归档保留)。纵向意图让路给列表滚动;master/mock 不可删。
  const canRemove = !a.pinnedMaster && !a.mock;
  const swipeEnabled = canRemove && !manage; // 多选模式下手势让位
  const [swipeX, setSwipeX] = useState(0);
  const [confirmDel, setConfirmDel] = useState(false);
  const [removing, setRemoving] = useState(false);
  const touchRef = useRef<{ x: number; y: number; startX: number; swiping: boolean } | null>(null);
  const closeSwipe = () => {
    setSwipeX(0);
    setConfirmDel(false);
  };
  // ctx 用量背景条（owner 2026-07-14:用量看板藏太深,列表行内直接可视化）:
  // 行背景自左向右填充,宽=占 1M 窗口比例;色阶同顶栏 ctx 徽章
  // (≥750k 深红 / ≥500k 红 / ≥200k 黄 / 其余中性淡灰),平时几乎隐形,超标一眼看见。
  const ctx = a.status === "active" && typeof a.contextTokens === "number" ? a.contextTokens : 0;
  const ctxPct = Math.min(100, Math.round((ctx / CTX_WINDOW) * 100));
  const ctxTone = {
    deep: "bg-error/35",
    high: "bg-error/15",
    mid: "bg-warning/15",
    none: "bg-base-content/[0.05]",
  }[ctxLevel(ctx)];

  return (
    <li>
      <div className="relative overflow-hidden rounded-lg">
        {/* 左滑露出的操作钮(在滑动层下面):置顶 + 删除 */}
        {swipeX < 0 && (
          <div className="absolute inset-y-0 right-0 z-0 flex w-[160px]">
            <button
              className="flex flex-1 items-center justify-center bg-base-content/70 text-[13px] font-medium text-base-100"
              onClick={() => {
                onTogglePin();
                closeSwipe();
              }}
            >
              {pinned ? t("取消置顶") : t("置顶")}
            </button>
            <button
              className="flex flex-1 items-center justify-center bg-error text-[13px] font-medium text-error-content"
              onClick={async () => {
                if (removing) return;
                if (!confirmDel) {
                  setConfirmDel(true);
                  return;
                }
                setRemoving(true);
                const r = await store.removeAgent(a.name);
                if (!r.ok) {
                  setRemoving(false);
                  closeSwipe();
                  alert(`${t("删除失败:")}${t(r.error || "操作失败")}`);
                }
                // 成功时本行随列表数据一起消失,无需复位
              }}
            >
              {removing ? "…" : confirmDel ? t("确认?") : t("删除")}
            </button>
          </div>
        )}
        <div
          className={`relative z-[1] flex items-center gap-2.5 overflow-hidden rounded-lg px-2 py-2.5 sm:gap-2 sm:py-1.5 ${
            // active:bg 按压即时反馈——触屏无 hover,没有按压态点击像「没反应」
            active ? "bg-base-300" : "bg-base-200 hover:bg-base-300/60 active:bg-base-300"
          }`}
          style={{
            transform: swipeX ? `translateX(${swipeX}px)` : undefined,
            // 刻意保留在 render 期读这个 ref：把 swiping 提成 state 意味着触摸拖动的
            // 每一帧都要 setState 并重渲整个会话列表，交互热路径上性能明显更差。
            // 这里只用它决定要不要禁用 transition，读到偶发旧值最坏就是一帧过渡不对。
            // eslint-disable-next-line react-hooks/refs
            transition: touchRef.current?.swiping ? "none" : "transform 0.18s ease",
          }}
          onTouchStart={
            swipeEnabled
              ? (e) => {
                  touchRef.current = {
                    x: e.touches[0].clientX,
                    y: e.touches[0].clientY,
                    startX: swipeX,
                    swiping: false,
                  };
                }
              : undefined
          }
          onTouchMove={
            swipeEnabled
              ? (e) => {
                  const t = touchRef.current;
                  if (!t) return;
                  const dx = e.touches[0].clientX - t.x;
                  const dy = e.touches[0].clientY - t.y;
                  // 纵向意图让路给列表滚动;横向位移 >8px 才认定滑动
                  if (!t.swiping) {
                    if (Math.abs(dy) > Math.abs(dx)) {
                      touchRef.current = null;
                      return;
                    }
                    if (Math.abs(dx) < 8) return;
                    t.swiping = true;
                  }
                  setSwipeX(Math.max(-160, Math.min(0, t.startX + dx)));
                }
              : undefined
          }
          onTouchEnd={
            swipeEnabled
              ? () => {
                  const t = touchRef.current;
                  touchRef.current = null;
                  if (!t?.swiping) return;
                  setSwipeX((x) => {
                    const snap = x < -60 ? -160 : 0;
                    if (snap === 0) setConfirmDel(false);
                    return snap;
                  });
                }
              : undefined
          }
        >
        {ctx > 0 && (
          <span
            aria-hidden
            className={`absolute inset-y-0 left-0 ${ctxTone}`}
            style={{ width: `${ctxPct}%` }}
          />
        )}
        <button
          className="relative flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-2"
          onClick={() => {
            // 多选模式:点行 = 切换选中(不可删的行忽略)
            if (manage) {
              if (canRemove) onToggleCheck?.();
              return;
            }
            // 滑开状态下点行 = 收起,不进会话
            if (swipeX !== 0) {
              closeSwipe();
              return;
            }
            // 两阶段提交(2026-07-24 owner「点上去卡卡的」):openAgent 的
            // produce(整份 messages 替换 → 30+ 条 markdown 全量渲染)若与
            // toContent 的横滑 className 同一 commit,重渲染把 commit 拖住
            // 几百 ms,滑动迟迟不启动,手感=点了没反应然后猛跳。先只提交
            // 横滑(轻,首帧画出后动画由 compositor 接管,主线程再忙也不掉),
            // 双 rAF 等首帧落地再灌会话内容。
            onSelect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                void store.openAgent(a.name);
              }),
            );
          }}
        >
          {manage && (
            <span
              className={`grid size-5 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                !canRemove
                  ? "border-base-content/15 opacity-30"
                  : checked
                    ? "border-error bg-error text-error-content"
                    : "border-base-content/30"
              }`}
            >
              {checked && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
            </span>
          )}
          {a.pinnedMaster ? (
            <MasterIcon className="size-4 shrink-0 text-base-content/60" />
          ) : (
            <StatusDot status={a.status} busy={a.busy || busyLive} />
          )}
          <span className="min-w-0 flex-1 truncate text-[15px] sm:text-sm">
            {pinned && <span className="mr-0.5 text-[10px]">📌</span>}
            {t(a.displayName)}
            {a.pinnedMaster && (
              <span className="badge badge-primary badge-xs ml-1 align-middle">
                {t("总控")}
              </span>
            )}
            {a.mock && (
              <span className="badge badge-ghost badge-xs ml-1 align-middle">
                mock
              </span>
            )}
          </span>
          {/* busy 时不显示过期时间(owner 2026-07-16:「明明在工作却显示 48 分钟前」
              ——lastActivityTs 读 jsonl 最后一条对话,CC 回合内攒内存不落盘,长回合
              期间时间冻结在回合开始前)→ 显示「工作中」更诚实 */}
          {(a.busy || busyLive) ? (
            <span className="shrink-0 pl-1 text-[11px] text-warning/80">{t("工作中")}</span>
          ) : (
            lastAt && (
              <span className="shrink-0 pl-1 font-mono text-[11px] tabular-nums text-base-content/35">
                {lastAt}
              </span>
            )
          )}
        </button>
        </div>
      </div>
    </li>
  );
}

/**
 * 会话列表面板。移动端是全屏「菜单」（w-full，横滑容器的基础页）；桌面端定宽常驻左栏（sm:w-64）。
 * onSelect：选中会话后回调（移动端 = 横滑到内容页 toContent；桌面端空转）。
 */
export function Sidebar({ onSelect }: { onSelect: () => void }) {
  const store = useChatStoreApi();
  const t = useT();
  const agents = useChatStore((s) => s.state.agents);
  const loading = useChatStore((s) => s.state.loadingAgents);
  const ready = useChatStore((s) => s.state.agentsReady);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
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
  const [showSettings, setShowSettings] = useState(false);
  // 左下角版本徽标(owner 2026-07-31):服务端版本+commit,/api/version 一次性拉
  const [verInfo, setVerInfo] = useState<{ version?: string; commit?: string } | null>(null);
  useEffect(() => {
    fetch("/api/version")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => j && setVerInfo(j))
      .catch(() => {});
  }, []);
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
      const res = await fetch(`/api/chat/search?q=${encodeURIComponent(term)}`);
      const json = (await res.json()) as { data?: ChatSearchHit[] };
      setChatHits(Array.isArray(json.data) ? json.data : []);
    } catch {
      setChatHits([]);
    }
    setSearching(false);
  };
  const pinSet = new Set(pinnedList);
  // 大总管独立入口(owner 2026-07-14:「跟普通 agent 区分开」)——不进列表、
  // 不参与搜索过滤,常驻列表区顶部的边框卡片
  const master = agents.find((a) => a.pinnedMaster);
  const workers = agents.filter((a) => !a.pinnedMaster);
  const filtered = (
    q
      ? workers.filter((a) => `${a.displayName} ${a.name} ${a.purpose}`.toLowerCase().includes(q))
      : workers
  )
    .slice()
    .sort((a, b) => {
      const rank = (x: AgentSession) => (pinSet.has(x.name) ? 1 : 0);
      return rank(b) - rank(a); // 稳定排序:置顶组保持原相对顺序
    });

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
      {/* 安全区顶部由面板自己垫（bg=base-200，条带与列表同色无缝）。
          刷新按钮已移除（列表由 15s 轮询 + 回前台重连自动感知 roster 变化）；
          新建会话统一走大总管对话，Web 侧不再单独提供入口。 */}
      <div
        className="px-4 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <div className="flex items-center pb-2.5">
          <span className="font-semibold">{t("会话")}</span>
          <button
            className={`ml-auto flex h-7 items-center justify-center rounded-lg px-1.5 transition-colors ${
              manage
                ? "text-primary"
                : "text-base-content/50 hover:bg-base-300 hover:text-base-content"
            }`}
            title={manage ? t("退出多选") : t("多选管理（批量删除）")}
            aria-label={manage ? t("退出多选") : t("多选管理")}
            onClick={() => (manage ? exitManage() : setManage(true))}
          >
            {manage ? (
              <span className="text-xs font-medium">{t("完成")}</span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m3 17 2 2 4-4" />
                <path d="m3 7 2 2 4-4" />
                <path d="M13 6h8" />
                <path d="M13 12h8" />
                <path d="M13 18h8" />
              </svg>
            )}
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title={t("用量看板")}
            aria-label={t("用量看板")}
            onClick={() => setShowStats(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3v16a2 2 0 0 0 2 2h16" />
              <path d="M7 13v4" />
              <path d="M12 9v8" />
              <path d="M17 5v12" />
            </svg>
          </button>
          <button
            className="flex size-7 items-center justify-center rounded-lg text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title={t("设置")}
            aria-label={t("设置")}
            onClick={() => setShowSettings(true)}
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
            {searching ? t("正在搜聊天记录…") : `${t("搜聊天记录「")}${query.trim()}${t("」")}`}
          </button>
        )}
      </div>

      {/* 添加到主屏幕引导（浏览器标签页访问且未 dismiss 时显示） */}
      <InstallBanner />
      {/* 开启推送引导（已具备推送能力且没问过权限时显示,与安装引导天然互斥） */}
      <PushBanner />

      {/* touch-pan-y + overscroll-contain：iOS 到边界时滚动链会穿透到不可滚的
          fixed 应用壳，橡皮筋吃掉手势看着像「滑不动」（BgLines 同款修法）。 */}
      <div
        className="flex-1 touch-pan-y overflow-y-auto overscroll-contain px-2 pb-3"
        style={{ WebkitOverflowScrolling: "touch" }}
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
            onClick={() => {
              store.openAgent(master.name);
              onSelect();
            }}
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
            {(master.busy || (active === master.name && streaming)) && (
              <span className="size-2 shrink-0 rounded-full bg-warning" />
            )}
          </button>
        )}
        {agents.length > 0 && filtered.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">{t("没有匹配「")}{query.trim()}{t("」的会话")}</div>
        )}
        {/* 不用 daisyUI menu 类——它给每行自带 :hover/:active 按压高亮，iOS 上
            手指一碰就闪（滑动时「一直触发 hover 特效」，2026-07-13 真机）；
            行样式本来就是自定义的。 */}
        <ul className="flex w-full list-none flex-col gap-0.5 p-0">
          {filtered.map((a) => (
            <AgentRow
              key={a.name}
              a={a}
              active={active === a.name}
              busyLive={active === a.name && streaming}
              pinned={pinSet.has(a.name)}
              onTogglePin={() => togglePin(a.name)}
              onSelect={onSelect}
              manage={manage}
              checked={sel.has(a.name)}
              onToggleCheck={() => toggleSel(a.name)}
            />
          ))}
        </ul>
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
              `${t("确认删除 ")}${sel.size}${t(" 个?")}`
            ) : getLang() === "en" ? (
              `Delete${sel.size ? ` ${sel.size}` : ""}`
            ) : (
              `删除${sel.size ? ` ${sel.size} 个` : ""}`
            )}
          </button>
        </div>
      ) : (
        /* 底部安全区：max() 取大不叠加——home 条区高度只算一次，不再「env+间距」双层 */
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
      )}
      <SettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
      <StatsPanel open={showStats} onClose={() => setShowStats(false)} />
    </aside>
  );
}
