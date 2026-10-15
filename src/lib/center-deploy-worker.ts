/** One authorized private deployment per independent launchd job; every public result contains only bounded metadata. */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOG_DIR } from "./log-paths.js";
import { runBounded } from "./run-bounded.js";
import { readJsonStateSync, writeJsonAtomicSync } from "./state-file.js";
import { acquireDeployLock } from "./pm-deploy-lock.js";
import { centerCheckout } from "./center-deploy-checkout.js";
import { recoveryPolicy } from "./recovery-policy.js";
import { schedulerV2SkipTask } from "./scheduler-v2-skip.js";
import { repoDirFor } from "./card-repo.js";
import { ownerAnswered } from "./ledger-asks.js";
import { centerScriptRunner } from "./center-deploy-run.js";
import { centerConfigVersion, centerProof, verifyCenterScript, type CenterProof } from "./center-deploy-proof.js";
import { parseCenterDeployConfig, readCenterDeployConfig, type CenterDeployConfig } from "./center-deploy-config.js";
import type { DeployJob } from "./scheduler-deploy-job.js";
import type { StepsOutcome } from "./scheduler-deploy-steps.js";
import type { WorkerDeps } from "./scheduler-deploy-worker.js";
import { checkAsk, bindHash, canonicalJson } from "./ask-bind.js";
import { getAsk } from "./ledger-asks.js";
import { LedgerReader } from "./ledger-read.js";

export interface CenterJobData { proof: CenterProof; config: CenterDeployConfig; askId: string }
export interface CenterResult { status: "success" | "failed" | "deferred" | "stale"; code: number | null; ms: number; dryRun: boolean; timedOut: boolean }
export function validateCenterJob(job: DeployJob): void {
  const c = job.center;
  if (!c || !c.proof || c.proof.sha !== job.mergeSha || !/^[a-f0-9]{64}$/.test(c.proof.scriptDigest)
    || !Array.isArray(c.proof.cards) || !c.proof.cards.length || !c.proof.cards.every((t) => /^[\w.-]{1,64}$/.test(t))
    || typeof c.askId !== "string") throw new Error("invalid center deployment request");
  parseCenterDeployConfig({ projects: { [c.proof.project]: c.config } });
}

export function centerWorkerAuthorized(job: DeployJob, now: number): boolean {
  const c = job.center!, reader = new LedgerReader();
  try {
    const cfg = readCenterDeployConfig()?.[c.proof.project], db = reader.get(), ask = db && getAsk(db, c.askId);
    return recoveryPolicy(c.proof.project, "centerDeployAuto").mode === "on" && !!cfg && repoDirFor(c.proof.project, cfg.repo) === job.repoDir
      && ownerAnswered(ask?.answer) && centerConfigVersion(cfg) === centerConfigVersion(c.config) && !!ask?.bind && !!db && !c.proof.cards.some((id) => schedulerV2SkipTask(db, id))
      && canonicalJson(ask.bind.params) === canonicalJson(c.proof) && ask.bind.version === centerConfigVersion(cfg)
      && checkAsk(ask, bindHash(ask.bind, "scheduler"), "scheduler", now).ok;
  } finally { reader.close(); }
}

export async function runCenterDeployJob(request: string, deps: WorkerDeps = {}): Promise<StepsOutcome | null> {
  const raw = readJsonStateSync(request);
  if (raw.status !== "ok") throw new Error("invalid center deployment request");
  const job = raw.data as DeployJob; validateCenterJob(job);
  const c = job.center!, dir = dirname(request), now = deps.now ?? Date.now, start = now();
  const phases: CenterResult[] = [];
  const write = (r: CenterResult): StepsOutcome => {
    const o = { ok: r.status === "success", summary: `中心部署 ${r.status}`, steps: [], relay: "not_needed" as const, head: c.proof.sha };
    writeJsonAtomicSync(join(dir, "result.json"), { ...o, ...r, phases, intentId: job.intentId, mergeSha: job.mergeSha, endedAt: now() }, { mode: 0o600 });
    return o;
  };
  try { mkdirSync(join(dir, "started"), { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return null; }
  const r: CenterResult = { status: "failed", code: null, ms: 0, dryRun: true, timedOut: false };
  let lock: Awaited<ReturnType<typeof acquireDeployLock>> | undefined;
  let checkout: Awaited<ReturnType<typeof centerCheckout>> | undefined;
  const term = () => {
    r.ms = now() - start;
    try { write(r); } finally { if (lock?.kind === "acquired") lock.handle.release(); }
    process.exit(143);
  };
  process.once("SIGTERM", term);
  try {
    if (!(deps.centerAuthorized ?? centerWorkerAuthorized)(job, now())) { r.status = "stale"; return write(r); }
    const fresh = await centerProof(c.proof.project, c.config, c.proof.cards, { run: deps.run, repoDir: () => job.repoDir });
    if (canonicalJson(fresh) !== canonicalJson(c.proof)) { r.status = "stale"; return write(r); }
    checkout = await centerCheckout(job.repoDir, dir, c.proof.sha, deps.run);
    const check = async () => {
      if (!(deps.centerAuthorized ?? centerWorkerAuthorized)(job, now())) throw new Error("授权已失效");
      const git = await (deps.run ?? runBounded)(["git", "-C", checkout!.dir, "rev-parse", "HEAD"], { timeoutMs: 30_000 });
      if (git.code !== 0 || git.stdout.trim() !== c.proof.sha) throw new Error("中心部署检出版本已变");
      verifyCenterScript(checkout!.dir, c.config.script, c.proof.scriptDigest);
    };
    await check();
    const exec = async (dryRun: boolean) => {
      r.dryRun = dryRun;
      const log = join(LOG_DIR, "center-deploy", `${job.label}.${dryRun ? "dry" : "deploy"}.${start}.log`);
      const started = now();
      const outcome = await (deps.centerRun ?? centerScriptRunner(log))([`./${c.config.script}`, ...(dryRun ? c.config.dryRunArgs : [])], {
        cwd: checkout!.dir, env: { ...job.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "" },
        timeoutMs: dryRun ? 300_000 : c.config.timeoutMinutes * 60_000 });
      phases.push({ status: outcome.code === 0 && !outcome.timedOut ? "success" : "failed",
        code: outcome.code, ms: now() - started, dryRun, timedOut: outcome.timedOut });
      return outcome;
    };
    let result = await exec(true);
    r.code = result.code; r.timedOut = result.timedOut;
    if (result.code !== 0 || result.timedOut) return write({ ...r, ms: now() - start });
    lock = await (deps.machine?.acquireMachine ?? acquireDeployLock)({ label: "scheduler-center-deploy", waitMs: 0, path: deps.machine?.path });
    if (lock.kind !== "acquired") return write({ ...r, status: "deferred", ms: now() - start });
    const finalProof = await centerProof(c.proof.project, c.config, c.proof.cards, { run: deps.run, repoDir: () => job.repoDir });
    if (canonicalJson(finalProof) !== canonicalJson(c.proof)) return write({ ...r, status: "stale", ms: now() - start });
    await check();
    result = await exec(false);
    return write({ ...r, status: result.code === 0 && !result.timedOut ? "success" : "failed", code: result.code,
      timedOut: result.timedOut, ms: now() - start });
  } catch { return write({ ...r, ms: now() - start }); /* All private diagnostics stay out of public results. */ }
  finally { process.off("SIGTERM", term); if (lock?.kind === "acquired") lock.handle.release(); await checkout?.release(); }
}
