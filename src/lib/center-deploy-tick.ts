/** The read-only pass orchestrates authorization and launchd; ledger writes go through the leased CLI port. */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { deploymentJobs, type DeployJobs } from "./scheduler-deploy-job.js";
import type { SchedulerConfig } from "./scheduler-config.js";
import type { DeployRun } from "./scheduler-deploy.js";
import { repoDirFor } from "./card-repo.js";
import { centerCardKeys, centerCards } from "./center-deploy-candidates.js";
import { readCenterDeployConfig, type CenterDeployConfig } from "./center-deploy-config.js";
import { centerConfigVersion, centerProof, type CenterProof } from "./center-deploy-proof.js";
import { readCenterState, writeCenterState, type CenterState } from "./center-deploy-state.js";
import { readJsonStateSync } from "./state-file.js";
import { deployJobDir } from "./scheduler-deploy-lock-jobs.js";
import { recoveryPolicy, type RecoveryPolicyPort } from "./recovery-policy.js";
import { bindHash, canonicalJson, checkAsk } from "./ask-bind.js";
import { getAsk, ownerAnswered, type Ask } from "./ledger-asks.js";
import { getEventByDedup, listTasks } from "./ledger-store.js";
import { cardRepo, projectRepo } from "./scheduler-foreign-repo.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip.js";
import { notifyProjectPm } from "./pm-notify.js";
import type { CenterResult } from "./center-deploy-worker.js";

