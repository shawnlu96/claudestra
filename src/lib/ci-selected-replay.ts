/** Historical judgments use the same pure judge as CI. None of these answers authorizes a merge or changes CI_SELECTED_GATE. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { collectReplayEvidence, type ReplayEvidence, type ReplayReceipt, type ReplayRef, REPLAY_POLICY,
  archiveSelectedMode, pendingReplayJobs, ReplayEvidencePending, replayWaitStarted, readReplayReceipt, replayRefs, replayRoot, saveReplayReceipt } from "./ci-selected-replay-receipt.js";
import { judgeSelected, logDigest, parseReceipt, readResponsibility, shardComplete, shardLogFailures, type SelectedVerdict } from "./ci-selected-verdict.js";
import type { LedgerEvent } from "./ledger-stages.js";
import { statePath } from "./paths.js";
import { getMeta } from "./ledger-store.js";
import { recordObserved, recoveryPolicy, type RecoveryMode } from "./recovery-policy.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergeRun, MergePhase } from "./scheduler-merge.js";
import { isTestProcess } from "./test-guard.js";

const KEY = "ciSelectedReplayReceipt";
const obj = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const parse = (s: string): Record<string, any> => obj(JSON.parse(s));
const ran = (log: string): string[] => log.split(/\r?\n/).flatMap((l) => /^::group::(.+):$/.exec(l)?.[1] ?? []).map((p) => p.replace(/^\.\//, ""));
const sha = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const deny = (reason: string): SelectedVerdict => ({ allow: false, reason, outOfScope: [] });
export interface ReplayJudgment { unverifiedNonTest: string[]; replayable: boolean; gaps: string[]; verdict: SelectedVerdict | null; failures: { file: string; name: string }[] }

/** Non-test jobs and every non-test step must be known. A summary failure is explained only by its failed shards. */
function stepsOf(e: ReplayEvidence): Record<string, string> {
  const steps: Record<string, string> = {};
  for (const j of e.jobs) {
    if (j.name === "ci coverage proof") continue;
    if (j.status !== "completed") steps[`job:${j.name}`] = "pending-job";
    if (!/^test shard [1-8] of 8$/.test(j.name) && j.name !== "typecheck + test + guard") steps[`job:${j.name}`] = j.conclusion ?? "unknown";
    for (const s of j.steps) {
      if (s.name === "Unit tests" || s.name === "All shards succeeded") continue;
      steps[`${j.name}:${s.name}`] = s.conclusion ?? "unknown";
    }
  }
  return steps;
}

