import { schedulerV2SkipTask, schedulerV2SkipFeature } from "./scheduler-v2-skip.js";
import type { StallClaim } from "./ledger-priority-stall-store.js";
import { priorityStallRevision, priorityStallDue } from "./ledger-priority-stall-store.js";
import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import { priorityStallBases } from "./ledger-priority-stall-read.js";
import type { StallCommand } from "./ledger-priority-stall-command.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { RecoveryPolicyPort } from "./recovery-policy.js";
import { cursorKey, keepBudgetTail, keepStoppedTail, takeCursor } from "./priority-stall-cursor.js";

interface Ports {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  active(): void;
  now?(): number;
  budgetMs?: number;
  /** priorityStallCursor switch (tests inject); absent = recovery-policy.json */
  recovery?: RecoveryPolicyPort;
}

const PRIORITY_STALL_BUDGET_MS = 60_000;

/** All business writes go through manager; an off project is never scanned for cards or asks. Nothing is pushed to the PM. */
export async function priorityStallTick(db: Database, config: SchedulerConfig, ports: Ports): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  const clock = ports.now ?? (() => performance.now()), started = clock();
  const budgetMs = ports.budgetMs ?? PRIORITY_STALL_BUDGET_MS;
  const due = new Map(Object.keys(config.projects).flatMap((project) => {
    if (readPriorityModes(db, project).priorityStall.mode === "off") return [];
    const now = ports.now?.() ?? Date.now();
    return priorityStallBases(db, project, undefined, now).filter((b) => priorityStallDue(db, b, now))
      .map((b) => [cursorKey(project, b.key), b] as const);
  }));
  const keys = takeCursor(db, new Set(due.keys()));
  let processed = 0;
  for (let index = 0; index < keys.length; index++) {
    // Always finish one target; even a single slow command must not starve the tail forever.
    if (processed > 0 && clock() - started >= budgetMs) {
      keepBudgetTail(db, keys.slice(index));
      console.log(`[priority-stall] budget exhausted: processed=${processed} remaining=${keys.length - index}`);
      break;
    }
    const b = due.get(keys[index])!, project = b.project;
    if (b.taskId ? schedulerV2SkipTask(db, b.taskId) : b.featureId && schedulerV2SkipFeature(db, b.featureId)) continue;
    processed++;
    try {
      const command = async (data: StallCommand) => {
        ports.active();
        const r = await ports.manager("ledger", "scheduler-priority-stall", b.taskId ?? "-", "--project", project,
          "--data", JSON.stringify(data), "--dedup", `priority-stall:${crypto.randomUUID()}`, "--rev", String(priorityStallRevision(db, project, b.key)));
        ports.active();
        if (!r.ok) throw new Error(String(r.error ?? "停滞命令失败"));
        return r;
      };
      // At most heal then PM in this tick; no historical burst through all three stages.
      for (let pass = 0; pass < 2; pass++) {
        const r = await command({ op: "claim", key: b.key });
        const claim = (r.claims as StallClaim[] | undefined)?.[0];
        if (!claim) break;
        const data = { key: b.key, token: claim.token };
        if (claim.mode === "observe") {
          if (claim.action === "heal") await command({ ...data, op: "heal" });
          else await command({ ...data, op: "finish", result: "success", detail: `本会${claim.action}：${claim.basis.why}` });
          break;
        }
        if (claim.action === "heal") { await command({ ...data, op: "heal" }); continue; }
        if (claim.action === "owner") { await command({ ...data, op: "owner" }); break; }
        // The reminder is a note on the card, written and finished in the writer's transaction; the PM pulls it when needed.
        await command({ ...data, op: "note" });
        break;
      }
    } catch (e) {
      if (e instanceof SchedulerStopped) {
        // Stopped inside this target: it and the tail are unfinished; targets before it are done and stay behind.
        keepStoppedTail(db, keys.slice(index).map((key) => {
          const t = due.get(key)!;
          return { key, project: t.project, taskId: t.taskId, rev: () => priorityStallRevision(db, t.project, t.key) };
        }), { policy: ports.recovery, now: ports.now?.() });
        throw e;
      }
      failed.push({ taskId: b.taskId ?? b.key, error: String(e) });
    }
  }
  return failed;
}
