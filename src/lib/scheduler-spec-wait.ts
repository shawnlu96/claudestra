/**
 * 缺规格提醒（team-project-PMWAKE §3）：自动开卡 tick 每轮调一次。feature 过 featureGate（容量门不算：写规格不占名额）、节点在 startNow 且过节点门、
 * 规格卡读不到（刚改过 / 卡首关不算缺）→ 给 featurePm 发「[待写规格] …」。节流与去重在台账（scheduler-spec-wait-ledger.ts）：
 * 同一 (feature, 节点, DAG 版本) 首次立即发、仍缺每 30 分钟再发；规格到位、节点不再就绪、feature 关掉后自然不再发。
 * 记录直接在 env.db 上以调度身份、带 dedup 键的事务写（不走 ledger CLI）：自动开卡「没有候选就一个外部调用都没有」的约定不破，observe 也能缺省开着。
 * 项目开关 autostart.specWait：on 发；observe（缺省）只写记录不发；off 什么都不做。私仓节点（fileGlobs 含 repo:）照发，正文带手动开卡说明。
 * tests/scheduler-spec-wait.test.ts。
 */
import type { Database } from "bun:sqlite";
import { featureLanes } from "./dag-tools-lanes.js";
import { cardNames } from "./ledger-card-names.js";
import { notifyProjectPm } from "./pm-notify.js";
import { recordSpecWait } from "./scheduler-spec-wait-ledger.js";
import {
  activeFeatures, currentViews, featureGate, featurePm, isStop, nodeCandidate, readSwitch, type ServiceFacts, type SpecFile,
} from "./scheduler-autostart.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

type Failed = { taskId: string; error: string }[];

export interface SpecWaitEnv {
  db: Database;
  svc: ServiceFacts;
  readSpec(taskId: string): SpecFile | null;
  now(): number;
  /** 发送：缺省经 bridge 发给指定 PM（notifyProjectPm 的 to）；测试替换 */
  specWaitSend?(db: Database, project: string, to: string, text: string): Promise<void>;
}

const bridgeSend = (db: Database, project: string, to: string, text: string) => notifyProjectPm(db, project, text, { fromName: "scheduler", to });

export async function specWaitTick(env: SpecWaitEnv): Promise<Failed> {
  const failed: Failed = [];
  try {
    for (const project of [...env.svc.projects].sort()) {
      const mode = readSwitch(env.db, project).specWait ?? "observe";
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
          const rec = recordSpecWait(env.db, { actor: "scheduler", now: env.now() }, { featureId: f.id, key, version: f.currentVersion, mode, pm, text });
          if (!rec.due || mode !== "on") continue;
          try {
            await (env.specWaitSend ?? bridgeSend)(env.db, project, pm, text);
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
