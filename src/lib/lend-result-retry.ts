/**
 * i28-RR1：result 同秒原字节重发撞上 A 的防重放。`manager lend call` 每次现签，但签名时间戳只到秒：worker 的 submit_verdict 刚同步转过一次
 * （A 已入账、回执交给了 worker，B journal 仍是 result_pending），调度服务同一秒原字节再发，method / path / ts / 正文哈希都一样，签名也一样，
 * A 的 authApi 判重放回 401 {code:"peer_signature", reason:"replay"}（E2E 内层响应，已认证）。这只说明「这条签名 A 见过」，不是 A 拒收结论：
 * 不能当终态停单，也不能当已入账——留着 result_pending，下一轮调度重新签名原字节重发，A 的 result 按同一 sha256 回旧回执，验签过了才 acked。
 * 只认这一种精确组合：别的 peer_signature 原因（bad / stale / before_start / unanchored …）、reason 缺失、429 限速、
 * 重握手后被换成的 409（peer-e2e-outbound.ts e2e_duplicate，通用的防重复执行语义）都照旧。tests/lend-result-retry.test.ts。
 */
import type { LendAnyOp, LendRes } from "./lend-remote.js";
import { INNER_REPLAY_REASONS } from "./peer-e2e-wire.js";

type LendErr = Extract<LendRes<unknown>, { ok: false }>;

/** true = 这次 result 被拒只因为同一签名已被 A 见过：保留待取回执，下一轮重签再发 */
export function resultReplayPending(op: LendAnyOp, r: LendErr): boolean {
  return op === "result" && r.status === 401 && r.code === "peer_signature" && r.reason === INNER_REPLAY_REASONS.duplicate;
}
