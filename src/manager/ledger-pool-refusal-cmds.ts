/**
 * dispatch-recovery-MODELXP2：池单拒审的调度服务写口 `ledger scheduler-pool-refusal <task> --order <单号> --data {localFamilies}`。
 * 只给调度身份（lend-cancel 的 PM 权限不放宽）；modelOutcome 由这里现读 CFG（off 拒、observe 只记计划、on 执行），借入配置现读，
 * 其余事实在 writePoolRefusal 的事务里重读，不收调用方的。规则拒绝是 LedgerError，别的失败答 write_failed。tests/ledger-pool-refusal*.test.ts。
 */
import { AUTHOR_FAMILIES, type AuthorFamily } from "../lib/ledger-scheduler.js";
import { getLendOrder } from "../lib/ledger-lend.js";
import { LedgerError } from "../lib/ledger-store.js";
import { writePoolRefusal } from "../lib/ledger-pool-refusal.js";
import { modelOutcomeMode } from "../lib/scheduler-model-wiring.js";
import { readEffectiveBorrow } from "../lib/scheduler-pool-borrow.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function localFamilies(raw: string): AuthorFamily[] {
  let d: unknown;
  try { d = JSON.parse(raw); } catch (e) { throw new LedgerError("invalid", `--data 不是 JSON：${(e as Error).message}`); }
  const f = d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>).localFamilies : undefined;
  if (f === undefined) return [...AUTHOR_FAMILIES];
  if (!Array.isArray(f) || f.length > 2 || !f.every((x) => AUTHOR_FAMILIES.includes(x as AuthorFamily))) throw new LedgerError("invalid", "localFamilies 只收 claude / codex");
  return f as AuthorFamily[];
}

export const POOL_REFUSAL_CMDS: Record<string, CommandSpec> = {
  "scheduler-pool-refusal": {
    valued: ["order", "data"], bools: [],
    usage: "scheduler-pool-refusal <task> --order <单号> --data {localFamilies?}（调度服务专用：池单提供方策略拒审，事务内重核后撤单 / 记结果 / epoch / 告知；按单号去重）",
    async run(c) {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "池单拒审接续的写口只给调度服务");
      try {
        const taskId = c.p.pos[1] ?? "", orderId = c.need("order"), families = localFamilies(c.need("data"));
        const project = getLendOrder(c.db, orderId)?.project;
        if (!project) throw new LedgerError("not_found", `没有出借单 ${orderId}`);
        const mode = await modelOutcomeMode(project);
        if (mode === "off") throw new LedgerError("conflict", "modelOutcome 为 off，不接续池单拒审");
        const borrow = await (c.deps.lend?.borrow() ?? readEffectiveBorrow());
        const r = writePoolRefusal(c.db, c.ctx(), { taskId, orderId, mode, borrow, localFamilies: families });
        return { ok: true, mode, duplicate: r.duplicate, plan: r.decision.plan, planSeq: r.plan.seq, epochSeq: r.epoch?.seq ?? null,
          cancelled: r.cancelled, informed: r.informed, text: r.text };
      } catch (e) {
        if (e instanceof LedgerError) throw e;
        return { ok: false, code: "write_failed", error: (e as Error).message };
      }
    },
  },
};
