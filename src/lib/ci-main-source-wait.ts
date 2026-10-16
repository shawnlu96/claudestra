/**
 * merge-arch-CIMAINSRC1 · a PR whose every CI failure is also failing on main right now (same test file + test name + error
 * fingerprint, read from both failed logs) stays in the merge recovery path instead of bouncing to fix: no author, no reviewer.
 * Driver side (sourceWaitRoute / sourceWaitHeld, wired in bounceStep): where the ci_fail bounce would be sent, both logs are read
 * and one receipt `main 同源红判定：{…}` goes to the ledger instead. Ledger side (sourceWaitGate, first thing in closeMergeRun):
 * a full match registers op=ci_wait_main_fix (source ciMainSourceWait, with both sides' head / run / attempt / sample time, the
 * triples and the main fix owner) and leaves the run as it is; anything else is the very bounce receipt the old path sent. Once
 * main's CI is green on a newer head, or the registered main-red-fix card merged, the ledger turns the same receipt into CIF2's
 * own update-branch claim (scheduler-merge-ci-behind.ts), so lease, pause / drift, head pin and the one-send-per-run / per-head
 * rule are CIF2's; the new head still needs the full merge gate. Only one retry per merge run: a red after it bounces (recorded).
 * The waiting run keeps the project merge slot; past WAIT_TTL_MS it takes the old bounce (recorded), so a serial fix card waits at most that.
 * Switch ciMainSourceWait (default on): observe = a sample and the old bounce; off = not one call or write more than before.
 * tests/ci-main-source-wait*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { WriteCtx } from "./ledger-checks.js";
import type { EventKind } from "./ledger-stages.js";
import { LedgerError } from "./ledger-store.js";
import { NODE_OP } from "./main-red-fix.js";
import { mainRedGh } from "./main-red-fix-gh.js";
import { recordObserved, recoveryPolicy, type RecoveryMode, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { behindReceipt, ciBehindGh, type CiBehindGh } from "./scheduler-merge-ci-behind.js";
import { CI_RUN_LINK, ciRerunGhOf, type CiRerunGh } from "./scheduler-merge-ci-rerun.js";
import { ERROR, FAIL, GROUP, isResultLine, parseFailedLog, PREFIX, STAMP } from "./scheduler-merge-ci-rerun-log.js";
import { RECEIPT_MAX } from "./scheduler-merge-ci-receipt.js";
import { isTestProcess } from "./test-guard.js";
import { WAIT_OP, WAIT_TTL_MS } from "./ci-main-fix-retry.js";
import type { MergeBounce } from "./scheduler-merge-conflict.js";
import type { MergeExternal, PrSnapshot } from "./scheduler-merge-driver.js";
import type { MergePhase, MergeRun } from "./scheduler-merge.js";

export const CI_MAIN_SOURCE_WAIT_KEY = "ciMainSourceWait";
export const RETRY_OP = "ci_main_source_retry", VERDICT_OP = "ci_main_source_verdict";

let policyPort: RecoveryPolicyPort = recoveryPolicy;
/** Tests inject a fake policy; null restores the file-backed one. */
export function configureSourceWaitPolicy(port: RecoveryPolicyPort | null): void { policyPort = port ?? recoveryPolicy; }
/** Read right before each use, on both sides; unreadable = off (the path as it was). */
function sourceWaitMode(project: string): RecoveryMode {
  try {
    return policyPort(project, CI_MAIN_SOURCE_WAIT_KEY).mode;
  } catch (e) {
    console.error(`⚠️ [merge] ${project} 读恢复策略 ${CI_MAIN_SOURCE_WAIT_KEY} 失败，按 off：${(e as Error).message}`);
    return "off";
  }
}

// ── evidence: test file + test name + error fingerprint ─────────────────────────────────────────────────────────────

