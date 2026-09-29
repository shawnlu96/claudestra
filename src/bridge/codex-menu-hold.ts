/**
 * 发给 Codex agent 的消息，窗口停在选择菜单上时押住（T63 ①）：一个键都不发、不抢占、不替 owner 选；进现有的押后队列（落盘，bridge 重启不丢），
 * 周期扫描 / Stop 时补投，菜单还在就再押回去，菜单关了按原顺序送达（held-flush.ts：投出去才出队、同一频道只有一个投递者）。
 * 顺序：菜单刚关、押着的还没补投完时新到的消息也排到它们后面（复审 P2：不然新消息抢在押着的前面直投）。
 * 第二道闸（channel-server 打字前才看到菜单）退回的那条按 message id 押回队首（onCodexTypeInFailed，复审 P2）。
 * 提示不在这里发：AUQ 认得出的菜单已有选择卡，认不出的由 runtime-dialogs 兜底出运行时卡；这里只写日志。
 * 由 quota-wall-wiring.ts holdAtWallWait 对 Codex 窗口调用（deliverToLocal 在抢占之前、抢占复核撞上菜单时都会走到）。
 */
import type { HeldQueue } from "./held-queue.js";
import { windowWallWait, type WallWait } from "../lib/wall-screen.js";
import { holdNotingStop } from "./preempt.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";
import { turnCuts } from "./turn-cuts.js";

/** 押过、还没补投完的频道 */
const holding = new Set<string>();
const heldReply = (env: Envelope): Delivery => ({ envelope: env, outcome: { kind: "sent", note: "queued", heldBy: "codex_menu" } });

export async function holdAtCodexMenu(
  env: Envelope, to: LocalEndpoint, agent: string, win: string, held: Pick<HeldQueue, "holdEnv" | "rewrite" | "get">, stillWanted?: () => boolean,
  probe: (win: string) => Promise<WallWait | null> = (w) => windowWallWait(w, "codex"), // 单测注入画面
): Promise<Delivery | null> {
  const cid = to.channelId;
  const backlog = held.get(cid) ?? [];
  const replay = backlog.some((i) => i.env === env); // 补投中的那一条（投出去才出队，所以它还在队里）
  if ((await probe(win)) === "codex_menu") {
    if (stillWanted && !stillWanted()) return { envelope: env, outcome: { kind: "dropped", reason: "已从押后队列撤下" } }; // 撤下的别押回来
    holding.add(cid);
    const n = holdNotingStop(held, env, to, agent, "codex");
    console.log(`⏸ codex-menu hold: ${agent} 停在 Codex 选择菜单，没发任何键；消息 ${env.meta.messageId} 押后，队列 ${n} 条`);
    return heldReply(env);
  }
  if (!holding.has(cid)) return null;
  if (!replay && backlog.length) {
    const n = holdNotingStop(held, env, to, agent, "codex");
    console.log(`⏸ codex-menu hold: ${agent} 的菜单已关，但押着的还没补投完；消息 ${env.meta.messageId} 排在后面，队列 ${n} 条`);
    return heldReply(env);
  }
  if (backlog.length <= (replay ? 1 : 0)) {
    holding.delete(cid);
    console.log(`▶ codex-menu 放行: ${agent} 的选择菜单关了，押住的消息已按原顺序补投完`);
  }
  return null;
}

/**
 * channel-server 报打字投递没做成（ws codex_typein_failed）：照旧让下一条再试着打字；是 Codex 菜单挡住的（menu），把那一条按 message id
 * 押回队首——它本该最早送达，菜单关了由周期扫描补投；粘完才冒出菜单、没按回车的（unknown）结果未知，只记日志、不重投（免得重复）。
 */
export function onCodexTypeInFailed(
  msg: { channelId: string; menu?: unknown; unknown?: unknown; messageId?: unknown }, held: Pick<HeldQueue, "holdFirst">, cuts = turnCuts,
): void {
  cuts.rearmAfterInterrupt(msg.channelId);
  const id = typeof msg.messageId === "string" ? msg.messageId : "";
  if (msg.unknown === true) return void console.log(`⚠️ codex-menu: ${id} 已粘进输入框，回车前菜单弹出来了、没按——结果未知，不重投`);
  if (msg.menu !== true) return;
  const env = cuts.takeTypedEnv(msg.channelId, id);
  if (!env) return void console.warn(`⚠️ codex-menu: 第二道闸退回了 ${id || "（没带 id）"}，但 bridge 找不到原信封，押不回去`);
  holding.add(msg.channelId);
  console.log(`⏸ codex-menu hold（第二道闸退回）: ${id} 押回队首，队列 ${held.holdFirst(env)} 条`);
}
