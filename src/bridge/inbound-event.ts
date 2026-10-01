/**
 * 入站消息投给本地 agent 时的两件事（bridge.ts deliverToLocal）：
 * - 镜像成 chat_message(in) 事件的 data。srcKind（user = Discord 人类 / api = Web 用户 / local = agent·bridge）让网页把他端用户发言实时画成气泡、
 *   排除 agent/bridge 注入；fromId（user_id）让网页认出本人的其它来源。attachments 是 bridge 真收下的附件路径（和 channel 头属性同一份）：
 *   网页给外源消息画附件卡片只认它，不认正文里的 [attachment: …] 行（tests/inbound-event.test.ts）。
 * - 投之前过入站账（lib/inbound-ledger.ts）：包装投递的记一笔，原样投递的先清账；历史 API 按 agent 取查账函数（tests/inbound-ledger.test.ts）。
 */
import { forgetInbound, inboundLookup, noteInbound, type InboundLookup } from "../lib/inbound-ledger.js";
import { readRegistryAgents } from "../lib/registry.js";
import { isAcpChannel } from "./acp-state.js";
import type { HeldQueue } from "./held-queue.js";
import { webDb } from "./local-api/db.js";
import type { Delivery, Envelope, LocalEndpoint } from "./router.js";

export function inboundEventData(env: Envelope, meta: Record<string, string>): Record<string, unknown> {
  const atts = env.meta.attachments?.filter(Boolean) ?? [];
  return {
    direction: "in", from: meta.user || "?", fromId: meta.user_id, srcKind: env.from.kind, text: env.content, threadId: env.meta.threadId,
    ...env.meta.askEcho,
    ...(atts.length ? { attachments: atts } : {}),
  };
}

/**
 * 投 ws 之前调（bridge.ts deliverToLocal）。runtime 是目标 register 时自报的：CC 不报 → 不管（CC 的 <channel> 按 MCP meta 写）。
 * ACP 宿主、tmux Codex 的 channel-server 把每条入站整块包进 <channel message_id=…>：记一笔，记不上只是这条历史保守，照常发。
 * tmux 版 Pi 原样进记录，外源能照抄 owner 的整块包装：先清掉该 agent 的账才放行；清不掉（库锁住 / 打不开）就押后，分钟级 sweep 重试。
 * 返回 null = 照常发；否则是押后结果。改成「清不掉也发」= 旧账活过原样投递，锁一放开就冒认（tests/inbound-ledger.test.ts）
 */
export async function inboundLedgerGate(
  env: Envelope, runtime: string | undefined, agent: string, content: string, meta: Record<string, string>, held: Pick<HeldQueue, "holdEnv">,
): Promise<Delivery | null> {
  if (!runtime) return null;
  const channelId = (env.to as LocalEndpoint).channelId;
  if (runtime === "codex" || isAcpChannel(channelId)) {
    try {
      noteInbound(webDb(), agent, meta.message_id, content, meta, Date.now());
    } catch (e) {
      console.error(`入站账：web 状态库打不开，这条不记（投递照常、历史保守）: ${(e as Error).message}`);
    }
    return null;
  }
  // 名字认不出（watcher 缺位）就按 registry 找：清错 agent 等于没清；registry 也没有 = 没有哪个 agent 的历史会读到它
  const name = agent !== "?" ? agent : (await readRegistryAgents()).find((r) => r.channelId === channelId)?.name;
  if (!name || purgeInbound(name)) return null;
  console.log(`⏸ 消息押后(${name} 入站账清不掉，不能原样投给 tmux 版 Pi): ${meta.message_id}，队列 ${held.holdEnv(env)} 条`);
  return { envelope: env, outcome: { kind: "sent", note: "queued" } };
}

function purgeInbound(agent: string): boolean {
  try {
    return forgetInbound(webDb(), agent);
  } catch (e) {
    console.error(`入站账：web 状态库打不开，清不掉 ${agent} 的账: ${(e as Error).message}`);
    return false;
  }
}

/** 历史 / 搜索按 agent 名取查账函数；库打不开就给一个永远查不到的（历史退回保守，不 500） */
export function inboundFor(agent: string): InboundLookup {
  try {
    return inboundLookup(webDb(), agent);
  } catch (e) {
    console.error(`入站账：web 状态库打不开，历史按保守显示: ${(e as Error).message}`);
    return () => null;
  }
}