export interface Triple { file: string; name: string; fp: string }
const UNHANDLED = /^# Unhandled error between tests\s*$/;
const RULE = /^-{10,}\s*$/;
/** bun's assertion detail lines; with the error line they are the failure's meaning. */
const DETAIL = /^\s*(?:Expected|Received)\b[^:]{0,40}:/;
const FP_MAX = 300;

/**
 * Only noise goes: run times, timestamps, epoch milliseconds, temp directories and the runner's checkout prefix. The message,
 * the matcher and the values stay, so two different errors in one test never read as the same fingerprint.
 */
export function normalizeError(line: string): string {
  return line
    .replace(/\[\d+(?:\.\d+)?m?s\]/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<time>")
    .replace(/\b1[5-9]\d{11}\b/g, "<epoch>")
    .replace(/\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g, "")
    .replace(/(?:\/private)?\/var\/folders\/[^\s'":)]+|\/(?:var\/)?tmp\/[^\s'":)]+|\/home\/runner\/work\/_temp\/[^\s'":)]+/g, "<tmp>")
    .replace(/\s+/g, " ").trim();
}

/** Lines per failed step (gh prefix and timestamp dropped), in the order gh printed them. */
function stepBodies(log: string): string[][] {
  const steps = new Map<string, string[]>();
  let key = "";
  for (const raw of log.split(/\r?\n/)) {
    const p = PREFIX.exec(raw);
    if (p) key = `${p[1]}\t${p[2]}`;
    const lines = steps.get(key) ?? steps.set(key, []).get(key)!;
    lines.push((p ? raw.slice(p[0].length) : raw).replace(STAMP, ""));
  }
  return [...steps.values()];
}

/**
 * Every failure of a bun test log as a triple, or null when any one cannot be formed: the log must read whole the way the
 * merge gate reads it (parseFailedLog), and each `(fail)` needs its error lines (a timeout is its own fingerprint). A type
 * check, a guard, a crash outside a test or a cut log is null, never "no failures".
 */
export function failureTriples(log: string): Triple[] | null {
  const failures = parseFailedLog(log);
  if (!failures?.length) return null;
  const found: { file: string; name: string; errs: string[] }[] = [];
  for (const lines of stepBodies(log)) {
    let file: string | null = null, errs: string[] = [], skip = 0;
    for (const line of lines) {
      if (skip) { if (RULE.test(line)) skip--; continue; } // a timed-out test's stray block: parseFailedLog already accounted it
      if (UNHANDLED.test(line)) { skip = 2; continue; }
      const group = GROUP.exec(line);
      if (group || line.startsWith("##[endgroup]")) { file = group?.[1] ?? null; errs = []; continue; }
      if (!file) continue;
      if (line.startsWith("(pass) ")) { errs = []; continue; }
      const fail = isResultLine(line) ? FAIL.exec(line) : null;
      if (fail) { found.push({ file, name: fail[1]!, errs }); errs = []; continue; }
      if (ERROR.test(line) || DETAIL.test(line)) errs.push(normalizeError(line));
    }
  }
  if (found.length !== failures.length) return null;
  const out: Triple[] = [];
  for (const [i, f] of failures.entries()) {
    const seen = found[i]!;
    if (seen.file !== f.file || seen.name !== f.name) return null;
    const fp = f.timedOut ? "timeout" : seen.errs.join(" | ").slice(0, FP_MAX);
    if (!fp) return null;
    out.push({ file: f.file, name: f.name, fp });
  }
  return out;
}

const tripleKey = (t: Triple): string => JSON.stringify([t.file, t.name, t.fp]);
/** Every PR failure has the same triple on main; main may fail more. Never a match on an empty side. */
export function matchSource(pr: readonly Triple[], main: readonly Triple[]): { ok: true } | { ok: false; why: string } {
  if (!pr.length || !main.length) return { ok: false, why: "一侧没有失败用例" };
  const onMain = new Set(main.map(tripleKey));
  const miss = pr.find((t) => !onMain.has(tripleKey(t)));
  return miss ? { ok: false, why: `${miss.file} > ${miss.name} 在 main 上没有同指纹失败` } : { ok: true };
}
export const tripleDigest = (ts: readonly Triple[]): string =>
  createHash("sha256").update(JSON.stringify(ts.map(tripleKey).sort())).digest("hex").slice(0, 16);

