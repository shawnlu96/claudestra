/** Scheduler-only CLI for the deploy journal (T68g); the exit from a deploy `unknown` is `scheduler-merge-resolve`. */
import { advanceDeployRun, beginDeployRun } from "../lib/scheduler-deploy.js";
import { DEPLOY_PHASES, type DeployPhase } from "../lib/ledger-deploy-schema.js";
import { LedgerError } from "../lib/ledger-store.js";
import { intFlag } from "./ledger-identity.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

const oneOf = <T extends string>(v: string | undefined, xs: readonly T[], flag: string): T | undefined => {
  if (v === undefined) return undefined;
  if (!xs.includes(v as T)) throw new LedgerError("invalid", `--${flag} 只能是 ${xs.join(" / ")}`);
  return v as T;
};

export const SCHEDULER_DEPLOY_CMDS: Record<string, CommandSpec> = {
  "scheduler-deploy-begin": {
    valued: [], bools: [], usage: "scheduler-deploy-begin <intent-key>（调度服务专用：merged 之后占位自动部署）",
    run(c) { return { ok: true, ...beginDeployRun(c.db, c.ctx(), c.p.pos[1] ?? "") }; },
  },
  "scheduler-deploy-step": {
    valued: ["from", "to", "rev", "receipt", "label", "outcome", "liveness"], bools: [],
    usage: "scheduler-deploy-step <intent-key> --from <phase> --to <phase> --rev N [--receipt] [--label] [--outcome success|failed|unknown] [--liveness dead]",
    run(c) {
      const rev = intFlag(c.p, "rev");
      if (rev === undefined || rev < 0) throw new LedgerError("invalid", "要带 --rev 非负整数");
      return { ok: true, run: advanceDeployRun(c.db, c.ctx(), {
        intentId: c.p.pos[1] ?? "", from: oneOf(c.need("from"), DEPLOY_PHASES, "from") as DeployPhase,
        to: oneOf(c.need("to"), DEPLOY_PHASES, "to") as DeployPhase, rev, receipt: c.p.flags.receipt, label: c.p.flags.label,
        outcome: oneOf(c.p.flags.outcome, ["success", "failed", "unknown"] as const, "outcome"), liveness: oneOf(c.p.flags.liveness, ["dead"] as const, "liveness"),
      }) };
    },
  },
};
