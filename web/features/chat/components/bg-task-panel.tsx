"use client";
import { memo, useEffect, useRef, useState } from "react";
import { useChatStore, useChatStoreApi } from "../chat-store";
import type { BgTaskView } from "../type";
import { fmtClock } from "../fmt-clock";
import { useNow } from "../use-now";
import { useT, getLang } from "@/lib/i18n";
import { bgConfirmedSuccess, shellQuietMs, shellTone, shellUnknown, type BgShellUnknown } from "../bg-shell-state";

/**
 * 后台任务（subagent / bg shell）列表 —— Discord 子区在 web 的对应物，挂在顶栏按钮的弹层里（bg-task-button.tsx）。
 * 任务收在一个框里、每个一行：running 时转圈、done 时 ✓+时长；点开看流式进度行。
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

const QUIET_MS = 3 * 60_000; // subagent 超过这么久没写记录 → 标「静默」（仍在跑，只是在等命令/CI）
const SHELL_QUIET_MS = 60_000; // 后台 shell 超过这么久没输出 → 标「N 无输出 · 可能仍在运行」（静默不等于结束，bg-shell-state.ts）

/** 本面板 shell 专用的几句文案（i18n-dict.ts 已到行数上限，沿用本文件「行数」那种就地中英分支） */
const zhEn = (zh: string, en: string) => (getLang() === "en" ? en : zh);

/** 「无输出 N」常显（与 subagent 的「静默 N」同宽量级）；「可能仍在运行」窄屏收进 title，免得 390 宽把标题和停止键挤掉 */
function ShellQuiet({ d }: { d: string }) {
  const tail = zhEn(" · 可能仍在运行", " · may still be running");
  return (
    <span className="font-sans opacity-70" title={zhEn(`${d} 无输出`, `no output for ${d}`) + tail}>
      {zhEn(`无输出 ${d}`, `no output ${d}`)}
      <span className="hidden sm:inline">{tail}</span>
    </span>
  );
}

/** 「状态未知」：不转圈（不假装在看着它跑）、也不画完成；「可能仍在运行」同 ShellQuiet 窄屏收进 title */
function ShellUnknown({ why }: { why: BgShellUnknown }) {
  useT(); // 订阅语言切换
  const hint =
    why === "unreadable"
      ? zhEn("输出文件暂时读不到（权限 / IO），无法确认进度；恢复可读后继续跟踪", "Output file can't be read right now (permission / IO); will resume tracking once readable")
      : zhEn("已不在跟踪（bridge 重启 / 输出文件已消失），无法确认是否已结束", "No longer tracked (bridge restarted / output file gone); can't confirm it ended");
  const tail = zhEn(" · 可能仍在运行", " · may still be running");
  return (
    <span className="ml-1 shrink-0 opacity-60" title={hint + tail}>
      ? {zhEn("状态未知", "status unknown")}
      <span className="hidden sm:inline">{tail}</span>
    </span>
  );
}

/** shell 卡结束后的状态：只有读到退出行才进已结束组；0 才画绿勾，非 0 标失败（不可确认的留在运行组，见 ShellUnknown） */
function ShellEnd({ t }: { t: BgTaskView }) {
  useT(); // 订阅语言切换
  const tone = shellTone(t.shellEnd);
  const code = t.shellEnd?.kind === "exited" ? t.shellEnd.code : null;
  if (tone === "success") return <span className="ml-1 shrink-0 text-success">✓ exit 0 {fmtDuration(t.durationMs)}</span>;
  if (tone === "failed") return <span className="ml-1 shrink-0 text-error">✗ exit {code} {fmtDuration(t.durationMs)}</span>;
  return <ShellUnknown why="untracked" />;
}

/** 卡片右侧的状态：运行中 = 转圈 + 耗时 + 上下文 + 静默提示；结束 = 真实收尾状态 + 时长。
 *  每秒走的时钟只放在这里——放到面板上会让每张卡（连同最多 500 行的进度视口）每秒重渲染一遍 */
function BgStatus({ t }: { t: BgTaskView }) {
  const tr = useT();
  const p = t.progress;
  const shell = t.kind === "shell";
  const unknown = shellUnknown(t);
  const now = useNow(t.status === "running" && !unknown && (p?.startedTs || shell) ? 1000 : 0);
  if (t.status !== "running" && shell) return <ShellEnd t={t} />;
  if (unknown) return <ShellUnknown why={unknown} />;
  if (t.status !== "running") {
    if (t.endStatus === "stopped") return <span className="ml-1 shrink-0 opacity-50">⏹ {tr("已停止")} {fmtDuration(t.durationMs)}</span>;
    if (t.endStatus === "idle") return <span className="ml-1 shrink-0 opacity-50">⏸ {tr("无动静结束")} {fmtDuration(t.durationMs)}</span>;
    return <span className="ml-1 shrink-0 text-success">✓ {fmtDuration(t.durationMs)}</span>;
  }
  const quietMs = shell ? 0 : p?.lastTs ? now - p.lastTs : 0;
  const shellQuiet = shell ? shellQuietMs(t, now) : 0;
  return (
    <span className="ml-1 flex shrink-0 items-center gap-1.5 font-mono tabular-nums text-warning-soft-80">
      <span className="loading loading-spinner loading-xs text-warning" />
      {!!p?.startedTs && <span>{fmtClock(now - p.startedTs)}</span>}
      {!!p?.ctxTokens && <span className="opacity-60">{Math.round(p.ctxTokens / 1000)}k</span>}
      {quietMs > QUIET_MS && <span className="font-sans opacity-70">{tr("静默")} {fmtClock(quietMs).replace(/ \d+s$/, "")}</span>}
      {shellQuiet >= SHELL_QUIET_MS && <ShellQuiet d={fmtClock(shellQuiet).replace(/ \d+s$/, "")} />}
    </span>
  );
}

