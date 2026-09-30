/**
 * launcher 对大总管窗口弹窗的处理：能自动过的启动期 / 普通确认框代按；切模型 / effort 确认框不按
 * （看不出是谁引出的），由 bridge 的 permission-watcher 通知 owner。单测 tests/master-modal.test.ts。
 */
import { realpathSync } from "node:fs";
import { isAutoConfirmableModal } from "./modal-confirm.js";
import { acceptTrustPrompt, AGENT_PREFIX, detectSessionIdlePrompt, tmuxRaw, trustPromptMoves } from "./tmux-helper.js";

const realpathOr = (p: string): string => {
  try { return realpathSync(p); } catch { return p; } // 目录不存在就按原串比：比不上 = 不认，只会少发、不会错发
};

/**
 * 这个窗口是不是大总管正身：窗口名不是 agent-*，且 pane 当前目录就是 MASTER_DIR（launcher ensureMasterAtZero 同一判据）。
 * window 0 被 agent 抢占真实发生过，那时朝 master:0 发键 / 报框都会落到别人身上。
 */
export function isMasterWindowMeta(name: string, cwd: string, masterDir: string): boolean {
  return !!name && !!cwd && !name.startsWith(AGENT_PREFIX) && realpathOr(cwd) === realpathOr(masterDir);
}

/** 核对不上时回给调用方的话：这次一个键都没发 */
export const MASTER_WINDOW_MISMATCH = "window 0 此刻不是大总管（launcher 会归位），这次没有发任何键，稍后再试";

/**
 * 只读核对 target 窗口的身份；tmux 问不到也算不是（身份不确定就不发键、不报）。名字和目录分两次取：
 * C locale 下 tmux 会把格式串里的 tab 输出成「_」，拼在一起取就恒判「不是」
 */
export async function isMasterWindow(target: string, masterDir: string): Promise<boolean> {
  const get = (fmt: string) => tmuxRaw(["display-message", "-p", "-t", target, fmt]).then((s) => s.trim()).catch((e) => {
    console.error(`大总管窗口身份核对失败（${target} ${fmt}）:`, e);
    return "";
  });
  return isMasterWindowMeta(await get("#{window_name}"), await get("#{pane_current_path}"), masterDir);
}

/**
 * Master 专用：用 isAutoConfirmableModal 做几何识别 + 允许 session-idle 自动按。
 * agent 的 session-idle 由 manager.ts 的就绪轮询自动选「完整恢复」。
 */
export function masterShouldAutoConfirm(pane: string): boolean {
  // v2.21.4+ 目录信任弹窗也算(默认高亮 No, exit,confirmMasterModal 会先挪到 Yes)
  return trustPromptMoves(pane) !== null || isAutoConfirmableModal(pane, { allowSessionIdle: true });
}

/**
 * v2.0.22+: 自动确认 master 的弹窗。session-idle 弹窗特判 —— Enter 会选中高亮的
 * option 1 = 从摘要恢复 = compact 丢上下文，所以改 arrow nav 选 option 2「完整
 * 恢复」（Down 再 Enter）。普通确认弹窗仍直接 Enter。
 */
export async function confirmMasterModal(window: string, pane: string): Promise<void> {
  const trustMoves = trustPromptMoves(pane);
  if (trustMoves !== null) {
    await acceptTrustPrompt(window, trustMoves);
    return;
  }
  if (detectSessionIdlePrompt(pane)) {
    await tmuxRaw(["send-keys", "-t", window, "Down"]);
    await Bun.sleep(150);
    await tmuxRaw(["send-keys", "-t", window, "Enter"]);
  } else {
    await tmuxRaw(["send-keys", "-t", window, "Enter"]);
  }
}