export interface CenterTickPorts {
  config?: () => Record<string, CenterDeployConfig> | null; policy?: RecoveryPolicyPort;
  read?: typeof readCenterState; write?: typeof writeCenterState; proof?: typeof centerProof; cards?: typeof centerCards;
  jobs?: (proof: CenterProof, cfg: CenterDeployConfig, askId: string) => DeployJobs; repoDir?: typeof repoDirFor;
  result?: (run: DeployRun) => CenterResult | null; ask?: typeof getAsk;
}
interface Deps {
  manager: (...args: string[]) => Promise<Record<string, unknown>>; assertActive(): void; now(): number;
  notifyPm?: (project: string, text: string) => Promise<void>; center?: CenterTickPorts;
}
const requireOk = (r: Record<string, unknown>) => { if (r.ok !== true) throw new Error("中心部署台账写入失败"); return r; };
const call = async (d: Deps, task: string, op: string) => {
  d.assertActive(); return requireOk(await d.manager("ledger", "scheduler-center-deploy", task, "--op", op));
};
async function todo(d: Deps, task: string, key: string, text: string) {
  d.assertActive(); requireOk(await d.manager("ledger", "scheduler-pm-todo", task, "--kind", "center_deploy", "--text", text, "--dedup", key));
}
function jobsFor(proof: CenterProof, cfg: CenterDeployConfig, askId: string): DeployJobs {
  return deploymentJobs({ v2: { prepare: async () => ({ kind: "center", center: { proof, config: cfg, askId } }) } });
}
function diskResult(run: DeployRun): CenterResult | null {
  const r = readJsonStateSync(join(deployJobDir(run), "result.json"));
  if (r.status !== "ok") return null;
  const v = r.data as CenterResult & { intentId?: string; mergeSha?: string };
  return v.intentId === run.intentId && v.mergeSha === run.mergeSha && ["success", "failed", "deferred", "stale"].includes(v.status)
    && (v.code === null || Number.isInteger(v.code)) && Number.isFinite(v.ms) && typeof v.dryRun === "boolean" ?
    { status: v.status, code: v.code, ms: v.ms, dryRun: v.dryRun, timedOut: v.timedOut === true } : null;
}
function runFor(project: string, proof: CenterProof, attempt: number, now: number): DeployRun {
  return { intentId: `center:${project}:${proof.sha}:${attempt}`, taskId: proof.cards[0], project, mergeSha: proof.sha,
    prRef: "center-deploy", phase: "running", rev: 0, label: null, outcome: null, liveness: null, receipt: null, reason: null,
    deployedAt: null, createdAt: now, updatedAt: now };
}
async function finish(db: Database, d: Deps, project: string, s: CenterState, save: (s: CenterState) => void): Promise<void> {
  const proof = s.proof!, r = s.result!;
  await call(d, proof.cards[0], "result");
  if (r.status === "success") {
    s.successSha = proof.sha; s.successfulCards ??= {};
    for (const [id, key] of Object.entries(s.cardKeys ?? {})) s.successfulCards[id] = [...new Set([...(s.successfulCards[id] ?? []), key])];
  }
  else {
    await todo(d, proof.cards[0], `center-deploy-failed:${project}:${proof.sha}`, `中心部署失败：${proof.cards.join("、")} ${proof.sha.slice(0, 12)} exit ${r.code ?? "null"}`);
    if (!s.noticeClaimed) {
      s.noticeClaimed = true; save(s); d.assertActive();
      const text = `中心部署失败：${proof.cards.join("、")} ${proof.sha.slice(0, 12)} exit ${r.code ?? "null"}`;
      if (d.notifyPm) await d.notifyPm(project, text);
      else await notifyProjectPm(db, project, text, { fromName: "scheduler", level: "action", stillActive: () => {
        try { d.assertActive(); return true; } catch { return false; /* Lost lease cannot send an action. */ }
      } });
    }
  }
  s.terminalSha = proof.sha; s.run = undefined; save(s);
}
async function observeJob(db: Database, d: Deps, project: string, cfg: CenterDeployConfig, s: CenterState, save: (s: CenterState) => void): Promise<boolean> {
  if (!s.run || !s.proof || !s.askId) return false;
  if (s.result && ["success", "failed"].includes(s.result.status)) { await finish(db, d, project, s, save); return true; }
  const p = d.center ?? {}, jobs = (p.jobs ?? jobsFor)(s.proof, cfg, s.askId), view = await jobs.observe(s.run);
  if (view?.liveness !== "dead" && view !== null) {
    if (view.liveness === "alive" && d.now() > s.run.createdAt + cfg.timeoutMinutes * 60_000 + 420_000) { d.assertActive(); await jobs.remove(view.label); }
    return true;
  }
  // Durable run precedes submission: a missing job after a crash is uncertain, never automatically sent again.
  const r = (p.result ?? diskResult)(s.run) ?? { status: "failed", code: null, ms: 0, dryRun: false, timedOut: false };
  d.assertActive();
  if (!(await jobs.remove(view?.label ?? s.run.label!))) return true;
  if (r.status === "deferred" || r.status === "stale") { s.run = undefined; s.attempt = (s.attempt ?? 0) + 1; save(s); return false; }
  s.result = r; save(s); await finish(db, d, project, s, save); return true;
}
async function driveProject(db: Database, d: Deps, project: string, cfg: CenterDeployConfig, stage: (s: string) => void): Promise<void> {
  stage("state");
  const p = d.center ?? {}, s = (p.read ?? readCenterState)(project), save = (v: CenterState) => { d.assertActive(); (p.write ?? writeCenterState)(project, v); };
  const cards = (p.cards ?? centerCards)(db, project, cfg.repo, s.successfulCards);
  const pending = cards.length ? cards : s.proof?.cards ?? [];
  if (!pending.length || pending.some((id) => schedulerV2SkipTask(db, id))) return;
  if (s.proof?.cards.some((id) => schedulerV2SkipTask(db, id))) return;
  stage("job");
  if (await observeJob(db, d, project, cfg, s, save)) return;
  if (!cards.length && s.successSha === s.proof?.sha) return;
  stage("proof");
  const ask = s.askId ? (p.ask ?? getAsk)(db, s.askId) : null, version = centerConfigVersion(cfg), key = canonicalJson(cards);
  const approved = ask?.state === "answered" && ask.answer?.choices.includes("[button:scheduler_center_deploy_approve]") && s.terminalSha !== s.proof?.sha;
  const cached = s.probe && s.probe.version === version && s.probe.cards === key && d.now() - s.probe.at < 60_000;
  const proof = cached && !approved ? structuredClone(s.probe!.proof) : await (p.proof ?? centerProof)(project, cfg, pending);
  if (!cached || approved) { s.probe = { at: d.now(), version, cards: key, proof }; save(s); }
  if (s.successSha === proof.sha || s.terminalSha === proof.sha) return;
  if (s.proof?.sha === proof.sha) proof.cards = s.proof.cards;
  stage("authorization");
  if ((p.policy ?? recoveryPolicy)(project, "centerDeployAuto").mode === "observe") {
    if (s.observedSha !== proof.sha) { await call(d, pending[0], "observe"); s.observedSha = proof.sha; save(s); }
    return;
  }
  if (!s.askId || !s.proof || canonicalJson(s.proof) !== canonicalJson(proof) || (s.proofVersion ?? ask?.bind?.version) !== version) {
    const opened = await call(d, pending[0], "open");
    s.askId = (opened.ask as Ask).id; s.proof = opened.proof as CenterProof; s.proofVersion = version;
    const keys = opened.cardKeys as Record<string, string> | undefined ?? centerCardKeys(db, project, cfg.repo);
    s.cardKeys = Object.fromEntries(s.proof.cards.filter((id) => keys[id]).map((id) => [id, keys[id]]));
    s.terminalSha = undefined; s.result = undefined; s.noticeClaimed = false; s.attempt = 0; save(s); return;
  }
  const hash = bindHash({ action: "center_deploy", params: s.proof, version }, "scheduler");
  const checked = checkAsk(ask, hash, "scheduler", d.now());
  if (!checked.ok || !ownerAnswered(ask?.answer)) {
    if (ask?.state === "open" && ask.expiresAt > d.now()) return;
    await todo(d, pending[0], `center-deploy-unapproved:${project}:${proof.sha}`, `中心部署未获有效授权：${proof.sha.slice(0, 12)}`);
    s.terminalSha = proof.sha; save(s); return;
  }
  const dir = (p.repoDir ?? repoDirFor)(project, cfg.repo);
  if (!dir) return;
  const jobs = (p.jobs ?? jobsFor)(proof, cfg, s.askId), run = runFor(project, proof, s.attempt ?? 0, d.now());
  if (proof.cards.some((id) => schedulerV2SkipTask(db, id))) return;
  stage("submit");
  run.label = jobs.label(run); s.run = run; save(s); d.assertActive();
  await jobs.submit(run, dir, { restartLabels: ["center-deploy"], timeoutMs: Math.min(3_600_000, cfg.timeoutMinutes * 60_000 + 360_000) });
}