/** Reconstruct inputs from bound originals; receipt booleans are diagnostics, never the replay's authority. */
export function judgeReplayEvidence(e: ReplayEvidence, head: string): ReplayJudgment {
  const gaps = [...e.gaps], unverifiedNonTest: string[] = [], failures: ReplayJudgment["failures"] = [], verdicts: SelectedVerdict[] = [];
  try {
    const p = parse(e.planText), n = p.scope === "light" ? 1 : 8, responsibility = readResponsibility(p.responsibility);
    if (p.version !== 1 || p.sha !== e.checkout || p.prHead !== head || p.event !== "pull_request"
      || e.parents.length !== 2 || e.parents[0] !== e.base || e.parents[1] !== head || e.run.headSha !== head
      || e.run.event !== "pull_request") gaps.push("计划 / head / base / run 绑定不符");
    if (!["full", "related", "light"].includes(p.scope) || !Array.isArray(p.shards) || p.shards.length !== n) gaps.push("执行分片计划缺失");
    if (Object.keys(e.files).some((key) => Number(/shard-(\d+)\//.exec(key)?.[1] ?? 0) > n)) gaps.push("工件包含执行计划之外的分片");
    if (pendingReplayJobs(e.jobs).length) gaps.push("必要作业尚未结束或缺失");
    const allRan: string[] = [];
    for (let k = 1; k <= n; k++) {
      const log = e.files[`test-shard-${k}/shard.log`], f = parse(e.files[`ci-facts-shard-${k}/job-facts.json`] ?? "{}");
      if (typeof log !== "string") { gaps.push(`缺第 ${k} 片日志`); continue; }
      const got = ran(log); allRan.push(...got);
      if (f.version !== 1 || f.job !== `test-shard-${k}` || f.runId !== e.run.id
        || f.head !== e.checkout || f.logDigest !== logDigest(log)) gaps.push(`第 ${k} 片事实 / attempt / 日志摘要不符`);
      if (f.attempt !== e.run.attempt) gaps.push(`第 ${k} 片混合 attempt：事实 ${f.attempt}，run ${e.run.attempt}（旧片不沿用）`);
      if (k === 1) for (const name of ["typecheck", "guard", "build"]) {
        if (["skipped", "pending", "unknown"].includes(String(obj(f.core)[name]))) unverifiedNonTest.push(`core:${name}=${obj(f.core)[name]}`);
      }
      if (!log.startsWith(`shard=${k}/${n}\nhead=${e.checkout}\n`)) gaps.push(`第 ${k} 片日志头不符`);
      const job = e.jobs.find((j) => j.name === `test shard ${k} of 8`);
      if (!job || !job.steps.some((s) => s.name === "Unit tests")) gaps.push(`第 ${k} 片作业或测试步骤缺失`);
      if (k === 1 && !["typecheck", "guard", "build"].every((name) => typeof obj(f.core)[name] === "string")) gaps.push("非测试核心步骤结果缺失");
      const assigned = p.scope === "full" ? got : p.shards?.[k - 1];
      if (!Array.isArray(assigned) || !assigned.every((v: unknown) => typeof v === "string")) { gaps.push(`第 ${k} 片执行清单缺失`); continue; }
      const receiptText = e.files[`ci-selected-shard-${k}/receipt.json`];
      const r = receiptText ? parseReceipt(JSON.parse(receiptText)) : null;
      if (receiptText && (!r || r.runId !== e.run.id || r.attempt !== e.run.attempt || r.head !== e.checkout
        || r.logDigest !== logDigest(log) || r.planDigest !== sha(JSON.stringify(p)) || r.responsibilityDigest !== responsibility?.digest)) {
        gaps.push(`第 ${k} 片判定回执不符`);
      }
      const zero = assigned.length === 0 && /^zero=1$/m.test(log);
      const green = f.status === "success" && !r && !/^\(fail\)|^error:|Unhandled error/m.test(log)
        && (zero || / 0 fail\r?\n(?:[^\n]*\n)*?Ran \d+ tests? across \d+ files?\./.test(log));
      const fs = green ? [] : shardLogFailures(log, k);
      if (fs === null) { gaps.push(`第 ${k} 片日志解析不全`); continue; }
      if (!fs.length) {
        const zero = assigned.length === 0 && /^zero=1$/m.test(log);
        if (f.status !== "success" || (!zero && !/^Ran \d+ tests? across \d+ files?\./m.test(log))) gaps.push(`第 ${k} 片无失败但未完整成功`);
        continue;
      }
      failures.push(...fs);
      if (!r) gaps.push(`第 ${k} 片失败缺判定回执（无法确认退出码）`);
      const steps = stepsOf(e);
      for (const [name, value] of Object.entries(obj(f.core))) steps[`core:${name}`] = String(value);
      verdicts.push(judgeSelected({ responsibility, failures: fs, changed: e.changed, complete: shardComplete(log, assigned, r?.exitCode ?? -1), steps }));
    }
    const want: string[] = p.scope === "full" ? e.universe.filter((f) => !e.slow.includes(f)) : p.shards.flat();
    if (p.universe !== e.universe.length || JSON.stringify([...allRan].sort()) !== JSON.stringify([...want].sort())
      || allRan.length !== new Set(allRan).size) gaps.push("分片未完整覆盖执行选集 / 全量文件树");
    if (!["ci related plan", `ci scope ${p.scope}`, "web typecheck + lint", "web production build", "desktop scope", "desktop typecheck + cargo test"]
      .every((name) => e.jobs.some((j) => j.name === name))) gaps.push("必要作业清单缺失");
    if (!e.jobs.length || !e.jobs.some((j) => j.name === "typecheck + test + guard")) gaps.push("非测试步骤清单不完整");
    if (gaps.length) return { unverifiedNonTest, replayable: false, gaps, verdict: null, failures };
    const no = verdicts.find((v) => !v.allow);
    const verdict = no ?? (verdicts.length ? { allow: true, reason: "所有失败均由责任选集判为范围外", outOfScope: verdicts.flatMap((v) => v.outOfScope) }
      : deny("没有可放行的测试失败"));
    return { unverifiedNonTest, replayable: true, gaps, verdict, failures };
  } catch { return { unverifiedNonTest, replayable: false, gaps: [...gaps, "必要证据结构或 JSON 无法解析"], verdict: null, failures }; } // malformed archives are reported, never guessed
}

type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
interface ReplayPorts {
  mode?: RecoveryMode; root?: string; capture?: (run: MergeRun, pr: PrSnapshot) => Promise<void | "wait">;
  collect?: typeof collectReplayEvidence; revision?: typeof cardRevision; effectiveMode?: typeof archiveSelectedMode;
  now?: () => number; waitMs?: number;
}
let injected: ReplayPorts | null = null;
export function useReplayPorts(p: ReplayPorts): Disposable {
  const old = injected; injected = p;
  return { [Symbol.dispose]: () => { injected = old; } };
}
const archiveMode = (project: string) => injected?.mode ?? (isTestProcess() ? "off" : recoveryPolicy(project, KEY).mode);

/** A separate query-only connection avoids opening/migrating the writer while the driver gathers evidence. */
function cardRevision(run: MergeRun): { round: number; specRev: number } {
  const db = new Database(statePath("ledger.sqlite"), { readonly: true });
  try {
    const t = db.query("SELECT round, specRev, headSHA FROM tasks WHERE id=? AND project=?").get(run.taskId, run.project) as
      { round: number; specRev: number; headSHA: string } | null;
    if (!t || t.headSHA !== run.reviewedHead) throw new Error("归档时卡片 / head 已改变");
    return { round: t.round, specRev: t.specRev };
  } finally { db.close(); }
}

/** Only a complete, attempt-bound archive can bypass expensive repeat downloads. */
function reusableEvidence(run: MergeRun, subject: { id: number; attempt: number }, root?: string): ReplayEvidence | null {
  for (const ref of replayRefs(run, root)) {
    const r = readReplayReceipt(root ?? replayRoot(), ref), e = r.evidence;
    if (!r.gaps.length && e && e.run.id === subject.id && e.run.attempt === subject.attempt
      && e.run.headSha === run.reviewedHead) return e;
  }
  return null;
}

async function captureBounce(run: MergeRun, pr: PrSnapshot, ports: ReplayPorts | null): Promise<void | "wait"> {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(run.prRef)?.[1];
  let evidence: ReplayEvidence | null = null, subject: ReplayReceipt["subject"];
  const gaps: string[] = [], now = ports?.now ?? Date.now;
  let revision: { round: number | null; specRev: number | null } = { round: null, specRev: null };
  try { revision = (ports?.revision ?? cardRevision)(run); } catch (e) { gaps.push((e as Error).message); }
  try {
    if (!repo) throw new Error("PR 仓库无法识别");
    evidence = await (ports?.collect ?? collectReplayEvidence)(repo, pr.head,
      pr.checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel").map((c) => c.link ?? ""), undefined, undefined,
      { reuse: (s) => reusableEvidence(run, s, ports?.root) });
  } catch (e) {
    if (e instanceof ReplayEvidencePending) {
      subject = { id: e.run.id, attempt: e.run.attempt };
      const started = await replayWaitStarted(run, e.run, now(), ports?.root);
      if (now() - started < (ports?.waitMs ?? 300_000)) return "wait";
      gaps.push("等待必要作业超时；未完成证据不用于假设放行");
    }
    gaps.push((e as Error).message);
  }
  const judged = evidence ? judgeReplayEvidence(evidence, run.reviewedHead) : null;
  const r: ReplayReceipt = { version: 1, policyVersion: REPLAY_POLICY, project: run.project, taskId: run.taskId, intentId: run.intentId,
    mergeRev: run.rev, head: run.reviewedHead, ...revision, capturedAt: now(), subject,
    effectiveMode: repo ? await (ports?.effectiveMode ?? archiveSelectedMode)(repo, run.project) : "off",
    checks: pr.checks.map((c) => ({ name: c.name, link: c.link ?? "" })), failures: judged?.failures ?? null,
    evidence, gaps: [...gaps, ...judged?.gaps ?? []], verdict: judged?.verdict ?? null };
  if ((ports?.mode ?? archiveMode(run.project)) === "on") await saveReplayReceipt(r, ports?.root);
}

/** Necessary evidence may defer the bounce across ticks for up to five minutes; the eventual callback and receipt stay unchanged. */
export function replayBounceStep(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, ports = injected): Step {
  const mode = ports?.mode ?? archiveMode(run.project);
  if (mode !== "on" || (external.ciSelected !== true && !ports?.capture)) return step;
  return async (to, receipt) => {
    if (to === "resolved" && receipt?.startsWith(`退回 fix（ci_fail）：PR head ${run.reviewedHead}，`)
      && (ports?.mode ?? archiveMode(run.project)) === "on") {
      try {
        const captured = ports?.capture ? await ports.capture(run, pr) : await captureBounce(run, pr, ports);
        if (captured === "wait") return run;
      }
      catch (e) {
        console.error(`⚠️ [ci-selected-replay] ${run.taskId} 归档失败，退回事件将记录缺口：${(e as Error).message}`);
      }
    }
    return step(to, receipt);
  };
}

/** Included in the transaction's merge_conflict event. Missing files remain an explicit gap, even if storage itself failed. */
export function replayBounceEvent(db: Database, row: MergeRun, cause: string): Record<string, unknown> {
  const mode = archiveMode(row.project);
  if (cause !== "ci_fail" || mode === "off") return {};
  const task = db.query("SELECT round, specRev FROM tasks WHERE id=?").get(row.taskId) as { round: number; specRev: number };
  let refs: ReplayRef[] = [], gap: string | null = null;
  try { if (mode === "on") refs = replayRefs(row, injected?.root); }
  catch (e) { gap = `归档读不出：${(e as Error).message}`; }
  recordObserved(db, { project: row.project, target: row.taskId, mechanism: KEY, actionKey: `bounce.${sha(row.intentId).slice(7, 31)}.${row.rev}`,
    action: "退回前保存 CI 责任选集回放证据", data: { intentId: row.intentId, mode, refs, gap } }, Date.now());
  return { ciSelectedReplay: { version: 1, intentId: row.intentId, mergeRev: row.rev, head: row.reviewedHead, round: task.round,
    specRev: task.specRev, refs, gap: gap ?? (refs.length ? null : mode === "observe" ? "归档键 observe：未采集" : "退回前没有归档工件") } };
}

export interface ReplayRow {
  seq: number; taskId: string; head: string; replayable: boolean; hypothetical: "allow" | "deny" | "unreplayable";
  unverifiedNonTest: string[]; reason: string; posterior: "confirmed_problem" | "confirmed_recovered" | "unknown";
  evidence: { seq: number; text: string; data: Record<string, unknown> }[]; receipts: ReplayRef[];
}

const FOLLOWUP = "ci-selected-replay-followup ";
/** The existing ledger note command can record an explicit determination without adding a new write API. */
function followup(e: LedgerEvent): Record<string, any> | null {
  if (e.data.op === "ci_selected_replay_followup") return e.data;
  if (e.kind !== "note" || !e.text.startsWith(FOLLOWUP)) return null;
  try { return parse(e.text.slice(FOLLOWUP.length)); }
  catch { return null; } // malformed notes remain evidence links, never classification facts
}

/** A changed-head delivery or a rerun request is insufficient, even when someone cites its URL in a note. */
function recoveryProof(d: Record<string, any>, head: string, refs: ReplayRef[], root: string): boolean {
  const p = obj(d.sameHeadRerun);
  if (p.head !== head || p.status !== "completed" || p.conclusion !== "success" || p.coverage !== "full"
    || !Number.isSafeInteger(p.runId) || p.runId < 1 || !Number.isSafeInteger(p.attempt) || p.attempt < 1) return false;
  const ref = refs.find((r) => r.digest === d.receiptDigest);
  if (!ref) return false;
  const original = readReplayReceipt(root, ref).evidence;
  if (!original || p.checkout !== original.checkout || (p.runId === original.run.id && p.attempt <= original.run.attempt)) return false;
  const url = `https://github.com/${original.repo}/actions/runs/${p.runId}/attempts/${p.attempt}`;
  return Array.isArray(d.evidence) && d.evidence.includes(url);
}

/** Only an explicit owner/PM determination bound to this bounce and digest classifies posterior truth. Later deliveries are links, not proof. */
function posterior(db: Database, event: LedgerEvent, refs: ReplayRef[], later: LedgerEvent[], root: string): Pick<ReplayRow, "posterior" | "evidence"> {
  const meta = getMeta(db, event.project), trusted = new Set(["owner", "master", ...meta.pms.filter((p) => p !== meta.team?.dispatcher)]);
  const evidence = later.filter((e) => e.target === event.target && e.seq > event.seq &&
    (e.kind === "deliver" || e.data.op === "merge_ci_rerun" || followup(e) !== null))
    .map((e) => ({ seq: e.seq, text: e.text, data: e.data }));
  const determinations = later.filter((e) => e.target === event.target && e.seq > event.seq && trusted.has(e.actor)).map(followup)
    .filter((d) => d && d.bounceSeq === event.seq && d.head === event.data.prHead && refs.some((r) => r.digest === d.receiptDigest)
      && Array.isArray(d.evidence) && d.evidence.length > 0 && d.evidence.every((v: unknown) => typeof v === "string" && /^https:\/\/\S+$/.test(v)));
  const outcomes = new Set(determinations.filter((d) => d!.outcome !== "confirmed_recovered"
    || recoveryProof(d!, String(event.data.prHead), refs, root)).map((d) => d!.outcome));
  const outcome = outcomes.size === 1 ? [...outcomes][0] : "unknown";
  return { posterior: outcome === "confirmed_problem" || outcome === "confirmed_recovered" ? outcome : "unknown", evidence };
}

/** No network, no migration and no writes: old events without archives are individually counted as unknown. */
export function replaySelectedHistory(db: Database, project: string, days: number, now = Date.now(), root = replayRoot()) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error("days 要是 1..3650 的整数");
  const raw = db.query("SELECT * FROM events WHERE project=? AND ts>=? ORDER BY seq").all(project, now - days * 86_400_000) as any[];
  const events: LedgerEvent[] = raw.map((e) => ({ ...e, data: JSON.parse(e.data) }));
  const rows: ReplayRow[] = events.filter((e) => e.kind === "scheduler" && e.data.op === "merge_conflict" && e.data.cause === "ci_fail").map((event) => {
    const b = obj(event.data.ciSelectedReplay), refs = Array.isArray(b.refs) ? b.refs as ReplayRef[] : [];
    const base: ReplayRow = { seq: event.seq, taskId: event.target, head: String(event.data.prHead), replayable: false,
      hypothetical: "unreplayable", unverifiedNonTest: [], reason: String(b.gap ?? "旧事件没有归档工件"), posterior: "unknown", evidence: [], receipts: refs };
    try {
      if (!refs.length) return base;
      const archives = refs.map((ref) => readReplayReceipt(root, ref));
      if (archives.some((r) => r.project !== project || r.taskId !== event.target || r.intentId !== event.data.intentId
        || r.head !== event.data.prHead || r.mergeRev !== b.mergeRev || b.intentId !== r.intentId || b.head !== r.head)) throw new Error("事件与工件绑定不符");
      const r = archives.sort((a, z) => a.capturedAt - z.capturedAt || (a.evidence?.run.attempt ?? 0) - (z.evidence?.run.attempt ?? 0)).at(-1)!;
      if (r.round !== b.round || r.specRev !== b.specRev) throw new Error("事件与工件轮次 / 规格版本不符");
      if (!r.evidence || r.gaps.length) throw new Error(r.gaps.join("；") || "没有原始证据");
      const j = judgeReplayEvidence(r.evidence, r.head);
      if (!j.replayable || !j.verdict) throw new Error(j.gaps.join("；"));
      return { ...base, replayable: true, hypothetical: j.verdict.allow ? "allow" as const : "deny" as const, reason: j.verdict.reason, unverifiedNonTest: j.unverifiedNonTest,
        ...(j.verdict.allow ? posterior(db, event, refs, events, root) : {}) };
    } catch (e) { return { ...base, reason: (e as Error).message }; }
  });
  const allowed = rows.filter((r) => r.hypothetical === "allow");
  return { ok: true, project, days, policyVersion: REPLAY_POLICY,
    posteriorEvidencePolicy: "未知直到 owner/PM 的 ledger note 明确核验；恢复还须同 head、同检出的 full 成功重跑证明。改 head / 本机绿 / 仅发请求均不足",
    recoveredProof: "note.sameHeadRerun={head,checkout,runId,attempt,status:completed,conclusion:success,coverage:full}，evidence 包含对应 /runs/<id>/attempts/<attempt> 链接",
    followupNote: 'ci-selected-replay-followup {"bounceSeq":123,"head":"<head>","receiptDigest":"<digest>",'
      + '"outcome":"confirmed_problem|confirmed_recovered","evidence":["<证据链接>"]}',
    totalBounces: rows.length, replayable: rows.filter((r) => r.replayable).length,
    hypotheticalQualification: "假设放行沿用在线 judge 的 skipped 语义；未验证的 guard/build 单列，不能据此认定收益或真实恢复",
    hypotheticalAllowedWithUnverifiedNonTest: allowed.filter((r) => r.unverifiedNonTest.length > 0).length,
    hypotheticalAllowed: allowed.length, hypotheticalDenied: rows.filter((r) => r.hypothetical === "deny").length,
    unreplayable: rows.filter((r) => !r.replayable).length,
    unknownIncludingUnreplayable: rows.filter((r) => !r.replayable || (r.hypothetical === "allow" && r.posterior === "unknown")).length,
    posteriorScope: "hypotheticalAllowed",
    posterior: { confirmedProblem: allowed.filter((r) => r.posterior === "confirmed_problem").length,
      confirmedRecovered: allowed.filter((r) => r.posterior === "confirmed_recovered").length, unknown: allowed.filter((r) => r.posterior === "unknown").length }, rows };
}
