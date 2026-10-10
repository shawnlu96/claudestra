/** Typed UI takeover diagnostic, recomputed by the writer; no caller-controlled note text or policy bypass. */
import { getLendOrder } from "../lib/ledger-lend.js";
import { LedgerError } from "../lib/ledger-store.js";
import { takeoverRefusal } from "../lib/lend-pr-takeover-ledger.js";
import { uiTakeoverRefusal } from "../lib/lend-pr-takeover-refusal.js";
import { writeTakeoverRefusal } from "../lib/lend-pr-takeover-refusal-diagnostic.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";
import type { TakeoverDeps } from "../lib/lend-pr-takeover-ledger.js";
import { SchedulerLeaseLost } from "../lib/scheduler-lease-env.js";

export function takeoverRefusalCommands(make: () => TakeoverDeps): Record<string, CommandSpec> {
  return { "lend-takeover-refusal": {
    valued: ["head", "pr"], bools: [], usage: "lend-takeover-refusal <orderId> --head <sha> [--pr <n>]（当前 UI 接管阻塞诊断）",
    async run(c) {
      if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "接管诊断写口只给调度服务");
      if (c.p.pos.length !== 2) throw new LedgerError("invalid", "接管诊断仅收单号，不收正文或额外位置参数");
      const orderId = c.p.pos[1] ?? "", head = c.need("head"), pr = intFlag(c.p, "pr") ?? null;
      if (!/^[0-9a-f]{40}$/.test(head) || (pr !== null && (!Number.isSafeInteger(pr) || pr < 1))) throw new LedgerError("invalid", "诊断要完整 head 与有效 PR 号");
      const o = getLendOrder(c.db, orderId);
      if (!o) throw new LedgerError("not_found", "没有该出借单");
      const material = (row: typeof o) => JSON.stringify([row.taskId, row.peer, row.worker, row.step, row.repo, row.branch, row.base,
        row.head, row.round, row.specRev, row.leaseGen, row.sha256]);
      const active = () => {
        if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "接管诊断写口只给调度服务");
        if (!c.deps.assertLease) throw new SchedulerLeaseLost("接管诊断缺少调度租约核验");
        c.deps.assertLease();
        const cur = getLendOrder(c.db, orderId);
        if (!cur || cur.project !== o.project || c.task(cur.taskId).project !== o.project || !c.deps.projectIds.includes(o.project)
          || !c.deps.autoProjects?.().includes(o.project)) throw new LedgerError("forbidden", "接管诊断不在调度所管项目");
        if (material(cur) !== material(o)) throw new LedgerError("conflict", "接管诊断订单材料已变化");
        const why = takeoverRefusal(c.db, orderId, c.deps.now());
        if (why) throw new LedgerError("conflict", why);
      };
      active();
      if (head === o.head) throw new LedgerError("invalid", "接管诊断 head 仍是订单起点");
      const deps = make();
      const r = uiTakeoverRefusal(c.db, orderId, head, deps.uiPort);
      if (!r) return { ok: true, message: null };
      const remote = await deps.remoteHead(o.repo, o.branch as string);
      if (!remote.ok) throw new LedgerError("conflict", "诊断远端 head 无法核验");
      if (remote.head !== head) throw new LedgerError("conflict", "诊断远端 head 已变化");
      const message = writeTakeoverRefusal(c.db, orderId, head, pr, r, c.deps.now, active);
      return { ok: true, message };
    },
  } };
}
