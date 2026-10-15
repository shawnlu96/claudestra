/** Narrow scheduler-only ledger port. Configuration and private results are reread locally, never supplied as CLI payloads. */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { getDeployRun } from "./scheduler-deploy.js";
import { deployJobDir } from "./scheduler-deploy-lock-jobs.js";
import { readJsonStateSync } from "./state-file.js";
import { centerCardKeys, centerCards } from "./center-deploy-candidates.js";
import { readCenterDeployConfig } from "./center-deploy-config.js";
import { centerConfigVersion, centerProof } from "./center-deploy-proof.js";
import { openCenterDeployAsk } from "./center-deploy-asks.js";
import { readCenterState } from "./center-deploy-state.js";
import { recoveryPolicy, recordObserved } from "./recovery-policy.js";
import { appendEvent, type WriteCtx } from "./ledger-write.js";
import { LedgerError } from "./ledger-store.js";

interface CenterCli {
  db: Database; deps: { actor: string; assertLease?: () => void }; p: { pos: string[]; flags: Record<string, string | undefined> };
  task(id: string | undefined): LedgerTask; need(flag: string): string; ctx(): WriteCtx;
}
function machine(c: CenterCli, task: LedgerTask) {
  const intent = c.need("intent"), run = getDeployRun(c.db, intent);
  if (!run || run.taskId !== task.id) throw new LedgerError("invalid", "部署记录不匹配");
  const raw = readJsonStateSync(`${deployJobDir(run)}.machine-events.json`);
  if (raw.status !== "ok" || !Array.isArray(raw.data)) return { ok: true };
  for (const [i, sample] of raw.data.entries()) {
    const s = sample as { status: unknown; label: unknown; at: unknown };
    if (!["acquired", "deferred"].includes(String(s.status)) || typeof s.label !== "string" || !/^[\w.:-]{1,64}$/.test(s.label)) continue;
    appendEvent(c.db, { ...c.ctx(), dedupKey: `machine-deploy:${intent}:${i}` }, { project: task.project, target: task.id,
      kind: "note", text: `整机部署锁 ${s.status}：${s.label}`, data: { op: "deploy_machine_lock", status: s.status, label: s.label } });
  }
  return { ok: true };
}
function result(c: CenterCli, task: LedgerTask) {
  const s = readCenterState(task.project), r = s.result;
  if (!s.proof?.cards.includes(task.id) || !s.run || !r || !["success", "failed"].includes(r.status)
    || !Number.isFinite(r.ms) || typeof r.dryRun !== "boolean" || !(r.code === null || Number.isInteger(r.code))) throw new LedgerError("invalid", "中心部署结果无效");
  const raw = readJsonStateSync(`${deployJobDir(s.run)}/result.json`);
  const phases = raw.status === "ok" ? (raw.data as { phases?: unknown }).phases : undefined;
  const records = Array.isArray(phases) && phases.length ? phases : [r];
  for (const [i, phase] of records.entries()) {
    const p = phase as typeof r;
    if (!p || !(p.code === null || Number.isInteger(p.code)) || !Number.isFinite(p.ms) || typeof p.dryRun !== "boolean") continue;
    appendEvent(c.db, { ...c.ctx(), dedupKey: `center-deploy-result:${s.run.intentId}:${i}` }, { project: task.project, target: task.id, kind: "note",
    text: `中心部署 ${s.proof.sha.slice(0, 12)} exit ${p.code ?? "null"}`,
    data: { op: !p.dryRun && r.status === "success" ? "center_deploy" : "center_deploy_attempt", sha: s.proof.sha, code: p.code, ms: p.ms, dryRun: p.dryRun } });
  }
  return { ok: true };
}
export const CENTER_DEPLOY_COMMANDS = {
  "scheduler-center-deploy": {
    valued: ["op", "intent"], bools: [], usage: "scheduler-center-deploy <task> --op open|observe|result|machine [--intent I]",
    async run(c: CenterCli) {
      if (c.deps.actor !== "scheduler" || !c.deps.assertLease) throw new LedgerError("forbidden", "中心部署写口只给持租约的调度身份");
      c.deps.assertLease();
      const task = c.task(c.p.pos[1]), op = c.need("op"), now = c.ctx().now ?? Date.now();
      if (op === "machine") return machine(c, task);
      const policy = recoveryPolicy(task.project, "centerDeployAuto");
      if (policy.mode === "off") throw new LedgerError("forbidden", "中心部署已关闭");
      if (op === "result") return result(c, task);
      const cfg = readCenterDeployConfig()?.[task.project];
      if (!cfg) throw new LedgerError("invalid", "中心部署未配置");
      const s = readCenterState(task.project);
      const cardKeys = centerCardKeys(c.db, task.project, cfg.repo);
      const cards = centerCards(c.db, task.project, cfg.repo, s.successfulCards);
      const pending = cards.length ? cards : s.proof?.cards ?? [];
      if (!pending.includes(task.id)) throw new LedgerError("invalid", "没有已合并的中心部署卡");
      const proof = await centerProof(task.project, cfg, pending);
      if (s.proof?.sha === proof.sha) proof.cards = s.proof.cards;
      c.deps.assertLease();
      if (op === "observe" && policy.mode === "observe") {
        return { ok: true, ...recordObserved(c.db, { project: task.project, mechanism: "centerDeployAuto", target: task.id,
          actionKey: proof.sha, action: `为 ${proof.sha.slice(0, 12)} 开授权卡` }, now) };
      }
      if (op !== "open" || recoveryPolicy(task.project, "centerDeployAuto").mode !== "on") throw new LedgerError("forbidden", "中心部署没有开卡权限");
      return { ok: true, ask: openCenterDeployAsk(c.db, proof, centerConfigVersion(cfg), now), proof, cardKeys: s.proof?.sha === proof.sha ? s.cardKeys ?? cardKeys : cardKeys };
    },
  },
};
