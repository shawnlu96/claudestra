import type { BgEndStatus } from "@/lib/chat/events";
import type { BgTaskView } from "./type";

/**
 * 后台 shell 卡的状态规则（ChatStore 的 bg 收敛 + 面板显示共用；tests/web-bg-shell-state.test.ts）。
 *
 * 唯一的「已结束」证据是 bridge 读到 CC 追加的独立末行 `[exited with code N]` 后发的 bg_task_completed（status=done，
 * 最后一行就是那条退出行，src/lib/bg-shell-progress.ts）；被结束的任务末行是独立的 `[killed]`（status=stopped）→ 已停止，
 * 不算成功也不算失败。其余情况都不是成功：
 *   - 静默多久都还在跑（重定向日志的 bun test 十几分钟不出一字）——前端不按时间收敛 shell，只显示「已 N 无输出」；
 *   - 快照里没了（bridge 重启丢了跟踪）/ 输出文件消失 / 老 bridge 的 3min idle 收尾 / 输出读不到 → 状态未知：
 *     卡留在运行组（顶栏计数、折叠行、停止按钮都不当它完成），只是不转圈、显示「状态未知 · 可能仍在运行」；
 *   - 刷新 / 新连接：bridge 快照带近期收尾 shell 的 end（bg-activity-watcher.ts endedShells），replay 成 bg-done 还原结局；
 *   - 非 0 退出码 = 进程结束但失败。
 * subagent 不走这里，保持原来的 31min 兜底与快照缺失即完成。
 */

/** shell 卡的结局：读到退出行（code 0 才是成功）或 [killed]（已停止）才算结束。没有「unknown 结局」——不可确认的卡仍留在运行组（见 shellUnknown） */
export type BgShellEnd = { kind: "exited"; code: number } | { kind: "stopped" };

/** 为什么不可确认：untracked = bridge 不再跟踪（快照缺失 / 输出文件消失 / 老 bridge 的 idle 收尾）；
 *  unreadable = 仍在跟踪但输出文件读不到（权限 / IO，bridge 继续重试，读通即恢复） */
export type BgShellUnknown = "untracked" | "unreadable";

const EXIT_LINE = /^\[exited with code (-?\d+)\]$/;
const KILLED_LINE = "[killed]";

const lastLine = (lines: readonly string[]) => (lines[lines.length - 1] ?? "").replace(/\r$/, "");

/** 渲染行里的最后一行恰为独立退出行 → 退出码 */
function exitCodeOfLines(lines: readonly string[]): number | null {
  const m = EXIT_LINE.exec(lastLine(lines));
  return m ? Number(m[1]) : null;
}

/** bg_task_completed 到达：只有 bridge 判 done 且末行是退出行才算「已退出」，否则（idle / 文件消失 / 老 bridge）null */
export function shellExitOnDone(lines: readonly string[], status: BgEndStatus | undefined): number | null {
  return status === "done" ? exitCodeOfLines(lines) : null;
}

/** 已确认结局（退出 / 被结束）的 shell：结局定了，replay / 重连再来的 start / update 不能把它拉回运行中（也不重复堆行） */
export function shellExited(t: BgTaskView): boolean {
  return t.kind === "shell" && t.shellEnd !== undefined;
}

/** bg_task_completed 到达时的 shell 结局：done + 末行退出行 → 已退出；stopped + 末行 [killed] → 已停止；其余 null */
function shellEndOnDone(lines: readonly string[], status: BgEndStatus | undefined): BgShellEnd | null {
  const code = shellExitOnDone(lines, status);
  if (code !== null) return { kind: "exited", code };
  return status === "stopped" && lastLine(lines) === KILLED_LINE ? { kind: "stopped" } : null;
}

/** bg_task_completed 落到卡上：subagent 原样记 bridge 的收尾状态；shell 只有读到退出行 / [killed] 才进「已结束」，
 *  否则留在运行组标「状态未知」——计数 / 折叠行 / 顶栏 / 停止按钮都不会把它当完成 */
export function markBgDone(t: BgTaskView, durationMs: number | undefined, status: BgEndStatus | undefined): void {
  t.durationMs = durationMs;
  t.endStatus = status;
  if (t.kind !== "shell") {
    t.status = "done";
    return;
  }
  const end = shellEndOnDone(t.lines, status);
  if (!end) {
    t.shellUntracked = true;
    return;
  }
  t.status = "done";
  t.shellEnd = end;
  t.shellUntracked = undefined;
}

const SUBAGENT_STALE_MS = 31 * 60_000; // 镜像 bridge 的 30min 无动静收尾再多给 1 分钟

/** 前端定时兜底只收敛 subagent：shell 静默不说明任何事 */
export function bgSweepable(t: BgTaskView, now: number): boolean {
  return t.status === "running" && t.kind === "subagent" && (t.lastEventAt ?? 0) < now - SUBAGENT_STALE_MS;
}

/** 活跃快照里没有这张 running 卡：subagent 照旧标完成；shell 仍算运行组、标「状态未知」（bridge 不再跟踪 ≠ 进程结束） */
export function applySnapshotMissing(t: BgTaskView): void {
  if (t.kind === "shell") t.shellUntracked = true;
  else t.status = "done";
}

/** 不再跟踪的 shell 又来了输出 / 重新出现在开始事件里 → 说明仍被跟踪，清掉「不再跟踪」 */
export function reviveUnknownShell(t: BgTaskView): void {
  if (t.kind === "shell") t.shellUntracked = undefined;
}

/** 运行组里的 shell 现在能不能确认状态：不能 → 原因（面板显示「状态未知」而不是转圈） */
export function shellUnknown(t: BgTaskView): BgShellUnknown | null {
  if (t.kind !== "shell" || t.status !== "running") return null;
  if (t.shellUntracked) return "untracked";
  return t.progress?.unreadable ? "unreadable" : null;
}

/** shell 最后一次输出的时刻：bridge 给的 lastTs（刷新后仍准）优先，没有就用本地收到事件的时刻 */
export function shellQuietMs(t: BgTaskView, now: number): number {
  const last = t.progress?.lastTs ?? t.lastEventAt ?? t.progress?.startedTs;
  return last ? Math.max(0, now - last) : 0;
}

/** 面板文案的语义类别：success = 退出 0；failed = 非 0；stopped = 被结束；unknown = 不可确认（正常不会出现在已结束组，防御用） */
export type BgShellTone = "success" | "failed" | "stopped" | "unknown";

export function shellTone(end: BgShellEnd | undefined): BgShellTone {
  if (end?.kind === "stopped") return "stopped";
  if (end?.kind !== "exited") return "unknown";
  return end.code === 0 ? "success" : "failed";
}

/** 已结束卡里「确认成功」的：subagent 看 endStatus（原规则），shell 只有 exit 0 */
export function bgConfirmedSuccess(t: BgTaskView): boolean {
  if (t.status === "running") return false;
  if (t.kind === "shell") return shellTone(t.shellEnd) === "success";
  return t.endStatus !== "stopped" && t.endStatus !== "idle";
}
