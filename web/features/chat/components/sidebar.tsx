"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi, noteSidebarInteraction } from "../chat-store";
import type { AgentSession, ProjectMeta } from "../type";
import { SettingsModal } from "./settings-modal";
import { ProjectsModal } from "./projects-modal";
import { InstallBanner } from "./install-banner";
import { PushBanner } from "./push-banner";
import { StatsPanel } from "./stats-panel";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";
import { fmtAgo } from "../fmt-time";
import { useT, getLang } from "@/lib/i18n";
import { ChatHitRow, type ChatSearchHit } from "./search-hits";

/** v2.17.2 点击串台修复(peer HedeMacBook-Pro 代码级归因,2026-08-09):
 *  列表按活动排序 + roster 指纹含易变字段 + 前台 15s 轮询 → 重排是常态;
 *  移动端 touchstart→click 有 50-300ms 派发延迟,重排落在窗口内时 click
 *  会落在滑进指位的**另一行**上,打开错的会话。修法:pointerdown(按下一刻,
 *  重排发生前)记录目标行——那才是用户的真实意图;click 时优先用它。
 *  模块级共享:重排后接住 click 的是别的行实例,必须能读到按下方记录的值。 */
let tapIntent: { name: string; ts: number } | null = null;

/** v2.21+ 方案 A 的沉寂判定:>30 天没真实对话(或从未说话且已停止)。
 *  忙碌的永不算沉寂。30s tick 重渲时会重估,模块级函数与 fmtAgo 同款先例。 */
const DORMANT_MS = 30 * 24 * 3600_000;
function isDormantAgent(a: AgentSession): boolean {
  if (a.busy) return false;
  const ts = a.lastActivityTs ?? null;
  return ts ? Date.now() - ts > DORMANT_MS : a.status === "stopped";
}
/** 意图有效窗口:covers 移动端最长 click 派发延迟,又不至于让陈旧意图
 *  污染下一次独立点击(键盘激活无 pointerdown,走闭包兜底)。 */
const TAP_INTENT_TTL_MS = 1_200;

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

/**
 * v2.21.3+ 当前滑开的那一行的收回函数——同一时刻只允许一行滑开(iOS Mail / 微信同款):
 * 列表滚动、别的行出现纵向手势或被点击,都先把它收回。
 */
const swipeReg = {
  cur: null as (() => void) | null,
  set(fn: () => void) { this.cur = fn; },
  clear(fn: () => void) { if (this.cur === fn) this.cur = null; },
  closeAll() { this.cur?.(); },
  /** 收回除 fn 之外的滑开行 */
  closeOthers(fn: () => void) { if (this.cur && this.cur !== fn) this.cur(); },
};

