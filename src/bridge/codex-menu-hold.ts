/**
 * 发给 Codex agent 的消息，窗口停在选择菜单上时押住（T63 ①）：一个键都不发、不抢占、不替 owner 选；进现有的押后队列（落盘，bridge 重启不丢），
 * 周期扫描 / Stop 时补投，菜单还在就再押回去，菜单关了按原顺序送达（held-flush.ts）。
 * 提示不在这里发：AUQ 认得出的菜单已有选择卡，认不出的由 runtime-dialogs 兜底出运行时卡；这里只写日志（押住一行，放行一行）。
 * 由 quota-wall-wiring.ts holdAtWallWait 对 Codex 窗口调用（deliverToLocal 在抢占之前、抢占复核撞上菜单时都会走到）。
 */
import type { HeldQueue } from "./held-queue.js";
import { windowWallWait, type WallWait } from "../lib/wall-screen.js";
import { holdNotingStop } from "./preempt.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

/** 押过、还没放行的频道：菜单关了、第一条照常投递时写一行「放行」 */
const holding = new Set<string>();

export async function holdAtCodexMenu(
  env: Envelope, to: LocalEndpoint, agent: string, win: string, held: Pick<HeldQueue, "holdEnv" | "rewrite">, stillWanted?: () => boolean,
  probe: (win: string) => Promise<WallWait | null> = (w) => windowWallWait(w, "codex"), // 单测注入画面
): Promise<Delivery | null> {
  if ((await probe(win)) !== "codex_menu") {
    if (holding.delete(to.channelId)) console.log(`▶ codex-menu 放行: ${agent} 的选择菜单关了，押住的消息按原顺序送达`);
    return null;
  }
  if (stillWanted && !stillWanted()) return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } }; // 撤下的别押回来
  holding.add(to.channelId);
  const n = holdNotingStop(held, env, to, agent, "codex");
  console.log(`⏸ codex-menu hold: ${agent} 停在 Codex 选择菜单，没发任何键；消息 ${env.meta.messageId} 押后，队列 ${n} 条`);
  return { envelope: env, outcome: { kind: "sent", note: "queued", heldBy: "codex_menu" } };
}
