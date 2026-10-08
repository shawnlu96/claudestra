/**
 * 上线后 PM 提醒（team-project-PMWAKE2）：自动开卡 tick 每轮紧跟缺规格提醒调一次。本项目里 stage=verified、正式规格卡有一级小节 `## 上线后 PM`、
 * 台账里还没有 `post-verify-done:<卡>` 的卡 → 给 featurePm（未设 / 卡不属于 feature → 项目当班 PM）发「[上线后待办] …」；
 * verified 后首轮立即发，仍未结每 30 分钟再发；verified 超过 72 小时 → 只给项目当班 PM 发一条超时，确认发出（记 overdue-sent）后停，发送失败下个窗口重发。
 * 节流、去重与正文都在台账 writer（scheduler-post-verify-ledger.ts，经调度身份的 `ledger scheduler-autostart post-verify`），扛得过调度服务重启；
 * 这里只按只读快照预筛，免得每轮对每张卡都起一次 CLI。开关与发送复用缺规格提醒（autostart.specWait：on 发 / observe 只记 / off 不做）。
 * tests/scheduler-post-verify.test.ts。
 */
import { listTasks, getEventByDedup } from "./ledger-store.js";
import {
  postVerifyDoneKey, postVerifyDue, postVerifyKind, postVerifySection, postVerifyTarget,
} from "./scheduler-post-verify-ledger.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { sendToPm, specWaitMode, type SpecWaitEnv } from "./scheduler-spec-wait.js";

type Failed = { taskId: string; error: string }[];

export async function postVerifyTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  try {
    for (const project of [...env.svc.projects].sort()) {
      const mode = specWaitMode(env.db, project);
      if (mode === "off") continue;
      for (const t of listTasks(env.db, project)) {
        if (t.stage !== "verified" || getEventByDedup(env.db, postVerifyDoneKey(t.id))) continue;
        const now = env.now();
        const kind = postVerifyKind(env.db, t, now);
        if (!postVerifyDue(env.db, t.id, kind, mode, now)) continue;
        if (!postVerifySection(env.readSpec(t.id)?.text)) continue;
        const pm = postVerifyTarget(env.db, t, kind);
        if (!pm) continue;
        const rec = await env.ledger("ledger", "scheduler-autostart", "post-verify", t.id, kind, "--mode", mode, "--pm", pm);
        if (rec.code === "lease-lost") throw new SchedulerStopped(`ledger post-verify: ${String(rec.error)}`);
        if (rec.code === "conflict") continue; // 读快照到写之间条件变了：下一轮按新状态重判
        if (rec.ok !== true) {
          failed.push({ taskId: t.id, error: `上线后提醒记账失败：${String(rec.error ?? rec.code)}` });
          continue;
        }
        if (rec.due !== true || mode !== "on") continue;
        try {
          await sendToPm(env, project, String(rec.to), String(rec.text));
        } catch (e) {
          // overdue 没写终结记录：下个 30 分钟窗口按发送意图重发，直到送达
          if (e instanceof SchedulerStopped) throw e;
          failed.push({ taskId: t.id, error: `上线后提醒发给 ${String(rec.to)} 失败：${(e as Error).message}` });
          continue;
        }
        if (kind !== "overdue") continue;
        const ack = await env.ledger("ledger", "scheduler-autostart", "post-verify", t.id, "overdue-sent", "--mode", mode, "--pm", pm);
        if (ack.code === "lease-lost") throw new SchedulerStopped(`ledger post-verify: ${String(ack.error)}`);
        if (ack.ok !== true && ack.code !== "conflict") failed.push({ taskId: t.id, error: `超时提醒已发、记已发失败：${String(ack.error ?? ack.code)}` });
      }
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "post-verify", error: (e as Error).message });
  }
  return failed;
}
