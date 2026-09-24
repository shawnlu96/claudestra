"use client";
import { memo, useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { BgTaskView } from "../type";
import { useT, getLang } from "@/lib/i18n";

/**
 * 后台任务（subagent / bg shell）跟踪面板 —— Discord 子区在 web 的对应物。
 * 每个任务一张可折叠卡：running 时转圈、done 时 ✓+时长；展开看流式进度行。
 * subagent 行带 markdown 前缀（-# 🔧 / 💬），shell 行是原始输出。
 */

/** 线性图标统一替代 emoji(owner 2026-07-15:⏹ 在 iOS 渲染成蓝色 emoji
 *  方块,「丑死了」)——subagent 用 git-branch(分支任务),shell 用 terminal。 */
function KindIcon({ kind }: { kind: BgTaskView["kind"] }) {
  const common = {
    className: "size-3.5 shrink-0 opacity-70",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (kind === "shell") {
    return (
      <svg {...common}>
        <path d="M4 17l6-6-6-6" />
        <path d="M12 19h8" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v3a3 3 0 0 0 3 3h6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6 6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}

function fmtDuration(ms?: number): string {
  if (!ms || ms < 0) return "";
  const m = ms / 60_000;
  if (m >= 1) return `${m.toFixed(1)}min`;
  return `${Math.round(ms / 1000)}s`;
}

/** 运行中耗时：27m 47s / 1h 3m / 45s（与 CC 底栏同一种读法） */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

/** 每 ms 毫秒刷新一次的「现在」；ms=0 不起定时器（没有在跑的 subagent 时不白白重渲染） */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const QUIET_MS = 3 * 60_000; // subagent 超过这么久没写记录 → 标「静默」（仍在跑，只是在等命令/CI）

/** 卡片右侧的状态：运行中 = 转圈 + 耗时 + 上下文 + 静默提示；结束 = 真实收尾状态 + 时长 */
function BgStatus({ t, now }: { t: BgTaskView; now: number }) {
  const tr = useT();
  const p = t.progress;
  if (t.status !== "running") {
    if (t.endStatus === "stopped") return <span className="ml-1 shrink-0 opacity-50">⏹ {tr("已停止")} {fmtDuration(t.durationMs)}</span>;
    if (t.endStatus === "idle") return <span className="ml-1 shrink-0 opacity-50">⏸ {tr("无动静结束")} {fmtDuration(t.durationMs)}</span>;
    return <span className="ml-1 shrink-0 text-success">✓ {fmtDuration(t.durationMs)}</span>;
  }
  const quietMs = p?.lastTs ? now - p.lastTs : 0;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 font-mono tabular-nums text-warning/80">
      <span className="loading loading-spinner loading-xs text-warning" />
      {!!p?.startedTs && now > 0 && <span>{fmtClock(now - p.startedTs)}</span>}
      {!!p?.ctxTokens && <span className="opacity-60">{Math.round(p.ctxTokens / 1000)}k</span>}
      {quietMs > QUIET_MS && <span className="font-sans opacity-70">{tr("静默")} {fmtClock(quietMs).replace(/ \d+s$/, "")}</span>}
    </span>
  );
}

/** subagent 行去掉 Discord 的 `-# ` 小字前缀；shell 行原样。 */
function cleanLine(s: string): string {
  return s.replace(/^-#\s+/, "");
}

// memo：bg-update 事件只替换被更新任务的对象引用（immer），其余卡不重渲染
const BgTaskCard = memo(function BgTaskCard({ t, now }: { t: BgTaskView; now: number }) {
  const tr = useT(); // 译名用 tr——prop t 是任务对象
  const running = t.status === "running";
  const store = useChatStoreApi();
  return (
    <details className="group rounded-lg border border-warning/25 bg-warning/[0.06] [&>summary]:list-none" open={running}>
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-xs">
        <KindIcon kind={t.kind} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-warning/90">
            {/* bridge 给的 title 带 🐚/🧵/🤖 emoji 前缀(Discord 线程名用)——web 已有线性 kind 图标,剥掉免重复 */}
            {(t.title || (t.kind === "shell" ? tr("后台命令") : "subagent")).replace(/^[🐚🧵🤖]\s*/u, "")}
          </span>
          {/* 类型 · 模型 · 最近一步在做什么（CC 底栏那句摘要只在它内存里，拿不到；最近一次工具调用是最接近的替身） */}
          {(t.agentType || (running && t.lines.length > 0)) && (
            <span className="truncate text-[11px] opacity-50">
              {[t.agentType, t.model].filter(Boolean).join(" · ")}
              {t.agentType && running && t.lines.length > 0 ? " · " : ""}
              {running && t.lines.length > 0 ? cleanLine(t.lines[t.lines.length - 1]!) : ""}
            </span>
          )}
        </span>
        <BgStatus t={t} now={now} />
        {!t.progress && t.lines.length > 0 && (
          <span className="ml-auto shrink-0 opacity-40">{getLang() === "en" ? `${t.lines.length} line${t.lines.length > 1 ? "s" : ""}` : `${t.lines.length} 行`}</span>
        )}
        {/* 停止 = 请 agent 用 TaskStop(bridge 无 kill 权柄);✕ = 收起卡片(纯前端)。
            preventDefault 防触发 details 开合 */}
        {running && (
          <button
            className="grid size-5 shrink-0 place-items-center rounded text-error/70 hover:bg-error/10"
            title={tr("请求 agent 停止此任务")}
            aria-label={tr("停止任务")}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              store.requestStopBgTask(t);
            }}
          >
            <StopIcon />
          </button>
        )}
        <button
          className="grid size-5 shrink-0 place-items-center rounded opacity-40 hover:bg-base-content/10 hover:opacity-80"
          title={tr("收起")}
          aria-label={tr("收起任务卡")}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            store.dismissBgTask(t.id);
          }}
        >
          <XIcon />
        </button>
        <span className="shrink-0 opacity-30 transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-3 pb-2 pt-0.5">
        {t.lines.length === 0 ? (
          <div className="py-1 text-[11px] opacity-40">{tr("等待输出…")}</div>
        ) : (
          <BgLines lines={t.lines} />
        )}
      </div>
    </details>
  );
});

