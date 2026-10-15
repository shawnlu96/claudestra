import { schedulerV2SkipTask, schedulerV2SkipFeature } from "./scheduler-v2-skip.js";
import type { StallClaim } from "./ledger-priority-stall-store.js";
import { livePriorityStallClaim, priorityStallRevision, priorityStallDue } from "./ledger-priority-stall-store.js";
import type { Database } from "bun:sqlite";
import type { SchedulerConfig } from "./scheduler-config.js";
import { readPriorityModes } from "./ledger-priority-read.js";
import { priorityStallBases } from "./ledger-priority-stall-read.js";
import { stallNotice } from "./ledger-priority-stall.js";
import type { StallCommand } from "./ledger-priority-stall-command.js";
import { notifyProjectPm } from "./pm-notify.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

interface Ports {
  manager(...args: string[]): Promise<Record<string, unknown>>;
  active(): void;
  notify?(claim: StallClaim, text: string): Promise<void>;
  now?(): number;
}

/** All business writes go through manager; an off project is never scanned for cards or asks. */
export async function priorityStallTick(db: Database, config: SchedulerConfig, ports: Ports): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  for (const project of Object.keys(config.projects)) {
    if (readPriorityModes(db, project).priorityStall.mode === "off") continue;
    for (const b of priorityStallBases(db, project).filter((b) => priorityStallDue(db, b, ports.now?.() ?? Date.now()))) {
      if (b.taskId ? schedulerV2SkipTask(db, b.taskId) : b.featureId && schedulerV2SkipFeature(db, b.featureId)) continue;
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
          const checked = await command({ ...data, op: "check" });
          if (!checked.claim) break;
          const fresh = checked.claim as StallClaim;
          if (!fresh.basis.pm) {
            await command({ ...data, op: "finish", result: "failed", detail: "没有负责 PM" });
            break;
          }
          try {
            ports.active();
            const text = stallNotice(fresh.basis, fresh.cycle, ports.now?.() ?? Date.now());
            if (ports.notify) await ports.notify(fresh, text);
            else await notifyProjectPm(db, project, text, { fromName: "scheduler", to: fresh.basis.pm, level: "action",
              stillActive: () => { ports.active(); return !!livePriorityStallClaim(db, project, b.key, fresh.token); } });
          } catch (e) {
            if (e instanceof SchedulerStopped) throw e;
            await command({ ...data, op: "finish", result: "unknown", detail: String(e) });
            break;
          }
          // Receipt failures leave the send pending/unknown; they never authorize another delivery.
          await command({ ...data, op: "finish", result: "success", detail: `已通知 ${fresh.basis.pm}` });
          break;
        }
      } catch (e) {
        if (e instanceof SchedulerStopped) throw e;
        failed.push({ taskId: b.taskId ?? b.key, error: String(e) });
      }
    }
  }
  return failed;
}
