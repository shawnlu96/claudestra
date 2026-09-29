/**
 * 最底层发键前的最后一道闸（T63 复审 P1）：Codex 窗口停在选择菜单上就不发。上游（斜杠直通、/clear、打断）查过一次画面之后，
 * 发键函数自己还会等——tmuxSendLine 敲完字等 100ms 再回车，Esc 等窗口锁、等双击节流（最长一秒多）——这段时间里弹出来的菜单，
 * 只有在真正发键的那一刻再查才挡得住。所以 tmux-helper 的 tmuxSendLine（打字前、回车前）和 Esc 护栏（所有等待之后）都调这里。
 * 只对 registry 里 runtime=codex 的窗口抓屏判定，别的窗口零开销。生命周期退出（kill / restart 清场）显式不走这道闸（window-ops）。
 * 不 import tmux-helper（它反过来 import 这里）：抓屏由调用方传入。tests/codex-menu.test.ts。
 */
import { CODEX_MENU_REFUSAL, codexMenuShown } from "./codex-menu.js";
import { readRegistryAgentsSync } from "./registry.js";

export class KeysBlockedError extends Error {
  constructor(target: string) {
    super(`${CODEX_MENU_REFUSAL}（${target}）`);
    this.name = "KeysBlockedError";
  }
}

/** tmux 窗口目标（master:=agent-x / master:agent-x / agent-x）→ registry 里的运行时；master 与认不出的返回 undefined（按 CC） */
export function runtimeOfWindow(win: string): string | undefined {
  const name = win.replace(/^[^:]*:=?/, "");
  return readRegistryAgentsSync().find((a) => a.name === name)?.runtime;
}

/** 该不该拦：拦就返回要抛的错，不拦返回 null（抓屏失败按不拦：认不出画面时照调用方原来的逻辑走） */
export async function keysBlockedAt(target: string, capture: (target: string) => Promise<string>): Promise<KeysBlockedError | null> {
  if (runtimeOfWindow(target) !== "codex") return null;
  const pane = await capture(target).catch(() => ""); // 抓不到屏：认不出画面，按不拦走，照调用方原来的逻辑
  return codexMenuShown(pane) ? new KeysBlockedError(target) : null;
}

export async function assertKeysAllowed(target: string, capture: (target: string) => Promise<string>): Promise<void> {
  const e = await keysBlockedAt(target, capture);
  if (e) throw e;
}