function StatusDot({ status, busy, compacting }: { status: AgentSession["status"]; busy?: boolean; compacting?: boolean }) {
  if (status === "active") {
    // 运行中：实心核心点 + 柔和呼吸外晕（cstra-breathe，替换生硬的 animate-ping）。
    // 正在干活（tmux 非空闲 / 本端流式中）→ 黄色；空闲 → 绿色；
    // v2.21.2+ 正在压缩上下文 → 蓝色（既不是空闲也不是普通回合）。
    const tone = compacting ? "bg-info" : busy ? "bg-warning" : "bg-success";
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
  compacting = false,
  pinned,
  onTogglePin,
  onSelect,
  manage = false,
  checked = false,
  onToggleCheck,
  projEmoji,
}: {
  a: AgentSession;
  active: boolean;
  /** 本端正在流式对话（active agent 的实时忙碌,比 15s 轮询的 busy 快） */
  busyLive: boolean;
  /** v2.21.2+ 正在压缩上下文（轮询字段 或 active agent 的实时状态） */
  compacting?: boolean;
  /** 用户置顶(localStorage 偏好,master 恒顶不算) */
  pinned: boolean;
  onTogglePin: () => void;
  onSelect: () => void;
  /** 多选管理模式(owner 2026-07-16):行首 checkbox,点行=选中,禁左滑 */
  manage?: boolean;
  checked?: boolean;
  onToggleCheck?: () => void;
  /** v2.21+ 单人 project 的合并行:project 自定义 emoji 前缀(未自定义不显,防噪) */
  projEmoji?: string;
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
  // v2.21.3+ 拖动期间不再每帧 setState(整行 + 订阅链重渲,owner「左滑特别卡」):
  // 手指跟随直接写 style.transform,dragging 只在识别到滑动/松手时各切一次
  // (挂载操作钮、关过渡);swipeX 只在松手吸附时提交。transform 从不经 React 的
  // style 对象,其余重渲不会把手指位置打回去。
  const slideRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const touchRef = useRef<{ x: number; y: number; startX: number; swiping: boolean; lastX: number } | null>(null);
  const applyX = (x: number) => {
    const el = slideRef.current;
    if (el) el.style.transform = x ? `translateX(${x}px)` : "";
  };
  const closeSwipe = () => {
    applyX(0);
    setSwipeX(0);
    setConfirmDel(false);
    swipeReg.clear(closeSwipe);
  };
  // 卸载时别把自己留在「当前滑开」槽里
  useEffect(() => () => swipeReg.clear(closeSwipe));
  // ctx 用量背景条（owner 2026-07-14:用量看板藏太深,列表行内直接可视化）:
  // 行背景自左向右填充,宽=占 1M 窗口比例;色阶同顶栏 ctx 徽章
  // (≥750k 深红 / ≥500k 红 / ≥200k 黄 / 其余中性淡灰)。
  // v2.21.4 曾改成行底 2px 细线,owner 2026-09-06「有点丑,回滚之前的再优化一下」:
  // 保留填充,右缘用 mask 渐隐(不再是一块硬边色块,读起来像仪表而不像选中高亮),
  // 浓度各降一档;「工作中」自此用闪烁外框表达,填充只剩「占用」一种含义。
  const ctx = a.status === "active" && typeof a.contextTokens === "number" ? a.contextTokens : 0;
  const ctxPct = Math.min(100, Math.round((ctx / CTX_WINDOW) * 100));
  const ctxTone = {
    deep: "bg-error/30",
    high: "bg-error/14",
    mid: "bg-warning/12",
    none: "bg-base-content/[0.04]",
  }[ctxLevel(ctx)];
  // 忙碌态 = 行外框(owner 2026-09-06:「工作中给它加一个不断闪烁的黄色边框」);
  // 压缩中同款蓝色常亮。状态点 / 「工作中」文字保留,边框是给一眼扫过用的。
  const busyNow = !!(a.busy || busyLive);

  return (
    <li>
      <div className="relative overflow-hidden rounded-lg">
        {/* 左滑露出的操作钮(在滑动层下面):置顶 + 删除 */}
        {(swipeX < 0 || dragging) && (
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
          ref={slideRef}
          className={`relative z-[1] flex touch-pan-y items-center gap-2.5 overflow-hidden rounded-lg px-2 py-2.5 sm:gap-2 sm:py-1.5 ${
            // active:bg 按压即时反馈——触屏无 hover,没有按压态点击像「没反应」
            active ? "bg-base-300" : "bg-base-200 hover:bg-base-300/60 active:bg-base-300"
          }`}
          style={{ transition: dragging ? "none" : "transform 0.18s ease" }}
          onTouchStart={
            swipeEnabled
              ? (e) => {
                  touchRef.current = {
                    x: e.touches[0].clientX,
                    y: e.touches[0].clientY,
                    startX: swipeX,
                    lastX: swipeX,
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
                      // 纵向手势 = 想滚列表 → 滑开的行(包括自己)一律收回(微信同款;
                      // owner 2026-09-02:列表不够长滚不动时 onScroll 不触发,不能只靠它)
                      swipeReg.closeAll();
                      return;
                    }
                    if (Math.abs(dx) < 8) return;
                    t.swiping = true;
                    // 开始拖这一行 → 别的滑开行先收回
                    swipeReg.closeOthers(closeSwipe);
                    setDragging(true);
                  }
                  t.lastX = Math.max(-160, Math.min(0, t.startX + dx));
                  applyX(t.lastX);
                }
              : undefined
          }
          onTouchEnd={
            swipeEnabled
              ? () => {
                  const t = touchRef.current;
                  touchRef.current = null;
                  if (!t?.swiping) return;
                  const snap = t.lastX < -60 ? -160 : 0;
                  applyX(snap);
                  setDragging(false);
                  setSwipeX(snap);
                  if (snap === 0) {
                    setConfirmDel(false);
                    swipeReg.clear(closeSwipe);
                  } else {
                    swipeReg.set(closeSwipe);
                  }
                }
              : undefined
          }
        >
        {ctx > 0 && (
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-y-0 left-0 ${ctxTone}`}
            style={{
              width: `${ctxPct}%`,
              WebkitMaskImage: "linear-gradient(to right, #000 55%, transparent)",
              maskImage: "linear-gradient(to right, #000 55%, transparent)",
            }}
          />
        )}
        {(busyNow || compacting) && (
          <span
            aria-hidden
            className={`pointer-events-none absolute inset-0 z-[2] rounded-lg border-[1.5px] ${
              compacting ? "border-info/80" : "cstra-busy-blink border-warning"
            }`}
          />
        )}
        <button
          className="relative flex min-w-0 flex-1 items-center gap-2.5 text-left sm:gap-2"
          onPointerDown={() => {
            tapIntent = { name: a.name, ts: Date.now() };
          }}
          onClick={() => {
            // 串台守卫:按下一刻的目标优先于闭包值(见文件头 tapIntent 注释)
            const intended =
              tapIntent && Date.now() - tapIntent.ts < TAP_INTENT_TTL_MS ? tapIntent.name : a.name;
            tapIntent = null;
            // 多选模式:点行 = 切换选中(不可删的行忽略)
            if (manage) {
              if (canRemove) onToggleCheck?.();
              return;
            }
            // 滑开状态下点行 = 收起,不进会话;别的行滑开时点这行 = 收回那行,也不进会话
            if (swipeX !== 0) {
              closeSwipe();
              return;
            }
            if (swipeReg.cur) {
              swipeReg.closeAll();
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
                void store.openAgent(intended);
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
            <StatusDot status={a.status} busy={a.busy || busyLive} compacting={compacting} />
          )}
          <span className="min-w-0 flex-1 truncate text-[15px] sm:text-sm">
            {pinned && <span className="mr-0.5 text-[10px]">📌</span>}
            {t(a.displayName)}
            {/* 单人 project 的归属 emoji 挪到名字后面、缩小压淡:放在行首会跟组头的
                「emoji + 名字」长得一样(owner 2026-09-06「文件夹跟 agent 像同一个样式,
                不知道该点哪个」)——行首只留状态点 = 这是 agent 不是文件夹 */}
            {projEmoji && <span className="ml-1.5 text-[11px] opacity-60 align-middle">{projEmoji}</span>}
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
          {compacting ? (
            <span className="shrink-0 pl-1 text-[11px] text-info/80">{t("压缩中")}</span>
          ) : (a.busy || busyLive) ? (
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
  const projects = useChatStore((s) => s.state.projects);
  const loading = useChatStore((s) => s.state.loadingAgents);
  const ready = useChatStore((s) => s.state.agentsReady);
  const active = useChatStore((s) => s.state.activeAgent);
  const streaming = useChatStore((s) => s.state.streaming);
  const compactingLive = useChatStore((s) => s.state.compacting);
  const listTouchY = useRef<number | null>(null);
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
  // v2.21+ project 分组(owner 2026-08-28)。搜索时退回平铺(结果直给,不折叠)。
  // 组序 = 组内最近活动(filtered 已按活动排,Map 插入序即组的活动序);未分组沉底。
  const [showProjects, setShowProjects] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const v = JSON.parse(localStorage.getItem("cstra_proj_collapsed") || "[]");
      return new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  // 「💤 沉寂」组的展开态:默认折叠,会话内记忆即可(不持久化——每次进来先收起)
  const [dormantOpen, setDormantOpen] = useState(false);
  const toggleProjectCollapse = (id: string) =>
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem("cstra_proj_collapsed", JSON.stringify([...next]));
      } catch {
        /* 隐私模式 */
      }
      return next;
    });
  const projMeta = new Map(projects.map((p) => [p.id, p] as const));
  // 分组只在 project 有 ≥2 个成员时呈现(owner 2026-08-28 图评:「agent 比
  // project 还大,毫无条理」——单人组的组头 = 同名冗余噪音)。单成员/未分组
  // 的 agent 平铺,停留在自身活动排序的位次上;组整体占据最活跃成员的位次。
  type SidebarEntry =
    | { kind: "group"; id: string; meta?: ProjectMeta; items: AgentSession[] }
    | { kind: "row"; a: AgentSession };
  const entries: SidebarEntry[] = [];
  if (!q) {
    const byId = new Map<string, AgentSession[]>();
    for (const a of filtered) {
      const key = a.projectId || "";
      const arr = byId.get(key);
      if (arr) arr.push(a);
      else byId.set(key, [a]);
    }
    const emitted = new Set<string>();
    for (const a of filtered) {
      const key = a.projectId || "";
      const items = byId.get(key)!;
      if (key && items.length >= 2) {
        if (!emitted.has(key)) {
          emitted.add(key);
          entries.push({ kind: "group", id: key, meta: projMeta.get(key), items });
        }
      } else {
        entries.push({ kind: "row", a });
      }
    }
  }
  // 方案 A(owner 2026-08-28):>30 天没动静的 agent 收进底部默认折叠的「💤 沉寂」
  // ——死 agent 不再占视野。组以「全员沉寂」为准整组下沉;忙碌的永不算沉寂。
  const entryDormant = (e: SidebarEntry) =>
    e.kind === "row" ? isDormantAgent(e.a) : e.items.every(isDormantAgent);
  const activeEntries = entries.filter((e) => !entryDormant(e));
  const dormantEntries = entries.filter(entryDormant);

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
          {/* v2.21+ 项目管理入口 */}
          <button
            className="ml-auto flex h-7 items-center justify-center rounded-lg px-1.5 text-base-content/50 transition-colors hover:bg-base-300 hover:text-base-content"
            title={t("项目管理")}
            aria-label={t("项目管理")}
            onClick={() => setShowProjects(true)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </button>
          <button
            className={`flex h-7 items-center justify-center rounded-lg px-1.5 transition-colors ${
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
            {(master.busy || master.compacting || (active === master.name && streaming)) && (
              <span className={`size-2 shrink-0 rounded-full ${master.compacting || (active === master.name && compactingLive) ? "bg-info" : "bg-warning"}`} />
            )}
          </button>
        )}
        {agents.length > 0 && filtered.length === 0 && (
          <div className="px-2 py-4 text-sm opacity-50">{t("没有匹配「")}{query.trim()}{t("」的会话")}</div>
        )}
        {/* 不用 daisyUI menu 类——它给每行自带 :hover/:active 按压高亮，iOS 上
            手指一碰就闪（滑动时「一直触发 hover 特效」，2026-07-13 真机）；
            行样式本来就是自定义的。 */}
        {q ? (
          <ul className="flex w-full list-none flex-col gap-0.5 p-0">
            {filtered.map((a) => (
              <AgentRow
                key={a.name}
                a={a}
                active={active === a.name}
                busyLive={active === a.name && streaming}
                compacting={a.compacting || (active === a.name && compactingLive)}
                pinned={pinSet.has(a.name)}
                onTogglePin={() => togglePin(a.name)}
                onSelect={onSelect}
                manage={manage}
                checked={sel.has(a.name)}
                onToggleCheck={() => toggleSel(a.name)}
              />
            ))}
          </ul>
        ) : (
          /* v2.21+ 方案 A(owner 2026-08-28):统一两级树——仅 ≥2 成员的 project
             出组头(树形缩进),单人项目合并为一行(自定义 emoji 前缀);
             >30 天沉寂的整体收进底部默认折叠的「💤 沉寂」 */
          (() => {
            const renderEntry = (e: SidebarEntry) => {
              if (e.kind === "row") {
                return (
                  <AgentRow
                    key={e.a.name}
                    a={e.a}
                    active={active === e.a.name}
                    busyLive={active === e.a.name && streaming}
                    compacting={e.a.compacting || (active === e.a.name && compactingLive)}
                    pinned={pinSet.has(e.a.name)}
                    onTogglePin={() => togglePin(e.a.name)}
                    onSelect={onSelect}
                    manage={manage}
                    checked={sel.has(e.a.name)}
                    onToggleCheck={() => toggleSel(e.a.name)}
                    projEmoji={(e.a.projectId && projMeta.get(e.a.projectId)?.emoji) || undefined}
                  />
                );
              }
              const isCollapsed = collapsedProjects.has(e.id);
              const groupBusy = e.items.some((i) => i.busy || (active === i.name && streaming));
              return (
                // v2.21.1+ 组做成「容器」(owner 2026-08-31「文件夹层级更清晰」):
                // 组块淡底色 + 开合文件夹图标 + 成员缩进导线——文件夹是个盒子,
                // 不再只是一行标签
                // v2.21.4 组头降为「分区标签」(小号、压淡、无卡片底、hover 只提亮文字):
                // 组头与 agent 行此前都是「emoji + 名字」的卡片样式,分不清哪个能点进会话
                // (owner 2026-09-06)。现在:卡片 = agent,标签 = 文件夹。
                <li key={`g:${e.id}`} className="rounded-xl bg-base-300/25 p-1">
                  <button
                    type="button"
                    className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] font-medium tracking-wide text-base-content/55 transition-colors hover:text-base-content/85"
                    onClick={() => toggleProjectCollapse(e.id)}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`shrink-0 text-base-content/40 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                    <span className="shrink-0 text-[13px] opacity-80">{e.meta?.emoji || (isCollapsed ? "📁" : "📂")}</span>
                    <span className="truncate">{e.meta?.name || e.id}</span>
                    <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/40">
                      {e.items.length}
                    </span>
                    {isCollapsed && groupBusy && (
                      <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                    )}
                  </button>
                  {!isCollapsed && (
                    <ul className="ml-[13px] mt-0.5 flex list-none flex-col gap-0.5 border-l-2 border-base-content/10 pl-1.5">
                      {e.items.map((a) => (
                        <AgentRow
                          key={a.name}
                          a={a}
                          active={active === a.name}
                          busyLive={active === a.name && streaming}
                compacting={a.compacting || (active === a.name && compactingLive)}
                          pinned={pinSet.has(a.name)}
                          onTogglePin={() => togglePin(a.name)}
                          onSelect={onSelect}
                          manage={manage}
                          checked={sel.has(a.name)}
                          onToggleCheck={() => toggleSel(a.name)}
                        />
                      ))}
                    </ul>
                  )}
                </li>
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
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={`shrink-0 transition-transform ${dormantOpen ? "" : "-rotate-90"}`}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                      <span>💤 {t("沉寂")}</span>
                      <span className="ml-auto shrink-0 text-[11px] font-normal text-base-content/35">
                        {dormantEntries.reduce((n, e) => n + (e.kind === "row" ? 1 : e.items.length), 0)}
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
      <ProjectsModal open={showProjects} onClose={() => setShowProjects(false)} />
    </aside>
  );
}
