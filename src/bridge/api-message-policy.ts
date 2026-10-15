/**
 * API 入站消息的 PM 级别（agents-PEERLEVEL1）：对方实例的 agent 用 send_to_agent 发 oneShot 时可在请求体带 level。
 * 接收侧只认降级——已认证的 peer principal 标 info 才进信封 meta.pmLevel，当班 PM 那边按本机 info 同路进摘要；
 * action / 缺省 / 非法值 / 普通 API token 一律不设，与以前逐字相同。api-routes.ts 只各留一行调用。
 */
import type { Envelope } from "./router.js";

/** 信封 meta 的级别字段：只看鉴权得到的 principal.peer，不看请求体自报 */
export function peerPmLevel(principal: { peer?: string }, level: unknown): { pmLevel?: "info" } {
  return principal.peer && level === "info" ? { pmLevel: "info" } : {};
}

/**
 * 当班 PM 的摘要收下了这封 peer info：不会有回合，也不会有回复——从待回复表摘掉它（转交后可能已挪到当班 PM 名下，按对象找），
 * 返回 true 让调用方不起 typing、直接回 202 接受回执（免得网页上挂着假的「思考中」）。其余投递一律 false，照旧
 */
export function settleDigestedPeerInfo<T>(delivery: { envelope: Envelope; outcome: { kind: string; note?: unknown } }, pending: Map<string, T[]>, entry: T): boolean {
  const { envelope: env, outcome } = delivery;
  if (env.from.kind !== "api" || !env.from.peer || env.meta.pmLevel !== "info" || outcome.kind !== "sent" || outcome.note !== "digest") return false;
  for (const [key, queue] of pending) {
    const i = queue.indexOf(entry);
    if (i < 0) continue;
    queue.splice(i, 1);
    if (!queue.length) pending.delete(key);
  }
  return true;
}
