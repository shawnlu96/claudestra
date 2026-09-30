/** 领单留痕（bridge 替领单的执行者 / 审查员以其身份写）与未领单报警（调度服务专用）；逻辑与校验在 lib/order-mark.ts。 */
import { markOrderTaken, markUnclaimed } from "../lib/order-mark.js";
import { LedgerError } from "../lib/ledger-store.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const intentArg = (id: string | undefined): string => {
  if (!id) throw new LedgerError("invalid", "缺调度意图 id（= orderId）");
  return id;
};

export const ORDER_MARK_CMDS: Record<string, CommandSpec> = {
  "order-taken": {
    valued: ["session"], bools: [],
    usage: "order-taken <orderId> --session <会话 id>（bridge 在 take_order / take_review 领到调度器的单后以领单人身份写；按单去重）",
    run(c) {
      const r = markOrderTaken(c.db, { actor: c.deps.actor, now: c.deps.now() }, { intentId: intentArg(c.p.pos[1]), sessionId: c.need("session") });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
  "scheduler-unclaimed": {
    valued: ["text"], bools: [],
    usage: "scheduler-unclaimed <intent-key> --text <说明>（调度服务专用：唤醒发出后没人领单，记一次报警；按单去重，duplicate=true 不再通知）",
    run(c) {
      const r = markUnclaimed(c.db, { actor: c.deps.actor, now: c.deps.now() }, { intentId: intentArg(c.p.pos[1]), text: c.need("text") });
      return { ok: true, event: r.event, duplicate: r.duplicate };
    },
  },
};