// ── GitHub reads ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MainRun { id: number; attempt: number; headSha: string; status: string; conclusion: string; url: string; createdAt: number }
/** main's push CI and its failed log; a test (or another host) puts its own on the external as `ciMainSource`. */
export interface MainSourceGh {
  /** The latest push runs of ci.yml on main, any order. */
  mainRuns(repo: string): Promise<MainRun[]>;
  failedLog(repo: string, runId: string, attempt: number): Promise<string>;
}
const SHA = /^[a-f0-9]{40}$/i;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** main-red-fix's own reads of main (main-red-fix-gh.ts): the push runs of ci.yml, and one attempt's failed log (null = too long). */
export function mainSourceGh(command: typeof runBounded = runBounded): MainSourceGh {
  const gh = mainRedGh(command);
  return {
    mainRuns: async (repo) => (await gh.runs(repo, "ci.yml", "push")).map((r) => ({ ...r, conclusion: r.conclusion ?? "" })),
    async failedLog(repo, runId, attempt) {
      const log = await gh.failedLog(repo, Number(runId), attempt);
      if (log === null) throw new Error("main 失败日志太长，可能被截断");
      return log;
    },
  };
}

type Hosted = MergeExternal & { ciMainSource?: MainSourceGh; ciBehind?: CiBehindGh };
/** Without all three on the external a test process never reaches the real gh: the bounce stays as it always was there. */
function portsOf(external: MergeExternal): { log: CiRerunGh; main: MainSourceGh; update: CiBehindGh } | null {
  const h = external as Hosted, log = ciRerunGhOf(external);
  const main = h.ciMainSource ?? (isTestProcess() ? null : mainSourceGh());
  const update = h.ciBehind ?? (isTestProcess() ? null : ciBehindGh());
  return log && main && update ? { log, main, update } : null;
}

/** Parsed logs per run attempt: a waiting card reads the same two logs every pass. Bounded; a failed read is not kept. */
const parsed = new Map<string, Promise<Triple[] | null>>();
function triplesOf(key: string, read: () => Promise<string>): Promise<Triple[] | null> {
  let hit = parsed.get(key);
  if (!hit) {
    if (parsed.size >= 200) parsed.clear();
    hit = read().then(failureTriples);
    parsed.set(key, hit);
    hit.catch(() => parsed.delete(key)); // the caller gets the same rejection; only the cache entry is dropped
  }
  return hit;
}

// ── the receipt ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * h/r/a: PR head, its red run, attempt. k: main's newest finished push CI (red / green / none read). m: main's newest head.
 * mr/ma/ms: the main run judged, its attempt and head. t: sample time. x: every PR failure matched. n: failed check names.
 * f: failing test files. c: the PR's triples when they fit, d: their digest. w: why, short.
 */
interface Wire { h: string; r: string; a: number; k: "red" | "green" | "none"; m: string | null; mr: string | null; ma: number | null; ms: string | null;
  t: number; x: 0 | 1; n: string[]; f: string[]; c: [string, string, string][] | null; d: string | null; w: string }
const LEAD = "main 同源红判定：";
const RUN_LINK = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)$/;
const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** The triples go first when the receipt is too long, then the match itself (a match that cannot be shown is no match). */
function wireReceipt(w: Wire): string | null {
  const render = (v: Wire) => LEAD + JSON.stringify(v).replace(CONTROL, " ");
  for (const v of [w, { ...w, c: null }]) {
    const r = render(v);
    if (r.length <= RECEIPT_MAX) return r;
  }
  const r = render({ ...w, c: null, f: [], x: 0, w: "证据超过回执长度" });
  return r.length <= RECEIPT_MAX ? r : null;
}