/**
 * 进度行视口：固定高度内滚动（不撑开页面），新行吸底跟随（像 tail -f）,
 * 用户上翻离底 >30px 就不打扰、回底恢复。overscroll-contain 防滚动链
 * 穿透到消息列表（iOS 嵌套滚动）。
 */
function BgLines({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
      className="max-h-48 touch-pan-y overflow-y-auto overscroll-contain whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-base-content/60"
      style={{ WebkitOverflowScrolling: "touch" }}
    >
      {lines.map(cleanLine).join("\n")}
    </pre>
  );
}

export function BgTaskPanel() {
  const tr = useT(); // 同上,map 回调里 t 是任务变量
  const tasks = useChatStore((s) => s.state.bgTasks);
  // 已完成的默认折叠成一行 —— 跑得多了（一次起 5 个 subagent 很常见）它们会把
  // 输入框上方占满，而完成信息的价值随时间快速衰减，内容在聊天流里也留着。
  // 展开后仍是原来的完整卡片，不丢任何东西。
  const [showDone, setShowDone] = useState(false);
  const now = useNow(tasks.some((t) => t.status === "running" && t.progress?.startedTs) ? 1000 : 0);
  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.status === "running");
  const done = tasks.filter((t) => t.status !== "running");
  return (
    <div className="mb-[22px] flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-base-content/35">
        <span>{tr("后台任务")}</span>
        <span className="opacity-60">{tasks.length}</span>
      </div>
      {running.map((t) => (
        <BgTaskCard key={t.id} t={t} now={now} />
      ))}
      {done.length > 0 &&
        (showDone ? (
          <>
            <button
              className="self-start text-[11px] text-base-content/35 hover:text-base-content/60"
              onClick={() => setShowDone(false)}
            >
              {tr("收起已完成")}
            </button>
            {done.map((t) => (
              <BgTaskCard key={t.id} t={t} now={0} />
            ))}
          </>
        ) : (
          <button
            className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-[11.5px] text-base-content/35 hover:bg-base-content/5 hover:text-base-content/60"
            onClick={() => setShowDone(true)}
            title={tr("展开已完成的后台任务")}
          >
            <span className="text-success/70">✓</span>
            <span>
              {done.length} {tr("个已完成")}
            </span>
            <span className="opacity-50">›</span>
          </button>
        ))}
    </div>
  );
}
