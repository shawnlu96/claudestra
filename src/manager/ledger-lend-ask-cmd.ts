/**
 * 出借方 B 的台账写入（调度服务身份）：给 owner 发开跑 / 交付 / 停止通知（lend-inform，lib/lend-notice.ts）、关升级前遗留的逐单确认 ask
 * （lend-ask --retire，lib/lend-ask.ts）、出借单结束后关 worker 开出的 Codex 卡。出借单本身记在 lend journal（lib/lend-journal.ts）。
 * 借入方 A 的历史回收：lend-terminal-asks 关已结清出借单上 worker 的旧提问（lib/order-ask-terminal.ts），给项目 PM 与调度服务用，缺省只预览。
 */
import { cancelAsksWhere } from "../lib/ledger-asks.js";
import { isManager } from "../lib/ledger-checks.js";
import { applySettledAskSweep, planSettledAskSweep } from "../lib/order-ask-terminal.js";
import { LedgerError } from "../lib/ledger-store.js";
import { isLendWorkerName } from "../lib/runtimes/clean-env.js";
import { retireLendAsk } from "../lib/lend-ask.js";
import { lendNoticeProblem, lendNoticeText, type LendNoticeParams } from "../lib/lend-notice.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

function onlyScheduler(c: LedgerCli, sub: string): void {
  if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", `${sub} 只给调度服务用`);
}

function params(c: LedgerCli, sub: string): LendNoticeParams {
  onlyScheduler(c, sub);
  let p: unknown;
  try { p = JSON.parse(c.p.flags.params ?? ""); } catch { throw new LedgerError("invalid", "--params 要是 JSON"); }
  const bad = lendNoticeProblem(p);
  if (bad) throw new LedgerError("invalid", `--params 不合格：${bad}`);
  return p as LendNoticeParams;
}

export const LEND_ASK_CMDS: Record<string, CommandSpec> = {
  "lend-ask": {
    valued: ["retire"], bools: [],
    usage: "lend-ask --retire <askId>（调度服务专用：逐单确认已退役，关掉升级前遗留的出借确认 ask；重复调无害）",
    run(c) {
      onlyScheduler(c, "lend-ask");
      const id = c.p.flags.retire ?? "";
      if (!/^[\w-]{1,64}$/.test(id)) throw new LedgerError("invalid", "--retire 要是 ask id");
      // 拿到写锁后再核一次租约：等锁期间可能失租
      const bad = retireLendAsk(c.db, id, c.deps.now(), { beforeWrite: () => c.deps.assertLease?.() });
      if (bad) throw new LedgerError("invalid", bad);
      return { ok: true };
    },
  },
  "lend-inform": {
    valued: ["params"], bools: [],
    usage: "lend-inform --params '<json>'（调度服务专用：出借开跑 / 交付 / 停止时通知 owner；没送到返回 notified:false，开跑通知没送到调用方不起 worker）",
    async run(c) {
      const text = lendNoticeText(params(c, "lend-inform"));
      if (!c.deps.notifyOwner) return { ok: true, notified: false, why: "这个进程没有通知通道" };
      c.deps.assertLease?.(); // 发帧那一刻 bridge-client 还会核；发完再核：期间失租就报 lease-lost，不让调用方当成送到了去起 worker
      const notified = await c.deps.notifyOwner(text);
      c.deps.assertLease?.();
      return { ok: true, notified };
    },
  },
  "lend-close-asks": {
    valued: ["agent"], bools: [],
    usage: "lend-close-asks --agent <agent-lend-…>（调度服务专用：出借单结束后关掉这个 worker 开出的 Codex 额度 / 登录卡）",
    run(c) {
      onlyScheduler(c, "lend-close-asks");
      const agent = c.p.flags.agent ?? "";
      if (!isLendWorkerName(agent) || !/^[\w-]{1,64}$/.test(agent)) throw new LedgerError("invalid", "--agent 要是出借 worker 的名字（agent-lend-…）");
      // 拿到写锁后再核一次租约：等锁期间可能失租
      const closed = cancelAsksWhere(c.db, { fromAgent: agent, source: "codex" }, "出借单已结束，worker 已停", c.deps.now(), { beforeWrite: () => c.deps.assertLease?.() });
      return { ok: true, closed };
    },
  },
  "lend-terminal-asks": {
    valued: ["project"], bools: ["apply"],
    usage: "lend-terminal-asks --project <id> [--apply]（项目 PM / 调度服务：已结清出借单上 worker 的旧提问；缺省只预览 askId / 单号 / 状态 / 原因，--apply 在写锁内重核身份与租约后关闭）",
    run(c) {
      const project = c.project();
      // 调度服务走租约闸（runLedger 入口核过一次）；其余身份要项目 PM / master / owner。--apply 拿到写锁后再核一遍：等锁期间可能失租或被撤 PM
      const allowed = (): void => {
        if (c.deps.actor === "scheduler") return void c.deps.assertLease?.();
        if (!isManager(c.db, c.deps.actor, { agent: null, project })) throw new LedgerError("forbidden", `回收要项目 ${project} 的 PM / master / owner 或调度服务（你是 ${c.deps.actor}）`);
      };
      allowed();
      if (!c.p.bools.has("apply")) return { ok: true, apply: false, project, ...planSettledAskSweep(c.db, project) };
      const r = applySettledAskSweep(c.db, project, c.deps.now(), c.deps.actor, { beforeWrite: allowed });
      return { ok: true, apply: true, project, ...r };
    },
  },
};