function parseWire(receipt: string): Wire | null {
  try {
    const w = JSON.parse(receipt.slice(LEAD.length)) as Wire;
    const str = (v: unknown): v is string => typeof v === "string";
    const strs = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => str(s) && s);
    const sha = (v: unknown) => v === null || (str(v) && SHA.test(v));
    if (!w || !str(w.h) || !SHA.test(w.h) || !str(w.r) || !RUN_LINK.test(w.r) || !Number.isSafeInteger(w.a) || !Number.isSafeInteger(w.t)) return null;
    if (!["red", "green", "none"].includes(w.k) || !sha(w.m) || !sha(w.ms) || (w.mr !== null && (!str(w.mr) || !RUN_LINK.test(w.mr)))) return null;
    if ((w.ma !== null && !Number.isSafeInteger(w.ma)) || (w.x !== 0 && w.x !== 1) || !strs(w.n) || !w.n.length || !strs(w.f) || !str(w.w)) return null;
    if (w.x === 1 && (!w.f.length || w.k !== "red" || !w.mr || !w.ms)) return null;
    return w;
  } catch {
    return null; // malformed JSON: the gate refuses the receipt as invalid below
  }
}

/** The old path's ci_fail bounce for these checks; the ledger rebuilds it from the receipt, the driver checks it rebuilds the same. */
const bounceOfWire = (w: Pick<Wire, "h" | "r" | "n">, toReceipt: (b: MergeBounce) => string): string =>
  toReceipt({ cause: "ci_fail", prHead: w.h, mainHead: null, checks: w.n.map((name) => ({ name, link: w.r })) });

// ── driver side ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Step = (to: MergePhase, receipt?: string) => Promise<MergeRun>;
type FailedCheck = MergeBounce["checks"][number];
type ToReceipt = (b: MergeBounce) => string;
/** Runs this process saw the ledger keep waiting (intent + head + PR run): the next pass skips CIF1 / CIF8 / CIF2, which already said bounce. */
const held = new Set<string>();
/** What a restart forgets: the held runs and the parsed logs (tests call it between worlds and to restart). */
export function forgetSourceWait(): void { held.clear(); parsed.clear(); }
const heldKey = (run: MergeRun, pr: PrSnapshot, link: string) => `${run.intentId}\n${pr.head.toLowerCase()}\n${link}`;
/** The one Actions run behind every failed check, or null. */
function runOf(run: MergeRun, checks: readonly FailedCheck[]): { repo: string; runId: string; link: string; pull: string } | null {
  const pull = PULL.exec(run.prRef), links = checks.map((c) => CI_RUN_LINK.exec(c.link));
  if (!pull || !links.length || links.some((m) => !m || `${m[1]}/${m[2]}` !== `${links[0]![1]}/${links[0]![2]}`)) return null;
  const [repo, runId] = [links[0]![1]!, links[0]![2]!];
  return repo.toLowerCase() === pull[1]!.toLowerCase() ? { repo, runId, link: `https://github.com/${repo}/actions/runs/${runId}`, pull: pull[2]! } : null;
}

