/**
 * Ledger side of the merge train's re-run of a red car (merge-arch-CLASS1; driver: scheduler-train-ci-rerun.ts), recovery key
 * ciTrainFailureClass (absent = observe).
 * - The budget is CIF1's (scheduler-merge-ci-rerun.ts ciRerunSpent): one automatic re-run per card head, whoever spends it. A car's
 *   claim writes one note per member (target = the card, `prHead` = its head) in one immediate transaction, and only when no
 *   member's head was spent before, by the serial gate or by any earlier car. So a restart, a second process, or a train voided and
 *   formed again from the same heads finds the budget spent and never re-runs twice; the serial gate then bounces such a head too.
 * - A known flaky claim is judged against the valid list (ci-known-flaky.ts) inside that same transaction: an entry whose fixing
 *   node is verified, cancelled or gone no longer counts, from that moment on.
 * - The claim is the only durable state: the car it belongs to, the run and the attempt it saw. The train's state file holds nothing.
 * tests/scheduler-train-ci-rerun.test.ts.
 */
import type { Database } from "bun:sqlite";
import { activeKnownFlaky } from "./ci-known-flaky.js";
import { appendEvent } from "./ledger-write.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { ciRerunSpent, TRAIN_RERUN_OP } from "./scheduler-merge-ci-rerun.js";

export type RerunKind = "timeout" | "known_flaky" | "env";
export interface RerunMember { taskId: string; head: string }
interface TrainRerunClaim {
  project: string; train: string; car: string; base: string; members: RerunMember[];
  /** The car's own Actions run and the attempt that was red. */
  run: string; attempt: number; kind: RerunKind; files: string[]; reason: string;
}
/** What a car's claim recorded; `content` = contentKey at the claim, `ts` = when it was written. */
export interface TrainRerunRecord { ts: number; run: string; attempt: number; kind: RerunKind; content: string }
type ClaimResult = "claimed" | "spent" | "unlisted";

/** What a car tested: main's base and every member's head. Evidence for other content proves nothing about this car. */
export const contentKey = (base: string, members: readonly RerunMember[]): string =>
  [base, ...members.map((m) => `${m.taskId}:${m.head}`).sort()].join("|").toLowerCase();

/** The first member whose head already had its one automatic re-run (serial or train), or null. */
function spentMember(db: Database, members: readonly RerunMember[]): string | null {
  return members.find((m) => ciRerunSpent(db, m.taskId, m.head))?.taskId ?? null;
}

/** `file（feature/node）` of every file when all are on the valid known flaky list right now; null when any is not. */
function listedFlaky(db: Database, project: string, files: readonly string[]): string[] | null {
  const list = activeKnownFlaky(db, project);
  const hits = files.map((f) => list.get(f));
  return files.length && hits.every((e) => !!e) ? hits.map((e) => `${e!.file}（${e!.featureId}/${e!.node}）`) : null;
}

/** The claim: budget and list are checked and every member's note written in one immediate transaction, or nothing is. */
function claimTrainRerun(db: Database, c: TrainRerunClaim, now: number): ClaimResult {
  return db.transaction((): ClaimResult => {
    if (spentMember(db, c.members)) return "spent";
    if (c.kind === "known_flaky" && !listedFlaky(db, c.project, c.files)) return "unlisted";
    const content = contentKey(c.base, c.members);
    for (const m of c.members) {
      appendEvent(db, { actor: "scheduler", now, dedupKey: `merge-train-ci-rerun:${m.taskId}:${m.head.toLowerCase()}` }, {
        project: c.project, target: m.taskId, kind: "note",
        text: `合并列车：车厢 ${c.car}（列车 ${c.train}）CI 红判为${KIND_TEXT[c.kind]}，自动重跑一次 ${c.run}`.slice(0, 600),
        data: { op: TRAIN_RERUN_OP, prHead: m.head, run: c.run, attempt: c.attempt, train: c.train, car: c.car, class: c.kind, files: c.files,
          reason: c.reason, content, members: c.members.map((x) => x.taskId) },
      });
    }
    return "claimed";
  }).immediate();
}
export const KIND_TEXT: Record<RerunKind, string> = { timeout: "没碰的测试超时", known_flaky: "已知偶发测试", env: "环境故障" };

/** The claim a car of a train made, if any (any of its member notes carries it). */
function trainRerunOf(db: Database, project: string, train: string, car: string): TrainRerunRecord | null {
  const r = db.query(`SELECT ts, data FROM events WHERE project=? AND kind='note' AND actor='scheduler' AND json_extract(data,'$.op')=?
    AND json_extract(data,'$.train')=? AND json_extract(data,'$.car')=? ORDER BY seq LIMIT 1`).get(project, TRAIN_RERUN_OP, train, car) as
    { ts: number; data: string } | null;
  if (!r) return null;
  const d = JSON.parse(r.data) as { run?: unknown; attempt?: unknown; class?: unknown; content?: unknown };
  if (typeof d.run !== "string" || !Number.isSafeInteger(d.attempt) || typeof d.content !== "string" || !(String(d.class) in KIND_TEXT)) {
    throw new Error(`列车 ${train} 车厢 ${car} 的重跑记录读不懂`);
  }
  return { ts: r.ts, run: d.run, attempt: d.attempt as number, kind: d.class as RerunKind, content: d.content };
}

/** What the driver asks of the ledger and the policy; the tick builds it with its ledger handle, tests pass their own. */
export interface TrainCiClassPort {
  mode(project: string): RecoveryMode;
  /** observe: one deduped note per train car saying what on would do. */
  observe(project: string, train: string, car: string, action: string, data: Record<string, unknown>): void;
  listed(project: string, files: readonly string[]): string[] | null;
  spent(members: readonly RerunMember[]): string | null;
  claim(c: TrainRerunClaim): ClaimResult;
  claimOf(project: string, train: string, car: string): TrainRerunRecord | null;
}

/** The production port: the policy is read every call (bad file = off). */
export function trainCiClassPort(db: Database, now: () => number, policy: RecoveryPolicyPort = recoveryPolicy): TrainCiClassPort {
  return {
    mode: (project) => policy(project, "ciTrainFailureClass").mode,
    observe: (project, train, car, action, data) => {
      recordObserved(db, { project, mechanism: "ciTrainFailureClass", target: "", actionKey: `train-class:${train}:${car}`, action, data }, now());
    },
    listed: (project, files) => listedFlaky(db, project, files),
    spent: (members) => spentMember(db, members),
    claim: (c) => claimTrainRerun(db, c, now()),
    claimOf: (project, train, car) => trainRerunOf(db, project, train, car),
  };
}
