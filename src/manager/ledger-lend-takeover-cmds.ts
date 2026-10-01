/**
 * `ledger lend-takeover`（i28-PUB1）：出借方 B 已推送、交付通道卡在 publishing 的开工单，由借入方 A 按已推送分支接管交付。
 * 调度服务（lib/lend-pr-takeover.ts）每轮核过 publishing 时长、分支 head 稳定且是订单起点的严格后代、PR 已有或已代开之后调它；
 * 真 PM 也可以手动调。远端分支 head 在这里自己 ls-remote 再核一遍，事务与全部核对在 lib/lend-pr-takeover-ledger.ts。
 */
import { getLendOrder } from "../lib/ledger-lend.js";
import { LedgerError } from "../lib/ledger-store.js";
import { remoteHeadAt } from "../lib/lend-git.js";
import { takeoverLend, type TakeoverDeps } from "../lib/lend-pr-takeover-ledger.js";
import { runBounded } from "../lib/run-bounded.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

/** 测试换掉 remoteHead（ledger CLI 在进程内跑）；生产按仓库坐标直接 ls-remote */
export const takeoverDeps: { make(): TakeoverDeps } = { make: () => ({ remoteHead: (repo, branch) => remoteHeadAt(repo, branch, runBounded) }) };

export const LEND_TAKEOVER_CMDS: Record<string, CommandSpec> = {
  "lend-takeover": {
    valued: ["head", "pr"], bools: [],
    usage: "lend-takeover <orderId> --head <sha> --pr <n>（调度服务 / PM：出借方已推送但交付卡在 publishing 的开工单，按已推送分支接管交付）",
    async run(c) {
      const orderId = c.p.pos[1] ?? "";
      const o = getLendOrder(c.db, orderId);
      if (!o) throw new LedgerError("not_found", `没有出借单 ${orderId}`);
      if (c.deps.actor !== "scheduler") c.requireRealPm(o.project, "接管出借单的交付");
      const pr = intFlag(c.p, "pr");
      if (pr === undefined) throw new LedgerError("invalid", "缺 --pr");
      c.deps.assertLease?.();
      // 查远端要等：租约截止按实时钟核，调度服务租约在事务里紧贴第一笔写再核（失租就不写）
      const deps = { ...takeoverDeps.make(), now: () => c.deps.now(), beforeWrite: () => c.deps.assertLease?.() };
      const r = await takeoverLend(c.db, c.ctx(), { orderId, head: c.need("head"), pr }, deps);
      return { ok: true, ...r };
    },
  },
};