/** Both sides read now; a read that fails or a log that forms no triples is an observation without a match (`w` says why). */
async function observe(pr: PrSnapshot, checks: readonly FailedCheck[], at: { repo: string; runId: string; link: string },
  ports: { log: CiRerunGh; main: MainSourceGh }): Promise<Wire> {
  const w: Wire = { h: pr.head.toLowerCase(), r: at.link, a: 0, k: "none", m: null, mr: null, ma: null, ms: null, t: Date.now(), x: 0,
    n: checks.map((c) => c.name), f: [], c: null, d: null, w: "" };
  try {
    const run = await ports.log.runAttempt(at.repo, at.runId);
    w.a = run.attempt;
    if (run.headSha.toLowerCase() !== w.h || run.status !== "completed") return { ...w, w: "PR 的 run 不是本 head 已结束的 run" };
    const mine = await triplesOf(`${at.repo}/${at.runId}/${run.attempt}`, () => ports.log.failedLog(at.repo, at.runId));
    if (!mine) return { ...w, w: "PR 失败日志形不成 文件+用例+指纹" };
    [w.f, w.d] = [[...new Set(mine.map((t) => t.file))].sort(), tripleDigest(mine)];
    const runs = [...await ports.main.mainRuns(at.repo)].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
    const done = runs.find((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure"));
    [w.m, w.t] = [runs[0]?.headSha ?? null, Date.now()];
    if (!done) return { ...w, w: "main 没有已结束的 CI" };
    [w.mr, w.ma, w.ms] = [`https://github.com/${at.repo}/actions/runs/${done.id}`, done.attempt, done.headSha];
    if (done.conclusion === "success") return { ...w, k: "green", w: "main CI 已绿" };
    w.k = "red";
    const theirs = await triplesOf(`${at.repo}/${done.id}/${done.attempt}`, () => ports.main.failedLog(at.repo, String(done.id), done.attempt));
    if (!theirs) return { ...w, w: "main 失败日志形不成 文件+用例+指纹" };
    const match = matchSource(mine, theirs);
    return { ...w, x: match.ok ? 1 : 0, c: mine.map((t) => [t.file, t.name, t.fp]), w: match.ok ? "全部失败与 main 同源" : match.why };
  } catch (e) { // gh reads only (no pass ownership check runs in here): a failed read is evidence missing, never a match
    return { ...w, w: `读 CI 失败：${oneLine((e as Error).message)}` };
  }
}

/**
 * In place of the ci_fail bounce: off (or no ports) sends the bounce exactly as before. Otherwise the observation goes to the
 * ledger, which answers with the bounce, a wait (the run unchanged) or CIF2's update claim (phase updating): only then is
 * update-branch sent, pinned to the reviewed head; GitHub refusing it bounces as CIF2 does.
 */
async function sourceWaitStep(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: readonly FailedCheck[],
  bounce: string, toReceipt: ToReceipt): Promise<MergeRun> {
  const mode = sourceWaitMode(run.project), ports = mode === "off" ? null : portsOf(external), at = ports ? runOf(run, checks) : null;
  if (!ports || !at) return step("resolved", bounce);
  const key = heldKey(run, pr, at.link);
  const w = await observe(pr, checks, at, ports);
  const receipt = mode === "on" || w.x ? wireReceipt(w) : null;
  if (!receipt || bounceOfWire(w, toReceipt) !== bounce) { held.delete(key); return step("resolved", bounce); }
  if (w.x) console.error(`⏳ [merge] ${run.taskId} CI 红与 main（${w.mr}）同源：${w.f.join("、")}`);
  const after = await step("resolved", receipt);
  if (after.phase !== "updating") {
    if (after.phase === "resolved") held.delete(key);
    else held.add(key);
    return after;
  }
  held.delete(key);
  try {
    await ports.update.updateBranch(at.repo, at.pull, pr.head);
    console.error(`🔁 [merge] ${run.taskId} main 已修好同源失败，已合入 main 更新 PR（expected_head_sha ${pr.head.slice(0, 12)}），重跑 CI`);
    return after;
  } catch (e) { // as CIF2: GitHub refusing the update (the head moved) bounces
    console.error(`⚠️ [merge] ${run.taskId} main 修好后的 update-branch 失败，退回 fix：${oneLine((e as Error).message)}`);
    return step("resolved", bounce);
  }
}

/** bounceStep's step for the CIF layers: their ci_fail bounce (outside CIF2's own update) goes through sourceWaitStep. */
export function sourceWaitRoute(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: readonly FailedCheck[],
  bounce: string, toReceipt: ToReceipt): Step {
  return (to, receipt) => to === "resolved" && receipt === bounce && run.phase !== "updating"
    ? sourceWaitStep(run, pr, external, step, checks, bounce, toReceipt) : step(to, receipt);
}

/** A run this process already holds on this head and PR run goes straight to the wait check, without the CIF layers; else null. */
export function sourceWaitHeld(run: MergeRun, pr: PrSnapshot, external: MergeExternal, step: Step, checks: readonly FailedCheck[],
  bounce: string, toReceipt: ToReceipt): Promise<MergeRun> | null {
  const at = runOf(run, checks);
  if (!at || run.phase === "updating" || !held.has(heldKey(run, pr, at.link))) return null;
  if (sourceWaitMode(run.project) !== "on") { held.delete(heldKey(run, pr, at.link)); return null; }
  return sourceWaitStep(run, pr, external, step, checks, bounce, toReceipt);
}

// ── ledger side ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** closeMergeRun's own event writer (only the ledger's write modules import ledger-tx). */
type WriteEvent = (db: Database, ctx: WriteCtx, e: { project: string; target: string; kind: EventKind; text?: string; data?: Record<string, unknown> },
  primary: boolean) => { seq: number };
interface Registration { seq: number; ts: number; mainHead: string; mainRun: string; files: string[]; owner: string | null }
const json = (raw: string): Record<string, unknown> => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } };
const runNumber = (link: string | null): number => Number(link ? RUN_LINK.exec(link)?.[2] ?? 0 : 0);

