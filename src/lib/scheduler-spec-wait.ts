/**
 * 缺规格提醒（team-project-PMWAKE §3）：自动开卡 tick 每轮调一次。feature 过 featureGate（容量门不算：写规格不占名额）、节点在 startNow 且过节点门、
 * 规格卡读不到（刚改过 / 卡首关不算缺）→ 给 featurePm 发「[待写规格] …」。节流与去重在台账（scheduler-spec-wait-ledger.ts）：
 * 同一 (feature, 节点, DAG 版本) 首次立即发、仍缺每 30 分钟再发；规格到位、节点不再就绪、feature 关掉后自然不再发。
 * 记录经 env.ledger（调度身份、带租约守卫的 ledger CLI：`scheduler-autostart spec-wait`）写：调度服务的 env.db 是只读连接（LedgerReader，query_only）。
 * 写前在台账事务里重算全部门（只豁免容量）并核对 featurePm 仍是预读那位，不符回 conflict、下轮重判。发送走本轮 notifyPm（带存活检查）。
 * 台账回 due:false（30 分钟内已记过）就不发；租约丢了 → SchedulerStopped；单个节点写失败只记这一条，其余 feature / 节点照常处理。
 * 项目开关 autostart.specWait：on 发；observe（缺省）只写记录不发；off 什么都不做。私仓节点（fileGlobs 含 repo:）照发，正文带手动开卡说明。
 * tests/scheduler-spec-wait.test.ts。
 */
import type { Database } from "bun:sqlite";
import { featureLanes } from "./dag-tools-lanes.js";
import { cardNames } from "./ledger-card-names.js";
import { pmNotifyTarget } from "./pm-notify.js";
import {
  activeFeatures, currentViews, featureGate, featurePm, isStop, nodeCandidate, readSwitch, type ServiceFacts, type SpecFile,
} from "./scheduler-autostart.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type Failed = { taskId: string; error: string }[];

export interface SpecWaitEnv {
  db: Database;
  /** 调度身份的 ledger CLI（已套租约守卫） */
  ledger(...args: string[]): Promise<Record<string, unknown>>;
  svc: ServiceFacts;
  readSpec(taskId: string): SpecFile | null;
  now(): number;
  /** 这一轮的 PM 通知（生产 = notifyProjectPm 带本轮 stillActive：bridge 发帧的同一同步段核存活，停服 / 失租时什么都不发） */
  notifyPm(project: string, text: string): Promise<void>;
  /** 发送：缺省走 notifyPm、目标经 pmNotifyTarget 换成 featurePm；测试替换 */
  specWaitSend?(db: Database, project: string, to: string, text: string): Promise<void>;
}

/** 也给上线后 PM 提醒（scheduler-post-verify.ts）用 */
export const sendToPm = (env: SpecWaitEnv, project: string, to: string, text: string) =>
  env.specWaitSend ? env.specWaitSend(env.db, project, to, text) : pmNotifyTarget.run(to, () => env.notifyPm(project, text));

/** 项目级开关 autostart.specWait（缺省 observe）；上线后 PM 提醒共用 */
export const specWaitMode = (db: Database, project: string): "on" | "observe" | "off" => readSwitch(db, project).specWait ?? "observe";

export async function specWaitTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  try {
    for (const project of [...env.svc.projects].sort()) {
      const mode = specWaitMode(env.db, project);
      if (mode === "off") continue;
      for (const f of activeFeatures(env.db, project)) {
        const g = featureGate(env.db, f, env.svc);
        const pm = featurePm(env.db, f.id);
        if ((g && g.gate !== "capacity") || !pm) continue;
        const lanes = featureLanes(env.db, f);
        const views = currentViews(env.db, f);
        for (const key of lanes?.startNow ?? []) {
          const node = views.find((n) => n.key === key);
          const r = node && nodeCandidate(env.db, f, key, lanes, views, (id) => env.readSpec(id), env.now());
          if (!node || !r || !isStop(r) || r.gate !== "spec") continue;
          const { taskId } = cardNames(env.db, f, key, node);
          if (env.readSpec(taskId)) continue;
          const repo = (node.fileGlobs ?? []).some((x) => x.startsWith("repo:")) ? "（私仓节点：规格放好后手动开卡）" : "";
          const text = `[待写规格] ${f.title} 的节点 ${key}（${node.oneLine || key}）依赖已满足，可以开工，缺规格卡 ${taskId}.md；放好后调度器自动开卡。${repo}`;
          const rec = await env.ledger("ledger", "scheduler-autostart", "spec-wait", f.id, key, "--version", String(f.currentVersion), "--mode", mode, "--pm", pm, "--text", text);
          if (rec.code === "lease-lost") throw new SchedulerStopped(`ledger spec-wait: ${String(rec.error)}`);
          if (rec.code === "conflict") continue; // 读快照到写之间条件变了：下一轮按新状态重判
          if (rec.ok !== true) {
            failed.push({ taskId: `${f.id}/${key}`, error: `缺规格提醒记账失败：${String(rec.error ?? rec.code)}` });
            continue;
          }
          if (rec.due !== true || mode !== "on") continue;
          try {
            await sendToPm(env, project, pm, text);
          } catch (e) {
            if (e instanceof SchedulerStopped) throw e;
            failed.push({ taskId: `${f.id}/${key}`, error: `缺规格提醒发给 ${pm} 失败：${(e as Error).message}` });
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    failed.push({ taskId: "spec-wait", error: (e as Error).message });
  }
  return failed;
}
