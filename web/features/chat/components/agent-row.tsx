"use client";
import { useEffect, useRef, useState } from "react";
import { useChatStoreApi } from "../chat-store";
import type { AgentSession } from "../type";
import { ctxLevel, CTX_WINDOW } from "../ctx-level";
import { fmtAgo } from "../fmt-time";
import { useT } from "@/lib/i18n";
import { RuntimeBadge } from "./unmanaged-sessions";
import { MasterIcon } from "./master-icon";
import { swipeReg } from "./agent-row-swipe";
import { StatusDot } from "./status-dot";
import { useAgentMenuTrigger } from "./agent-menu";
import { dragAllowed, dragHandlers, useAgentDrop } from "./agent-dnd";

/* 侧栏的会话行（从 sidebar.tsx 原样搬出，D8-9）：AgentRow + 左滑动作 + 点击串台守卫。
   tapIntent 是模块级单例——所有行实例共享；swipeReg 在 agent-row-swipe.ts（AgentRow 与 Sidebar 共用同一实例）。 */

/** v2.17.2 点击串台修复(peer HedeMacBook-Pro 代码级归因,2026-08-09):
 *  列表按活动排序 + roster 指纹含易变字段 + 前台 15s 轮询 → 重排是常态;
 *  移动端 touchstart→click 有 50-300ms 派发延迟,重排落在窗口内时 click
 *  会落在滑进指位的**另一行**上,打开错的会话。修法:pointerdown(按下一刻,
 *  重排发生前)记录目标行——那才是用户的真实意图;click 时优先用它。
 *  模块级共享:重排后接住 click 的是别的行实例,必须能读到按下方记录的值。 */
let tapIntent: { name: string; ts: number; x: number; y: number } | null = null;


/** 意图有效窗口:covers 移动端最长 click 派发延迟,又不至于让陈旧意图
 *  污染下一次独立点击(键盘激活无 pointerdown,走闭包兜底)。 */
const TAP_INTENT_TTL_MS = 1_200;

/**
 * 会话列表行——点击 = 进会话。会话操作不占行内空间：左滑（置顶 / 归档 / 删除）、
 * 右键 / 长按菜单（agent-menu.tsx：重启 / 停止 / 清空 / 移动到 / 归档）、桌面拖到别的
 * project 组或 agent 行上改 project（agent-dnd.tsx）。
 */
/** 左滑露出的动作区总宽（置顶 / 归档 / 删除 三格）—— 必须与滑动上限、吸附阈值同源，
 *  否则加一个动作就会把最左边那个按钮挤出可视区（2026-09-14 owner 实报「置顶按钮
 *  怎么搞没了」：容器加宽到 240 而滑动上限还是 160）。 */
const ACTIONS_W = 240;

export function AgentRow({
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
  const [archiving, setArchiving] = useState(false);
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
  // 右键 / 长按菜单 + 桌面拖拽改 project（owner 2026-09-23）。master / mock / 多选模式无菜单不可拖；
  // 本行也是放置目标 = 它所属的 project（单人 project 没有组头，拖到它的 agent 上就是进那个 project）。
  const menu = useAgentMenuTrigger(() => a, canRemove && !manage);
  const drop = useAgentDrop({ projectId: a.projectId, agentName: a.name });
  const drag = canRemove && !manage && dragAllowed() ? dragHandlers({ name: a.name, projectId: a.projectId ?? null }) : {};

  /** 点行的实际动作。触摸丢 click 的兜底在列表容器上统一做(lib/tap-rescue.ts 派发合成 click),行不用管。 */
  const activate = (intended: string) => {
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
  };

  return (
    <li>
      <div className={`relative overflow-hidden rounded-lg ${drop.over ? "ring-2 ring-primary/50" : ""}`} {...drop.handlers}>
        {/* 左滑露出的操作钮(在滑动层下面):置顶 + 删除 */}
        {(swipeX < 0 || dragging) && (
          <div className="absolute inset-y-0 right-0 z-0 flex" style={{ width: ACTIONS_W }}>
            <button
              className="flex flex-1 items-center justify-center bg-base-content/70 text-[13px] font-medium text-base-100"
              onClick={() => {
                onTogglePin();
                closeSwipe();
              }}
            >
              {pinned ? t("取消置顶") : t("置顶")}
            </button>
            {/* v2.23+ 归档：只给当前会话做快照（非破坏性），不动 agent 本身 ——
                owner 2026-09-14「给工作列表的也加入一个左滑归档按钮」 */}
            <button
              className="flex flex-1 items-center justify-center bg-base-300/80 text-[13px] font-medium text-base-content/80"
              onClick={async () => {
                if (archiving) return;
                setArchiving(true);
                const r = await store.archiveAgent(a.name);
                setArchiving(false);
                closeSwipe();
                if (!r.ok) alert(`${t("归档失败:")}${t(r.error || "操作失败")}`);
              }}
            >
              {archiving ? "…" : t("归档")}
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
          // touch-callout 关掉：长按出我们的菜单，不出 iOS 的「拷贝 / 查询」气泡（bubble-menu 同款代价）
          style={{ transition: dragging ? "none" : "transform 0.18s ease", WebkitTouchCallout: "none" }}
          {...drag}
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
                  t.lastX = Math.max(-ACTIONS_W, Math.min(0, t.startX + dx));
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
                  const snap = t.lastX < -ACTIONS_W * 0.375 ? -ACTIONS_W : 0;
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
          className="relative flex min-w-0 flex-1 select-none items-center gap-2.5 text-left sm:gap-2"
          {...menu.handlers}
          onPointerDown={(e) => {
            tapIntent = { name: a.name, ts: Date.now(), x: e.clientX, y: e.clientY };
          }}
          onClick={() => {
            // 串台守卫:按下一刻的目标优先于闭包值(见文件头 tapIntent 注释)
            const intended =
              tapIntent && Date.now() - tapIntent.ts < TAP_INTENT_TTL_MS ? tapIntent.name : a.name;
            tapIntent = null;
            // 长按松手的 click 只是菜单的尾巴,不进会话
            if (menu.consumedClick()) return;
            activate(intended);
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
          {/* v2.23+ 运行时徽章：列表里看不出哪些是 Pi 会话，而两者的模型/工具/
              行为都不同（owner 2026-09-14「第一个 pi 加入标识」）。
              ① 位置在**名字前面**（owner 2026-09-14 再反馈「位置放在前面啊」）；
              ② 必须在下面那个 `truncate` 容器**外面**且 shrink-0 —— 放里面时名字
                 一长（agent-claudestraworker）就被省略号整块吃掉，看着像"没渲染"。 */}
          <RuntimeBadge runtime={a.runtime ?? ""} className="shrink-0 align-middle" />
          <span className={`min-w-0 flex-1 truncate text-[15px] sm:text-sm ${a.unread ? "font-semibold" : ""}`}>
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
          {/* 未读数(2026-09-16):服务端计数,任一设备打开该会话即清。放在时间/状态之前,
              名字同时加粗——一眼能扫出「谁回了我还没看」 */}
          {!!a.unread && (
            <span className="ml-1 inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold leading-none text-white">
              {a.unread > 99 ? "99+" : a.unread}
            </span>
          )}
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
