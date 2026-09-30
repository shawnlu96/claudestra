/**
 * M3 审查员的两个派单工具（T97），挂进 bridge/order-tools.ts 的 HANDLERS。身份门已在 routeOrderTool 过了，这里拿到的调用方全来自 T85 身份。
 * take_review 只读：bridge 的只读连接直接出单（lib/review-order.ts）。submit_verdict 写：先 wire 校验与身份字段（会话 / 家族只取身份），
 * 签一张一次性票据（lib/verdict-ticket.ts：manager 只认它，防 agent 照旧习惯在 Bash 里直接跑子命令；不防蓄意伪造），再经 lib/order-ledger-exit.ts 以调用方频道跑
 * `ledger submit-verdict`，由 manager 在写连接上重算全部判定后记账；bridge 自己不写台账。
 * tests/review-tools.test.ts。
 */
import { withOneShot } from "../lib/caller-cred.js";
import { LedgerReader } from "../lib/ledger-read.js";
import { identityFlags, ledgerWrite, type LedgerRun } from "../lib/order-ledger-exit.js";
import { refuse, type OrderToolHandler, type VerifiedCall } from "../lib/order-tool-route.js";
import { parseVerdictWire } from "../lib/order-wire.js";
import { takeReview } from "../lib/review-order.js";
import { verdictKey } from "../lib/review-verdict.js";
import { issueVerdictTicket } from "../lib/verdict-ticket.js";

const identityOf = (call: VerifiedCall) => ({ agent: call.agent, sessionId: call.sessionId, family: call.family, verified: true });

export function reviewToolHandlers(run: LedgerRun, reader: Pick<LedgerReader, "get"> = new LedgerReader()): Record<string, OrderToolHandler> {
  return {
    async take_review(call) {
      const db = reader.get();
      if (!db) return { ok: true, orders: [], errors: [] };
      const r = takeReview(db, identityOf(call));
      return r.ok ? r : refuse(r.error, r.message);
    },
    async submit_verdict(call, args) {
      const parsed = parseVerdictWire(args);
      if (!parsed.ok) return refuse("invalid_wire", parsed.error);
      const flags = identityFlags(call);
      if (!flags) return refuse("identity_incomplete", "认不出调用方的会话或模型家族（只收 Claude Code / Codex 会话）；什么都没记");
      const w = parsed.value;
      const wire = JSON.stringify(w);
      const ticket = issueVerdictTicket(call.agent, wire);
      return withOneShot(ticket.file, () =>
        ledgerWrite(call, run, "submit-verdict", w.orderId, { wire, ...flags, "ticket-file": ticket.file, ticket: ticket.proof }, verdictKey(w)));
    },
  };
}
