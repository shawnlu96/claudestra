/**
 * launcher 对大总管窗口弹窗的处理：能自动过的启动期 / 普通确认框代按，切模型 / effort 确认框只提醒 owner。
 * 单测 tests/master-modal.test.ts。
 */
import { isAutoConfirmableModal, looksLikeSwitchConfirm } from "./modal-confirm.js";
import { screenFingerprint } from "./send-key-guard.js";
import { acceptTrustPrompt, detectSessionIdlePrompt, detectSwitchConfirmPrompt, tmuxRaw, trustPromptMoves } from "./tmux-helper.js";

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

/**
 * 大总管停在切模型 / effort 确认框上：launcher 不是注入方，看不出框是谁引出的（CC 会主动弹同款框提议降级），不按，只提醒。
 * 同一张框（screenFingerprint）连续两轮都在才发、只发一次——网页设置切 master 时 runSwitchCommand 几秒内就会按掉自己那张，别误报。
 */
export function createSwitchBoxNotifier(send: (text: string) => Promise<unknown>): (pane: string) => Promise<void> {
  let seen: string | null = null;
  let sent: string | null = null;
  return async (pane) => {
    if (!looksLikeSwitchConfirm(pane)) { seen = sent = null; return; }
    const fp = screenFingerprint(pane);
    const first = seen !== fp;
    seen = fp;
    if (first || sent === fp) return;
    sent = fp;
    const target = detectSwitchConfirmPrompt(pane)?.target;
    await send(`⚠️ 大总管停在切模型 / effort 确认框上${target ? `（切到 ${target}）` : ""}，没有自动确认——请到终端或网页终端里自己按`);
  };
}
