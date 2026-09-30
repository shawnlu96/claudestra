/** 自动迁移只能退出明确空闲的旧 TUI；绝不 Esc、C-c、强杀或清掉用户输入。 */
import { isAtShell } from "../tmux-helper.js";
import { codexBusy, codexOverlayOpen } from "./codex-exit.js";
import { BLOCKING_DIALOG_RE, DIALOG_SHAPE_RE, nonEmptyTail } from "./codex-ready.js";
import type { WindowOps } from "./types.js";

function codexIdlePrompt(pane: string): boolean {
  const lines = nonEmptyTail(pane, 8), tail = lines.join("\n");
  const at = lines.findLastIndex((l) => /^\s*[›❯]/.test(l));
  return !codexBusy(pane) && !codexOverlayOpen(pane) && !BLOCKING_DIALOG_RE.test(tail)
    && !DIALOG_SHAPE_RE.test(tail) && at >= 0 && /^\s*[›❯]\s*$/.test(lines[at]!)
    && lines.slice(at + 1).every((l) => /^\s*\d+% context left(?:\s*[·•]\s*\? for shortcuts)?\s*$/.test(l));
}

export async function exitIdleCodex(win: WindowOps): Promise<boolean> {
  const first = await win.capture(40);
  if (isAtShell(nonEmptyTail(first, 3).join("\n"))) return (await win.childPids()).length === 0;
  if (!codexIdlePrompt(first)) return false;
  await win.sleep(500);
  if (!codexIdlePrompt(await win.capture(40))) return false;
  await win.sendLiteral("/quit");
  await win.sendKey("Enter");
  for (let i = 0; i < 20; i++) {
    await win.sleep(500);
    if ((await win.childPids()).length === 0 && isAtShell(nonEmptyTail(await win.capture(10), 3).join("\n"))) return true;
  }
  return false; // 不肯退出就保留待迁移状态；自动迁移没有打断/强杀兜底。
}