/** This run's first registration on its reviewed head (its age bounds the wait). */
function registrationOf(db: Database, row: MergeRun): Registration | null {
  const r = db.query(`SELECT seq, ts, data FROM events WHERE target=? AND kind='note' AND actor='scheduler' AND json_extract(data,'$.op')=?
    AND json_extract(data,'$.source')=? AND json_extract(data,'$.intentId')=? AND json_extract(data,'$.prHead')=? ORDER BY seq LIMIT 1`)
    .get(row.taskId, WAIT_OP, CI_MAIN_SOURCE_WAIT_KEY, row.intentId, row.reviewedHead.toLowerCase()) as { seq: number; ts: number; data: string } | null;
  if (!r) return null;
  const d = json(r.data), owner = d.owner as { card?: unknown } | undefined;
  return { seq: r.seq, ts: r.ts, mainHead: String(d.mainHead), mainRun: String(d.mainRun), files: (d.files as string[]) ?? [],
    owner: typeof owner?.card === "string" ? owner.card : null };
}

/** The main-red-fix card written for this main red (by run id, else by main SHA), if any. */
function fixCardOf(db: Database, project: string, mainRun: string, mainHead: string): { card: string; node: string } | null {
  const rows = db.query(`SELECT data FROM events WHERE project=? AND kind='scheduler' AND json_extract(data,'$.op')=? ORDER BY seq DESC`)
    .all(project, NODE_OP) as { data: string }[];
  const nodes = rows.map((r) => json(r.data)).filter((d) => typeof d.taskId === "string");
  const hit = nodes.find((d) => Number(d.runId) === runNumber(mainRun)) ?? nodes.find((d) => String(d.mainSha).toLowerCase() === mainHead);
  return hit ? { card: hit.taskId as string, node: `${String(hit.featureId)}/${String(hit.key)}` } : null;
}
const mergedSha = (db: Database, card: string): string | null => (db.query(`SELECT mergeSha FROM scheduler_merges WHERE taskId=? AND phase='merged'
  AND mergeSha IS NOT NULL ORDER BY updatedAt DESC LIMIT 1`).get(card) as { mergeSha: string } | null)?.mergeSha ?? null;

