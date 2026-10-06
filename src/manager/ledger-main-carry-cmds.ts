/**
 * `ledger main-carry <task> ...`: the formal PM main-carry entry (MAINP2), real PM / master / owner only (not a scheduler-service
 * command); policy mainCarry: off refuses, observe reports, on writes one carry (lib/review-main-carry-manual.ts). Post-merge
 * verification is read-only and outside this writable CLI: `bun scripts/pm-merge-preflight.ts verify` (LedgerReader + GitHub facts).
 */
import { LedgerError } from "../lib/ledger-store.js";
import { recoveryPolicy, RECOVERY_POLICY_PATH } from "../lib/recovery-policy.js";
import { runManualCarry, type ProveCarry } from "../lib/review-main-carry-manual.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const int = (c: LedgerCli, flag: string): number => {
  const v = c.need(flag);
  if (!/^\d{1,9}$/.test(v)) throw new LedgerError("invalid", `--${flag} 要是非负整数，收到 ${v}`);
  return Number(v);
};

export function mainCarryCmds(opts: { policyPath?: string; prove?: ProveCarry } = {}): Record<string, CommandSpec> {
  const path = opts.policyPath ?? RECOVERY_POLICY_PATH;
  const policy = (project: string, key: Parameters<typeof recoveryPolicy>[1]) => recoveryPolicy(project, key, path);
  return {
    "main-carry": {
      valued: ["old", "new", "main", "spec-rev", "round", "review-seq", "rev", "repo-dir"],
      usage: "main-carry <task> --old <sha> --new <sha> --main <actual main sha> --spec-rev N --round N --review-seq N --rev N --repo-dir <dir>"
        + "（PM / master / owner；按恢复策略 mainCarry：off 拒、observe 只报计划、on 写一条正式沿用并前移 head）",
      async run(c) {
        const task = c.task(c.p.pos[1]);
        const outcome = await runManualCarry(c.db, { actor: c.deps.actor, now: c.deps.now() }, {
          taskId: task.id, oldHead: c.need("old"), newHead: c.need("new"), mainHead: c.need("main"), specRev: int(c, "spec-rev"),
          round: int(c, "round"), reviewSeq: int(c, "review-seq"), rev: int(c, "rev"),
        }, { repoDir: c.need("repo-dir"), prove: opts.prove, policy });
        return { ok: outcome.status === "carried" || outcome.status === "observe" || outcome.status === "noop", ...outcome,
          ...(outcome.status === "refused" || outcome.status === "off" ? { code: "conflict", error: outcome.reason } : {}) };
      },
    },
  };
}

export const MAIN_CARRY_CMDS = mainCarryCmds();
