import type { WindowOps } from "./types.js";

/**
 * The one ready-marker reset of the tmux runtimes (Pi, Codex, Codex over ACP). The marker is a window option that the
 * session's channel client sets to "1"; a reused window still carries the previous session's "1". If the reset did not
 * really happen, waitReady would confirm the new launch from that stale value, so a failed reset aborts the launch here
 * instead of printing a warning. It must run before the launch command is sent: a later reset would wipe the real "1".
 * tests/tmux-audit-target-ready.test.ts.
 */
export async function resetReadyOption(win: WindowOps, option: string): Promise<void> {
  if (await win.setOption(option, "0")) return;
  throw new Error(`清不掉 ${win.name} 的 ${option}：残留的就绪标记会被当成这次启动成功，中止本次启动`);
}