function register(db: Database, ctx: WriteCtx, row: MergeRun, w: Wire, now: number, insertEvent: WriteEvent): Registration {
  const fix = fixCardOf(db, row.project, w.mr!, w.ms!);
  const owner = fix ? { kind: "main_red_fix", card: fix.card, node: fix.node } : { kind: "main", card: null, node: null };
  const ownerText = fix ? `修复卡 ${fix.card}（${fix.node}）` : "main 红修复（mainRedFix 还没写修复卡，责任在 main）";
  const e = insertEvent(db, { actor: ctx.actor, now, dedupKey: `ci-main-source-wait:${row.intentId}:${w.h}:${RUN_LINK.exec(w.r)![2]}:${w.a}` }, {
    project: row.project, target: row.taskId, kind: "note",
    text: `等 main 修：CI 红与 main（run ${runNumber(w.mr)}）同源（${w.f.join("、")}），卡留在合并恢复路径；main 修复责任：${ownerText}；` +
      "main CI 转绿或修复卡合入后自动 update-branch 重跑 CI",
    data: { op: WAIT_OP, source: CI_MAIN_SOURCE_WAIT_KEY, intentId: row.intentId, task: row.taskId, pr: row.prRef, prHead: w.h, run: w.r, attempt: w.a,
      checks: w.n, files: w.f, mainHead: w.ms, mainRun: w.mr, mainAttempt: w.ma, mainNewest: w.m, sampledAt: w.t, matches: w.c, digest: w.d, owner,
      basis: "逐条比对 测试文件+用例名+错误指纹（只规范化时间、临时路径），PR 每条失败在 main 同期 run 上都有" } }, true);
  return { seq: e.seq, ts: now, mainHead: w.ms!, mainRun: w.mr!, files: w.f, owner: fix?.card ?? null };
}

function verdict(db: Database, ctx: WriteCtx, row: MergeRun, w: Wire, outcome: "retry_red" | "expired", text: string, insertEvent: WriteEvent): void {
  insertEvent(db, { actor: ctx.actor, now: ctx.now ?? Date.now(), dedupKey: `ci-main-source-verdict:${row.intentId}:${w.h}:${outcome}` }, {
    project: row.project, target: row.taskId, kind: "note", text,
    data: { op: VERDICT_OP, intentId: row.intentId, task: row.taskId, prHead: w.h, run: w.r, attempt: w.a, outcome, main: w.k, mainRun: w.mr,
      mainHead: w.ms, matched: w.x === 1, why: w.w, sampledAt: w.t, then: "ci_fail 退回 fix（原路径）" } }, true);
}

type Trigger = { kind: "main_green" | "fix_merged"; sha: string; card: string | null };
/** main green on a newer head and a newer run than the red one registered, or the registered (or since written) fix card merged. */
function triggerOf(db: Database, row: MergeRun, reg: Registration, w: Wire): Trigger | null {
  if (w.k === "green" && w.ms && w.ms !== reg.mainHead && runNumber(w.mr) > runNumber(reg.mainRun)) return { kind: "main_green", sha: w.ms, card: null };
  const card = reg.owner ?? fixCardOf(db, row.project, reg.mainRun, reg.mainHead)?.card ?? null;
  const merged = card ? mergedSha(db, card) : null;
  return card && merged && SHA.test(merged) ? { kind: "fix_merged", sha: merged.toLowerCase(), card } : null;
}

/** CIF2's claim for the retry, its files cut until it fits the gate; null when not even one file fits. */
function retryClaim(w: Wire, reg: Registration, t: Trigger): string | null {
  const mainHead = w.m && SHA.test(w.m) ? w.m : t.sha;
  for (let n = reg.files.length; n > 0; n--) {
    const files = Object.fromEntries(reg.files.slice(0, n).map((f) => [f, [t.sha.slice(0, 12)]]));
    const r = behindReceipt({ prHead: w.h, mainHead, link: w.r, checks: w.n, files });
    if (r.length <= RECEIPT_MAX) return r;
  }
  return null;
}

