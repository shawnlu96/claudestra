/** 自动迁移已完成 /quit：如果另一个进程重新占了窗口，不能走通用 restart 的打断/强杀。 */
import { windowChildPids } from "../lib/tmux-helper.js";
export async function requireExitedCodex(info: { runtime?: string; transport?: string; acpRestartFrom?: string } | undefined,
  ids: string[], children: (target: string) => Promise<number[]> = (target) => windowChildPids(target, true)): Promise<void> {
  if (info?.runtime !== "codex" || info.transport !== "acp" || info.acpRestartFrom !== "tmux") throw new Error("空闲迁移状态已变，拒绝重启");
  if (ids.length > 1 || (ids.length === 1 && (await children(ids[0]!)).length)) throw new Error("窗口仍有进程：自动迁移不打断，保留待重启标记");
}
