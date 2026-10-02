/** Declarative CLI registrations, injected into the manager hub; command logic stays outside its size-ratcheted file. */
import type { Database } from "bun:sqlite";
import { readFileSync, realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import type { WriteCtx } from "./ledger-checks.js";
import { getIntent } from "./ledger-scheduler.js";
import { LedgerError, getEventByDedup, listEvents } from "./ledger-store.js";
import { statePath } from "./paths.js";
import { convergenceEvent } from "./fix-strategy-lifecycle.js";
import { convergenceIntent, fixSwapStep } from "./fix-strategy-runtime.js";
import { arbiterStep, recordArbitration } from "./review-arbiter-runtime.js";

interface CommandContext {
  db: Database;
  ctx(): WriteCtx;
  p: { pos: string[]; flags: Record<string, string | undefined> };
  need(flag: string): string;
  deps: { callerSession?: string; registryPath?: string; gitHead?(dir: string): string | null; gitDirty?(dir: string): string | null };
}

function arbiterReport(path: string): string {
  const root = realpathSync(statePath("ledger", "reviews")), actual = realpathSync(path), rel = relative(root, actual);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new LedgerError("invalid", "仲裁报告必须在 ledger/reviews 内");
  return readFileSync(actual, "utf8");
}

export const convergenceCommands = {
  "scheduler-convergence": {
    valued: ["max-workers"], bools: [], usage: "scheduler-convergence <intent> --max-workers N",
    async run(c: CommandContext) {
      const id = c.p.pos[1] ?? "", intent = getIntent(c.db, id);
      if (intent?.action === "fix_swap") return fixSwapStep(c.db, c.ctx(), id);
      const max = Number(c.need("max-workers"));
      if (!Number.isInteger(max) || max < 1 || max > 32) throw new LedgerError("invalid", "仲裁槽需在 1–32");
      return arbiterStep(c.db, c.ctx(), id, max);
    },
  },
  "scheduler-arbiter-delivery": {
    valued: ["phase"], bools: [], usage: "scheduler-arbiter-delivery <intent> --phase sending|sent|rejected",
    run(c: CommandContext) {
      const intent = convergenceIntent(c.db, c.ctx(), c.p.pos[1] ?? "", "arbitrate");
      const phase = c.need("phase");
      if (!["sending", "sent", "rejected"].includes(phase) || intent.status !== "submitted") throw new LedgerError("invalid", "仲裁投递状态不符");
      const prior = listEvents(c.db, { project: intent.project, target: intent.taskId }).filter((e) => e.data.intentId === intent.id && e.data.op === "arbiter_delivery");
      const last = prior.at(-1)?.data.phase;
      if ((phase === "sending" && last !== undefined && last !== "rejected") || (phase !== "sending" && last !== "sending")) {
        throw new LedgerError("conflict", "仲裁投递回执必须按 sending→sent/rejected 记录");
      }
      convergenceEvent(c.db, c.ctx(), intent, `delivery:${prior.length}`, { op: "arbiter_delivery", phase });
      return { ok: true };
    },
  },
  "scheduler-arbiter-verdict": {
    valued: ["verdict", "head", "report"], bools: [], usage: "scheduler-arbiter-verdict <intent> --verdict upheld|overturned --head SHA --report path",
    run(c: CommandContext) {
      const id = c.p.pos[1] ?? "", report = c.need("report");
      recordArbitration(c.db, c.ctx(), id, c.need("verdict"), c.need("head"), report,
        { session: c.deps.callerSession, registryPath: c.deps.registryPath, gitHead: c.deps.gitHead, gitDirty: c.deps.gitDirty, reportText: arbiterReport(report) });
      return { ok: true, event: getEventByDedup(c.db, `scheduler:${id}:verdict`) };
    },
  },
};