/** subagent 行去掉 Discord 的 `-# ` 小字前缀；shell 行原样。 */
function cleanLine(s: string): string {
  return s.replace(/^-#\s+/, "");
}

// memo：bg-update 事件只替换被更新任务的对象引用（immer），其余卡不重渲染
const BgTaskCard = memo(function BgTaskCard({ t }: { t: BgTaskView }) {
  const tr = useT(); // 译名用 tr——prop t 是任务对象
  const running = t.status === "running";
  const store = useChatStoreApi();
  return (
    // 一任务一行、默认收起（同 CC 底栏的任务列表）：一次起好几个 subagent 时，展开的流式输出会把输入框上方占满
    <details className="group [&>summary]:list-none">
      <summary className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5 text-xs">
        <KindIcon kind={t.kind} />
        <span className="min-w-0 flex-1 truncate font-medium text-warning-soft-90">
          {/* bridge 给的 title 带 🐚/🧵/🤖 emoji 前缀(Discord 线程名用)——web 已有线性 kind 图标,剥掉免重复 */}
          {(t.title || (t.kind === "shell" ? tr("后台命令") : "subagent")).replace(/^[🐚🧵🤖]\s*/u, "")}
        </span>
        <BgStatus t={t} />
        {(!t.progress || t.kind === "shell") && t.lines.length > 0 && (
          <span className="ml-auto shrink-0 opacity-40">{getLang() === "en" ? `${t.lines.length} line${t.lines.length > 1 ? "s" : ""}` : `${t.lines.length} 行`}</span>
        )}
        {/* 停止 = 请 agent 用 TaskStop(bridge 无 kill 权柄);✕ = 收起卡片(纯前端)。
            preventDefault 防触发 details 开合 */}
        {running && (
          <button
            className="grid size-5 shrink-0 place-items-center rounded text-error-soft-70 hover:bg-error/10"
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
        {t.agentType && <div className="pb-1 text-[11px] opacity-50">{[t.agentType, t.model].filter(Boolean).join(" · ")}</div>}
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

function TaskRows({ tasks }: { tasks: BgTaskView[] }) {
  return (
    <div className="divide-y divide-warning/15 overflow-hidden rounded-lg border border-warning/25 bg-warning/[0.06]">
      {tasks.map((t) => <BgTaskCard key={t.id} t={t} />)}
    </div>
  );
}

export function BgTaskList() {
  const tr = useT(); // 同上,map 回调里 t 是任务变量
  const tasks = useChatStore((s) => s.state.bgTasks);
  // 已完成的默认折叠成一行 —— 一次起 5 个 subagent 很常见，完成信息的价值随时间
  // 快速衰减，内容在聊天流里也留着。展开后仍是原来的完整卡片，不丢任何东西。
  const [showDone, setShowDone] = useState(false);
  if (!tasks.length) return null;
  const running = tasks.filter((t) => t.status === "running");
  const done = tasks.filter((t) => t.status !== "running");
  // 已结束组的 shell 都读到了退出行（状态未知的留在运行组，bg-shell-state.ts）；
  // 折叠行的绿勾只代表确认成功：有 shell 非 0 退出时换成中性的「已结束」（subagent 维持原显示）
  const allOk = done.every((t) => t.kind !== "shell" || bgConfirmedSuccess(t));
  return (
    <div className="flex flex-col gap-1.5">
      {running.length > 0 && <TaskRows tasks={running} />}
      {done.length > 0 &&
        (showDone ? (
          <>
            <button
              className="self-start text-[11px] text-base-content/35 hover:text-base-content/60"
              onClick={() => setShowDone(false)}
            >
              {allOk ? tr("收起已完成") : zhEn("收起已结束", "Collapse ended")}
            </button>
            <TaskRows tasks={done} />
          </>
        ) : (
          <button
            className="flex items-center gap-1.5 self-start rounded px-1 py-0.5 text-[11.5px] text-base-content/35 hover:bg-base-content/5 hover:text-base-content/60"
            onClick={() => setShowDone(true)}
            title={tr("展开已完成的后台任务")}
          >
            <span className={allOk ? "text-success-soft-70" : "opacity-60"}>{allOk ? "✓" : "•"}</span>
            <span>
              {allOk ? tr("{n} 个已完成", { n: done.length }) : zhEn(`${done.length} 个已结束`, `${done.length} ended`)}
            </span>
            <span className="opacity-50">›</span>
          </button>
        ))}
    </div>
  );
}