/**
 * Ledger side, first thing in closeMergeRun (inside advanceMergeRun's transaction). Not this receipt → unchanged. Otherwise:
 * the old ci_fail bounce receipt (off / observe / no match and nothing registered / red again after this run's retry / waited
 * past WAIT_TTL_MS), null (registered or still waiting: the run unchanged), or CIF2's update claim for ciBehindClaim to journal.
 */
export function sourceWaitGate(db: Database, ctx: WriteCtx, row: MergeRun, receipt: string, drift: string | null, toReceipt: ToReceipt,
  insertEvent: WriteEvent): string | null {
  if (!receipt.startsWith(LEAD)) return receipt;
  const w = parseWire(receipt);
  if (!w) throw new LedgerError("invalid", "main 同源红判定回执格式不对");
  if (drift) throw new LedgerError("conflict", `合并运行已失效：${drift}`);
  if (w.h !== row.reviewedHead.toLowerCase() || w.n.some((c) => !row.requiredChecks.split(",").includes(c))) {
    throw new LedgerError("invalid", "main 同源红判定的 head / 检查名与本次合并不符");
  }
  const bounce = bounceOfWire(w, toReceipt), mode = sourceWaitMode(row.project), now = ctx.now ?? Date.now();
  if (mode === "off") return bounce;
  if (mode === "observe") {
    if (w.x) recordObserved(db, { project: row.project, mechanism: CI_MAIN_SOURCE_WAIT_KEY, target: row.taskId, actionKey: `wait:${w.h}:${runNumber(w.r)}:${w.a}`,
      action: `留在合并等待 main 修（与 main run ${runNumber(w.mr)} 同源：${w.f.join("、")}），不退 fix`.slice(0, 400),
      data: { intentId: row.intentId, prHead: w.h, run: w.r, attempt: w.a, mainRun: w.mr, mainHead: w.ms, files: w.f, digest: w.d, sampledAt: w.t } }, now);
    return bounce;
  }
  const retried = db.query(`SELECT 1 FROM events WHERE target=? AND kind='note' AND json_extract(data,'$.op')=? AND json_extract(data,'$.intentId')=?`)
    .get(row.taskId, RETRY_OP, row.intentId);
  if (retried) {
    verdict(db, ctx, row, w, "retry_red", `main 修好后重试仍红（${w.x ? "仍与 main 同源" : w.w}），不合并，退回 fix`, insertEvent);
    return bounce;
  }
  const prior = registrationOf(db, row);
  if (!prior && !w.x) return bounce;
  const reg = prior ?? register(db, ctx, row, w, now, insertEvent);
  if (now - reg.ts > WAIT_TTL_MS) {
    verdict(db, ctx, row, w, "expired", `等 main 修超过 ${WAIT_TTL_MS / 3_600_000} 小时仍未修好，退回 fix；main 修复责任见登记`, insertEvent);
    return bounce;
  }
  const t = triggerOf(db, row, reg, w);
  if (!t) return null;
  const claim = retryClaim(w, reg, t);
  if (!claim) return bounce;
  insertEvent(db, { actor: ctx.actor, now, dedupKey: `ci-main-source-retry:${row.intentId}` }, { project: row.project, target: row.taskId, kind: "note",
    text: t.kind === "main_green" ? `main CI 已转绿（${t.sha.slice(0, 12)}）：合入 main 更新 PR、重跑 CI，合并仍要新 head 全绿`
      : `修复卡 ${t.card} 已合入 main（${t.sha.slice(0, 12)}）：合入 main 更新 PR、重跑 CI，合并仍要新 head 全绿`,
    data: { op: RETRY_OP, intentId: row.intentId, task: row.taskId, prHead: w.h, registrationSeq: reg.seq, trigger: t.kind, sha: t.sha, card: t.card,
      main: w.k, mainRun: w.mr, mainHead: w.ms, mainNewest: w.m, sampledAt: w.t, claim } }, true);
  return claim;
}
