import type { Database } from "bun:sqlite";
import { DEPLOY_IN_FLIGHT } from "./ledger-deploy-schema.js";
import type { RecoveryMode, RecoveryPolicyPort } from "./recovery-policy.js";
import { maintenanceRequested } from "./scheduler-yield.js";

/**
 * DEPLOYFIRST1: a deploy (or update) waits for this pass's maintenance lease, and the pass stops between cards for it, but not
 * between steps: on 10-13 a deploy submitted mid-pass sat ~87 s through supervise / resume / lifecycle / lend, then ran in ~10 s
 * and restarted the scheduler anyway. With deployFirst on, once one is waiting no further step starts; the next pass runs them.
 * A deploy this pass submitted counts at once (its job takes a second or two to boot and leave the request). observe only logs.
 * The pass serves every project, so the strongest mode among them applies. tests/scheduler-deploy-first.test.ts.
 */
export interface DeployYield {
  readonly mode: RecoveryMode;
  /** True when the rest of the pass should be left to the next one (on and something waits); observe notes the first sighting. */
  stop(): boolean;
  /** The end-of-pass remark, null when nothing waited this pass. */
  note(): string | null;
}

const RANK: Record<RecoveryMode, number> = { off: 0, observe: 1, on: 2 };

export function deployYield(db: Database | null, since: number, projects: readonly string[], policy: RecoveryPolicyPort,
  request?: string, now: () => number = Date.now): DeployYield {
  const mode = projects.map((p) => policy(p, "deployFirst").mode).reduce<RecoveryMode>((a, m) => (RANK[m] > RANK[a] ? m : a), "off");
  let seen: number | null = null;
  const waiting = () => maintenanceRequested(request, now()) || submittedSince(db, since);
  return {
    mode,
    stop: () => {
      if (mode === "off" || !(seen !== null || waiting())) return false;
      seen ??= now();
      return mode === "on";
    },
    note: () => {
      if (seen === null) return null;
      const at = Math.round((seen - since) / 1000), rest = Math.round((now() - seen) / 1000);
      return mode === "on" ? `部署 / 更新在等锁，本轮第 ${at}s 起没再开新步骤`
        : `observe：部署 / 更新第 ${at}s 起在等锁，之后的步骤又跑了 ${rest}s（on 时这段留给下一轮）`;
    },
  };
}

/** A deploy job claimed or submitted since the pass began: still booting, or already waiting for this pass's lease. */
export function submittedSince(db: Database | null, since: number): boolean {
  if (!db?.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduler_deploys'").get()) return false;
  return db.query(`SELECT 1 FROM scheduler_deploys WHERE phase IN (${DEPLOY_IN_FLIGHT.map(() => "?").join(",")}) AND createdAt >= ?`)
    .get(...DEPLOY_IN_FLIGHT, since) !== null;
}

/** One line per pass in scheduler.out: total seconds and every step of half a second or more, in order. */
export function passClock(now: () => number = Date.now) {
  const start = now();
  let last = start;
  const parts: string[] = [];
  return {
    start,
    mark(name: string): void {
      const t = now(), s = (t - last) / 1000;
      if (s >= 0.5) parts.push(`${name} ${s.toFixed(1)}`);
      last = t;
    },
    line(note: string | null): string {
      return `[pass] ${Math.round((now() - start) / 1000)}s：${parts.join(" / ") || "每步都不到 0.5s"}${note ? `；${note}` : ""}`;
    },
  };
}
