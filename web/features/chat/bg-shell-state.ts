import type { BgEndStatus } from "@/lib/chat/events";
import type { BgTaskView } from "./type";

/**
 * 后台 shell 卡的状态规则（ChatStore 的 bg 收敛 + 面板显示共用；tests/web-bg-shell-state.test.ts）。
 *
 * 唯一的「已结束」证据是 bridge 读到 CC 追加的独立末行 `[exited with code N]` 后发的 bg_task_completed（status=done，
 * 最后一行就是那条退出行，src/lib/bg-shell-progress.ts）。其余情况都不是成功：
 *   - 静默多久都还在跑（重定向日志的 bun test 十几分钟不出一字）——前端不按时间收敛 shell，只显示「已 N 无输出」；
 *   - 快照里没了（bridge 重启丢了跟踪）/ 输出文件消失 / 老 bridge 的 3min idle 收尾 → 状态未知，不画绿勾；
 *   - 非 0 退出码 = 进程结束但失败。
 * subagent 不走这里，保持原来的 31min 兜底与快照缺失即完成。
 */

/** shell 卡结束后的结论：exited = 读到退出行（code 0 才是成功）；unknown = 不再被跟踪但没证据说它结束了 */
export type BgShellEnd = { kind: "exited"; code: number } | { kind: "unknown" };

const EXIT_LINE = /^\[exited with code (-?\d+)\]$/;

/** 渲染行里的最后一行恰为独立退出行 → 退出码 */
function exitCodeOfLines(lines: readonly string[]): number | null {
  const m = EXIT_LINE.exec((lines[lines.length - 1] ?? "").replace(/\r$/, ""));
  return m ? Number(m[1]) : null;
}

/** bg_task_completed 到达：只有 bridge 判 done 且末行是退出行才算「已退出」，否则（idle / 文件消失 / 老 bridge）未知 */
export function shellEndOnDone(lines: readonly string[], status: BgEndStatus | undefined): BgShellEnd {
  const code = status === "done" ? exitCodeOfLines(lines) : null;
  return code === null ? { kind: "unknown" } : { kind: "exited", code };
}

/** bg_task_completed 落到卡上：subagent 原样记 bridge 的收尾状态；shell 另按退出行定结论 */
export function markBgDone(t: BgTaskView, durationMs: number | undefined, status: BgEndStatus | undefined): void {
  t.status = "done";
  t.durationMs = durationMs;
  t.endStatus = status;
  if (t.kind === "shell") t.shellEnd = shellEndOnDone(t.lines, status);
}

const SUBAGENT_STALE_MS = 31 * 60_000; // 镜像 bridge 的 30min 无动静收尾再多给 1 分钟

/** 前端定时兜底只收敛 subagent：shell 静默不说明任何事 */
export function bgSweepable(t: BgTaskView, now: number): boolean {
  return t.status === "running" && t.kind === "subagent" && (t.lastEventAt ?? 0) < now - SUBAGENT_STALE_MS;
}

/** 活跃快照里没有这张 running 卡：subagent 照旧标完成；shell 标「状态未知」（bridge 不再跟踪 ≠ 进程结束） */
export function applySnapshotMissing(t: BgTaskView): void {
  t.status = "done";
  if (t.kind === "shell") t.shellEnd = { kind: "unknown" };
}

/** 状态未知的 shell 又来了输出 / 重新出现在开始事件里 → 说明仍被跟踪，回到运行中 */
export function reviveUnknownShell(t: BgTaskView): void {
  if (t.kind === "shell" && t.shellEnd?.kind === "unknown") {
    t.status = "running";
    t.shellEnd = undefined;
  }
}

/** shell 最后一次输出的时刻：bridge 给的 lastTs（刷新后仍准）优先，没有就用本地收到事件的时刻 */
export function shellQuietMs(t: BgTaskView, now: number): number {
  const last = t.progress?.lastTs ?? t.lastEventAt ?? t.progress?.startedTs;
  return last ? Math.max(0, now - last) : 0;
}

/** 面板文案的语义类别：success = 退出 0；failed = 非 0；unknown = 不可确认 */
export type BgShellTone = "success" | "failed" | "unknown";

export function shellTone(end: BgShellEnd | undefined): BgShellTone {
  if (end?.kind !== "exited") return "unknown";
  return end.code === 0 ? "success" : "failed";
}

/** 已结束卡里「确认成功」的：subagent 看 endStatus（原规则），shell 只有 exit 0 */
export function bgConfirmedSuccess(t: BgTaskView): boolean {
  if (t.status === "running") return false;
  if (t.kind === "shell") return shellTone(t.shellEnd) === "success";
  return t.endStatus !== "stopped" && t.endStatus !== "idle";
}
