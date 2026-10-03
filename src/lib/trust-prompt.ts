/**
 * Claude Code 目录信任弹窗。CC 2.1.259 起在家目录、出借 worker 每个新 clone 目录启动都会先问（--dangerously-skip-permissions 不跳过）:
 *   Quick safety check: Is this a project you created or one you trust? …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 * 默认高亮 **No, exit**——Enter 就退出。编排器起的 agent 目录都是 owner 指定或出借流程自建的，本来就跑 bypassPermissions，
 * 自动信任与现有安全模型一致。单测 tests/trust-prompt.test.ts（生产抓屏）、tests/modal-parser.test.ts。
 */
import { paneTail } from "./pane-tail.js";

/**
 * 画面上有信任框的痕迹——半帧、CC 选了 No 退出后留在 shell 上方的残留都算：通用自动 Enter（isAutoConfirmableModal）一律不碰。
 * 看最后 30 行 = parseModalOptions / parseChoicePrompt 两个窗口的并集，它们能认出选项时这里一定也看得到。
 */
export function looksLikeTrustPrompt(pane: string): boolean {
  return paneTail(pane, 30).some((l) => /Quick safety check|trust this folder/i.test(l));
}

/**
 * 活着的信任框上到「Yes」要按几次 Down（负数 = Up，0 = 已高亮）；不是活框返回 null。
 * 活框 = 尾注是最后一行非空行：选了 No 退出后框留在 scrollback、下面接 shell 提示符，认成活框就会对着 shell 一直按 Down+Enter
 * （2026-10-02 出借 worker 实抓：直到 ❯ 行滚出 25 行窗口才停，连按约 20 次）。
 */
export function trustPromptMoves(pane: string): number | null {
  const tail = paneTail(pane, 25);
  if (!/trust this folder/i.test(tail.join("\n")) || !/Enter to confirm/i.test(tail.at(-1) ?? "")) return null;
  const opts: Array<{ yes: boolean; selected: boolean }> = [];
  for (const raw of tail) {
    const m = raw.match(/^\s*(❯)?\s*(?:\d+\.\s*)?(No, exit|Yes, I trust this folder)\s*$/i); // 有的 CC 版本给选项编号
    if (m) opts.push({ yes: /^yes/i.test(m[2]!), selected: !!m[1] });
  }
  const yesIdx = opts.findIndex((o) => o.yes);
  const selIdx = opts.findIndex((o) => o.selected);
  if (yesIdx < 0 || selIdx < 0) return null;
  return yesIdx - selIdx;
}

/**
 * 往「Yes, I trust this folder」走一步：没高亮 Yes 只发方向键、不按 Enter，调用方下一轮重新抓屏；屏上 ❯ 已在 Yes 才按 Enter。
 * 不能「Down → 等 270ms → Enter」盲发：CC 启动期主线程忙，两个键落进同一个读入 burst，选择组件吞掉前面的导航键，
 * Enter 落在默认的 No, exit 上直接退出（AUQ 同一现象见 bridge/ask-user-question.ts sendAuqKeys）。
 */
export async function acceptTrustPrompt(send: (key: string) => Promise<unknown>, moves: number): Promise<void> {
  if (moves === 0) {
    await send("Enter");
    return;
  }
  for (let i = 0; i < Math.abs(moves); i++) {
    if (i) await Bun.sleep(120);
    await send(moves > 0 ? "Down" : "Up");
  }
}
