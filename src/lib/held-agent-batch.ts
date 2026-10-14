/**
 * 押后的 agent→agent 消息按收件人合批（HMB-1）：收件人在长回合里时，几个同事发来的消息押在队里；回合边界逐条投的话第一条就开了
 * 新一轮，后面的又被投递层押回，每个边界只进一条、队伍越排越长。开着时 bridge/held-flush.ts 把这个收件人排着的本机 agent 消息
 * 拼成一封载体一次送出（和内部通知批次同一条路：同一个载体、同一组条数 / 字数上限、超长给开头 + 分页读入口、真送达才逐条出队）。
 * 回复归属不靠载体：每条原消息的回程槽各自在 bridge/agent-calls.ts，送达后几个 caller 同时在等，没指明答给谁的回复谁都不推。
 * 设计与取舍：docs/architecture/held-agent-batch.md
 */
import { isHeldIdleCarrier } from "./held-idle-batch.js";

/** 开关：缺省开；只有显式 off / 0 / false 关掉（关掉 = 押后投递逐字回到改动前） */
export const HELD_AGENT_BATCH_ENV = "CLAUDESTRA_HELD_AGENT_BATCH";
export function heldAgentBatchOn(env: Record<string, string | undefined> = process.env): boolean {
  const v = env[HELD_AGENT_BATCH_ENV]?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false");
}

export interface AgentHeldLike {
  reason?: string;
  to: { channelId: string };
  env: {
    from: { kind: string; label?: string };
    to: { kind: string; channelId?: string };
    meta: { attachments?: string[]; expectSession?: string };
  };
}

/**
 * 能进合批的一条：本机 agent 发来、收件频道就是这个队列的。额度闸押的（等出闸按序补投）、带附件的（附件在逐条投递的 meta 里，
 * 载体带不走）、批次载体本身都不进，留在原路径
 */
export function isAgentBatchable(item: AgentHeldLike): boolean {
  const { from, to, meta } = item.env;
  return from.kind === "local" && to.kind === "local" && to.channelId === item.to.channelId
    && !item.reason && !meta.attachments?.length && !isHeldIdleCarrier(item);
}

/**
 * 一批的成员（按到达顺序，最早一条决定会话）：调度派单带 expectSession，只投给仍跑那个会话的目标——载体只能带一个，
 * 和最早那条不一样的留到下一个边界，不带的随便进。少于两条 = 不合批（照旧逐条）
 */
export function agentBatchMembers<T extends AgentHeldLike>(items: readonly T[]): { items: T[]; expectSession?: string } {
  const expectSession = items.find((i) => i.env.meta.expectSession)?.env.meta.expectSession;
  const picked = items.filter((i) => !i.env.meta.expectSession || i.env.meta.expectSession === expectSession);
  return picked.length > 1 ? { items: picked, expectSession } : { items: [] };
}