export async function centerDeployTick(db: Database, config: SchedulerConfig, d: Deps): Promise<void> {
  const p = d.center ?? {};
  for (const [project, policy] of Object.entries(config.projects)) {
    if ((p.policy ?? recoveryPolicy)(project, "centerDeployAuto").mode === "off") continue;
    let phase = "config";
    try {
      const cfg = (p.config ?? readCenterDeployConfig)()?.[project];
      if (cfg) { await driveProject(db, d, project, cfg, (s) => { phase = s; }); continue; }
      const own = projectRepo(policy);
      const task = own && listTasks(db, project).find((t) => cardRepo(t) && cardRepo(t) !== own && !schedulerV2SkipTask(db, t.id)
        && (["live", "verified"].includes(t.stage) || !!db.query("SELECT 1 FROM scheduler_merges WHERE taskId=? AND phase='merged' LIMIT 1").get(t.id)));
      if (task && !getEventByDedup(db, `center-deploy-config:${project}`)) await todo(d, task.id, `center-deploy-config:${project}`, "中心部署缺少配置");
    } catch {
      d.assertActive();
      const task = listTasks(db, project).find((t) => !schedulerV2SkipTask(db, t.id));
      try {
        if (task) await todo(d, task.id, `center-deploy-error:${project}:${phase}:${Math.floor(d.now() / 3_600_000)}`, `中心部署 ${phase} 失败，请检查本机记录`);
      } catch { d.assertActive(); console.error(`[center-deploy] ${project}: ${phase} todo failed`); /* An unavailable ledger must not stop ordinary deployment. */ }
      console.error(`[center-deploy] ${project}: ${phase} failed`); // Private errors and command output must not escape to the scheduler log.
    }
  }
}

export function centerDeployWording(project: string, fallback: string, pr: string): string {
  if (recoveryPolicy(project, "centerDeployAuto").mode !== "on") return fallback;
  try { return readCenterDeployConfig()?.[project]?.repo.toLowerCase() === cardRepo({ pr, extra: {} }) ? "等中心部署授权（调度器已发卡）" : fallback; }
  catch { return fallback; /* Invalid configuration has no automatic path; the tick records the PM task. */ }
}
