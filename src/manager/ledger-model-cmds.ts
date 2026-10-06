/**
 * dispatch-recovery-MODELXW: the scheduler service's write path for MODELX (it holds only a read-only ledger handle). Four
 * scheduler-only subcommands, each calling the library function MODELX already had, in the writer's process and transaction:
 * - scheduler-review-snapshot <intent> --round N --data {order}: freeze a pending review order's materials (writeReviewSnapshot);
 * - scheduler-model-outcome <intent> --data {failure, failed, authorized, review?}: MODEL's record (writeModelOutcome);
 * - scheduler-refusal-epoch <task> --plan-seq N --data {authorized}: the refusal epoch (writeRefusalEpoch → beginRefusalEpoch);
 * - scheduler-model-inform <task> --key K --text T --data {op, …}: one owner / PM note per key (writeModelNote);
 * - scheduler-legacy-review-retire <task> --intent I --data {evidence}: retire a legacy (no snapshot) refused reviewer (writeLegacyReviewRetire).
 * Facts (approval, refusalHold, head, specRev, round, snapshot, binding) are re-read there, never taken from the caller.
 * A guard refusal is a LedgerError (conflict / invalid / not_found); any other failure answers code write_failed, so the
 * service can tell "the rule said no" from "the write did not happen". tests/scheduler-model-wiring-prod*.test.ts.
 */
import { AUTHOR_FAMILIES } from "../lib/ledger-scheduler.js";
import { LedgerError } from "../lib/ledger-store.js";
import { writeLegacyReviewRetire, writeModelNote, writeModelOutcome, writeRefusalEpoch, writeReviewSnapshot, type OutcomeWrite } from "../lib/scheduler-model-wiring.js";
import { intFlag } from "./ledger-identity.js";
import type { LedgerCli } from "./ledger-context.js";
import type { CommandSpec } from "./ledger-write-cmds.js";

type Placement = OutcomeWrite["authorized"][number];
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function data(c: LedgerCli): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(c.need("data")); } catch (e) {
    if (e instanceof LedgerError) throw e;
    throw new LedgerError("invalid", `--data 不是 JSON：${(e as Error).message}`);
  }
  if (!obj(raw)) throw new LedgerError("invalid", "--data 要是 JSON 对象");
  return raw;
}

const str = (v: unknown, what: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new LedgerError("invalid", `${what} 要是非空字符串`);
  return v;
};

function placement(v: unknown): Placement {
  if (!obj(v) || !AUTHOR_FAMILIES.includes(v.family as Placement["family"])) throw new LedgerError("invalid", "位置要带合法的 family");
  return { family: v.family as Placement["family"], machine: str(v.machine, "位置的 machine") };
}

function placements(v: unknown): Placement[] {
  if (!Array.isArray(v) || !v.length || v.length > 8) throw new LedgerError("invalid", "authorized 要是 1..8 个位置");
  return v.map(placement);
}

function outcomeInput(intentId: string, d: Record<string, unknown>): OutcomeWrite {
  const f = d.failure, failed = d.failed;
  if (!obj(f) || !["error", "quota", "auth"].includes(String(f.kind)) || typeof f.message !== "string") throw new LedgerError("invalid", "failure 要带 kind / message");
  if (!obj(failed)) throw new LedgerError("invalid", "缺 failed");
  const review = d.review === undefined ? undefined : obj(d.review) ? { sessionId: str(d.review.sessionId, "review.sessionId") } : null;
  if (review === null) throw new LedgerError("invalid", "review 要是对象");
  return { intentId, failure: { kind: f.kind as OutcomeWrite["failure"]["kind"], message: f.message.slice(0, 4000) },
    failed: { ...placement(failed), agent: str(failed.agent, "failed.agent") }, authorized: placements(d.authorized), ...(review ? { review } : {}) };
}

/** Scheduler identity only (the gate in manager/ledger.ts admits it; this re-checks), and a non-ledger failure is write_failed. */
function schedulerOnly(run: (c: LedgerCli) => Promise<Record<string, unknown>> | Record<string, unknown>): CommandSpec["run"] {
  return async (c) => {
    if (c.deps.actor !== "scheduler") throw new LedgerError("forbidden", "拒审接续的写口只给调度服务");
    try { return await run(c); } catch (e) {
      if (e instanceof LedgerError) throw e;
      return { ok: false, code: "write_failed", error: (e as Error).message };
    }
  };
}

export const MODEL_CMDS: Record<string, CommandSpec> = {
  "scheduler-review-snapshot": {
    valued: ["round", "data"], bools: [],
    usage: "scheduler-review-snapshot <intent> --round N --data {order}（调度服务专用：待派审查单的材料快照，事务内重核 head / specRev / 轮次 / 绑定；按单去重）",
    run: schedulerOnly((c) => {
      const round = intFlag(c.p, "round");
      if (round === undefined || round < 0) throw new LedgerError("invalid", "要带 --round 非负整数");
      const r = writeReviewSnapshot(c.db, c.ctx(), c.p.pos[1] ?? "", str(data(c).order, "order", 400_000), round);
      return { ok: true, duplicate: r.duplicate, seq: r.event.seq };
    }),
  },
  "scheduler-model-outcome": {
    valued: ["data"], bools: [],
    usage: "scheduler-model-outcome <intent> --data {failure, failed, authorized, review?}（调度服务专用：MODEL 记模型结果，事务内重读批准 / 快照；按意图去重）",
    run: schedulerOnly(async (c) => ({ ok: true, record: await writeModelOutcome(c.db, c.ctx(), outcomeInput(c.p.pos[1] ?? "", data(c))) })),
  },
  "scheduler-refusal-epoch": {
    valued: ["plan-seq", "data"], bools: [],
    usage: "scheduler-refusal-epoch <task> --plan-seq N --data {authorized}（调度服务专用：按 MODEL 计划开豁免审查 epoch，事务内重核全部前提；按计划去重）",
    run: schedulerOnly((c) => {
      const seq = intFlag(c.p, "plan-seq");
      if (seq === undefined || seq < 1) throw new LedgerError("invalid", "要带 --plan-seq 正整数");
      const r = writeRefusalEpoch(c.db, c.ctx(), c.p.pos[1] ?? "", seq, placements(data(c).authorized));
      return { ok: true, duplicate: r.duplicate, event: r.event };
    }),
  },
  "scheduler-model-inform": {
    valued: ["key", "text", "data"], bools: [],
    usage: "scheduler-model-inform <task> --key K --text T --data {op, …}（调度服务专用：拒审告知 / 写口不可用，每键一次）",
    run: schedulerOnly((c) => {
      const r = writeModelNote(c.db, c.ctx(), c.p.pos[1] ?? "", c.need("key"), c.need("text"), data(c));
      return { ok: true, duplicate: r.duplicate, seq: r.event.seq };
    }),
  },
  "scheduler-legacy-review-retire": {
    valued: ["intent", "data"], bools: [],
    usage: "scheduler-legacy-review-retire <task> --intent I --data {evidence}（调度服务专用：on 下无材料快照的旧拒审单，事务内重核后退休旧审查绑定、不豁免；按单去重）",
    run: schedulerOnly(async (c) => {
      const r = await writeLegacyReviewRetire(c.db, c.ctx(), c.p.pos[1] ?? "", c.need("intent"), str(data(c).evidence, "evidence", 4000));
      return { ok: true, duplicate: r.duplicate, event: r.event };
    }),
  },
};
