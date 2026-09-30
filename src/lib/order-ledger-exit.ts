/**
 * 派单工具写台账的唯一出口：以调用方身份跑 `manager ledger <子命令>`。bridge 对台账只读（asks 例外，lib/ledger-asks.ts），
 * 阶段机、角色、幂等全在 CLI 与 lib/ledger-write.ts 里，所以这里不另写 SQL，效果与执行者自己跑 CLI 逐字段一致。
 * - actor：子进程的 DISCORD_CHANNEL_ID = 调用方连接注册的频道，manager 按它算出 agent（manager/ledger-identity.ts）；频道为空会变成 owner，
 *   所以 run 拿不到频道就不跑（routeOrderTool 已保证有）。
 * - 会话 / 家族：要写进台账的（审查的 --session / --family）只从 VerifiedCall 取，identityFlags 生成，不收工具参数。
 * - 每次写都带 --dedup：工具重试同键回放原事件，不会重复推阶段。自由文本用 `--k=v` 形式，以 - 开头也不会被当成旗标。
 * tests/order-ledger-exit.test.ts。
 */
import type { OrderToolResult, VerifiedCall } from "./order-tool-route.js";

/** 注入：以 channelId 为 DISCORD_CHANNEL_ID 跑 manager，返回它的 JSON 结果（lib/run-manager.ts interpretManagerRun 的形状） */
export type LedgerRun = (args: string[], channelId: string) => Promise<any>;

export type LedgerFlags = Record<string, string | undefined>;

/** 台账的 AuthorFamily（claude / codex）：registry runtime 是 claude-code / codex；Pi 等没有对应值 → null（调用方自己拒） */
export function ledgerFamily(call: Pick<VerifiedCall, "family">): "claude" | "codex" | null {
  if (call.family === "codex") return "codex";
  if (call.family === "claude-code") return "claude";
  return null;
}

/** 审查一类命令要记的会话与家族：只来自身份。缺任何一项返回 null，调用方拒绝，不写 */
export function identityFlags(call: VerifiedCall): LedgerFlags | null {
  const family = ledgerFamily(call);
  return call.sessionId && family ? { session: call.sessionId, family } : null;
}

export function ledgerArgs(sub: string, target: string, flags: LedgerFlags, dedup: string): string[] {
  const out = ["ledger", sub, target];
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) out.push(`--${k}=${v}`);
  out.push(`--dedup=${dedup}`);
  return out;
}

/** 跑一次写命令；manager 的 {ok:false, code, error} 原样转成拒绝（code 缺省记 ledger） */
export async function ledgerWrite(call: VerifiedCall, run: LedgerRun, sub: string, target: string, flags: LedgerFlags, dedup: string): Promise<OrderToolResult> {
  if (!call.channelId) return { ok: false, code: "identity_unverified", error: "没有调用方频道，不以 owner 身份写台账" };
  const r = await run(ledgerArgs(sub, target, flags, dedup), call.channelId);
  if (r?.ok) return { ...(r as Record<string, unknown>), ok: true };
  return { ok: false, code: typeof r?.code === "string" ? r.code : "ledger", error: typeof r?.error === "string" ? r.error : "台账写入失败" };
}
