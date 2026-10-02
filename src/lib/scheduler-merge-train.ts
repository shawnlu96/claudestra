/**
 * Merge train (i28-MT1): ready merge cards whose PR files do not overlap are merged together into a temporary `train/<id>`
 * branch on top of main, one draft PR runs CI once, and a green train lets its members merge one by one without update-branch.
 * A red train is bisected (≤ TRAIN_MAX_DEPTH levels) down to the card that breaks it, which goes back to fix through the
 * ordinary ci_fail bounce. The train only verifies: every member still merges through its own merge run (scheduler-merge-driver.ts
 * asks `trainGate` at ready), so the merge gate, merge journal, deploy and verify stay exactly as they were.
 * One step per tick, every external effect is preceded by a saved claim, so a restart resumes instead of rebuilding.
 */
import { bounceReceipt } from "./scheduler-merge-conflict.js";
import type { MergeRun } from "./scheduler-merge.js";
import { observeBatch, TRAIN_CLOSED, trainMode } from "./scheduler-merge-train-switch.js";

const TRAIN_MIN = 2, TRAIN_MAX = 6;
export const TRAIN_MAX_DEPTH = 3;
/** A car's CI past this, or a whole train past TRAIN_DEADLINE_MS, voids the train: members fall back to the serial path. */
const TRAIN_CI_TIMEOUT_MS = 60 * 60_000;
const TRAIN_DEADLINE_MS = 6 * 60 * 60_000;
/** The only branches a train ever creates or deletes; anything else recorded in a state is refused (spec §5). */
export const TRAIN_BRANCH = /^train\/(?!.*\.\.)[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$/;

export interface TrainCandidate { taskId: string; prRef: string; head: string }
interface TrainMember extends TrainCandidate { files: string[] }
type CarStatus = "new" | "assemble" | "ci" | "green" | "red" | "split" | "dropped";
/** `created` = the branch may exist on GitHub: claimed (saved) before the create call, so cleanup deletes it even after a crash. */
interface TrainCar {
  id: string; level: number; parent: string | null; members: string[]; branch: string; created: boolean; assembled: string[];
  pr: number | null; status: CarStatus; startedAt: number; failed?: { name: string; link: string }[]; summary?: string;
}
interface TrainBounce { taskId: string; head: string; receipt: string }
type TrainPhase = "testing" | "settling" | "cleanup" | "done";
export interface TrainState {
  v: 1; id: string; seq: number; project: string; repo: string; base: string; phase: TrainPhase;
  outcome: "merged" | "void" | "serial" | null; reason: string | null;
  members: TrainMember[]; cars: TrainCar[]; cleared: string[]; merged: { taskId: string; sha: string }[];
  bounced: TrainBounce[]; serial: string[]; dropped: string[]; ciRuns: number; startedAt: number; updatedAt: number;
  /** `taskId:head` an earlier train already sent serial or bounced: regrouping them would replay the same failure. */
  skip: string[];
}
type TrainEventKind = "observe" | "form" | "conflict" | "ci" | "bisect" | "merge" | "void" | "serial" | "alarm" | "cleanup" | "done";
export interface TrainEvent { at: number; train: string; seq: number; kind: TrainEventKind; text: string; data?: Record<string, unknown> }
export interface TrainCheck { name: string; bucket: "pass" | "fail" | "pending" | "skipping" | "cancel"; link?: string }

/** GitHub side; scheduler-merge-train-gh.ts is the real one, tests pass a fake. */
export interface TrainGh {
  mainHead(repo: string): Promise<string>;
  /** null = too many files to compare reliably: such a PR never joins a train. */
  prFiles(prRef: string): Promise<string[] | null>;
  prHead(prRef: string): Promise<string>;
  /** Create the train branch at `sha`, or force it back to `sha` when a crashed attempt left it behind. */
  createBranch(repo: string, branch: string, sha: string): Promise<void>;
  /** Server-side merge (merges API); a conflict is an answer, not an error. */
  mergeInto(repo: string, branch: string, head: string, message: string): Promise<"merged" | "conflict">;
  /** Reuses an open PR for the branch (a crash after creating it) before opening a new draft. */
  openDraft(repo: string, branch: string, title: string, body: string): Promise<number>;
  checks(repo: string, pr: number): Promise<TrainCheck[]>;
  failLog(repo: string, link: string): Promise<string>;
  parents(repo: string, sha: string): Promise<string[]>;
  /** `gh pr merge --merge --match-head-commit <head>`; returns the merge commit. */
  mergeMatchHead(prRef: string, head: string): Promise<string>;
  closePr(repo: string, pr: number): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
}
export interface TrainStore {
  load(project: string): TrainState | null;
  all(): TrainState[];
  save(state: TrainState): void;
  event(project: string, ev: TrainEvent): void;
  nextSeq(project: string): number;
}
/** Ledger facts the engine needs, read by scheduler-merge-train-tick.ts. */
export type MemberStatus = { kind: "waiting" } | { kind: "merged"; sha: string } | { kind: "gone"; why: string; moved?: boolean };
export interface TrainDeps {
  gh: TrainGh; store: TrainStore; now(): number; requiredChecks: readonly string[];
  memberStatus(taskId: string, head: string): MemberStatus;
  /** PM-visible notice; `alarm` marks the ones PM must act on. Failures are the caller's to log. */
  notify(state: TrainState, text: string, alarm: boolean): Promise<void>;
}
export type TrainGate = "cleared" | "wait" | { bounce: string } | null;
type Io = Pick<TrainDeps, "store" | "now" | "notify">;

const short = (s: string) => s.slice(0, 12);
const sameSha = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const repoOfPr = (prRef: string): string => {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1];
  if (!repo) throw new Error("PR URL 不合法");
  return repo;
};
const member = (s: TrainState, taskId: string) => s.members.find((m) => m.taskId === taskId)!;
const names = (s: TrainState, ids: readonly string[]) => ids.join("、") || "（无）";
const trainLabel = (s: TrainState): string => `第 ${s.seq} 辆车 ${s.id}`;
const STEP_TEXT: Record<TrainPhase, string> = { testing: "拼车 / 跑 CI", settling: "逐张合并", cleanup: "收尾", done: "已结束" };
/** One line for PM's board: which train, which cards, which step. */
export const trainView = (s: TrainState): string => `${trainLabel(s)}：${names(s, s.members.map((m) => m.taskId))}，${STEP_TEXT[s.phase]}` +
  `，CI ${s.ciRuns} 次${s.outcome ? `，结果 ${s.outcome}` : ""}`;

async function emit(s: TrainState, deps: Io, kind: TrainEventKind, text: string, data?: Record<string, unknown>, notify = false, alarm = false) {
  deps.store.event(s.project, { at: deps.now(), train: s.id, seq: s.seq, kind, text, ...(data ? { data } : {}) });
  if (notify || alarm) await deps.notify(s, `[合并列车] ${trainLabel(s)}：${text}`, alarm);
}
const save = (s: TrainState, deps: Io) => { s.updatedAt = deps.now(); deps.store.save(s); };

/** Greedy in queue order: a card joins when none of its files is already in the batch. Fewer than TRAIN_MIN = no train. */
function pickBatch(cands: readonly TrainMember[]): TrainMember[] {
  const batch: TrainMember[] = [], used = new Set<string>();
  for (const c of cands) {
    if (batch.length >= TRAIN_MAX) break;
    if (!c.files.length || c.files.some((f) => used.has(f))) continue;
    batch.push(c);
    for (const f of c.files) used.add(f);
  }
  return batch.length >= TRAIN_MIN ? batch : [];
}

const newCar = (s: TrainState, id: string, level: number, parent: string | null, members: string[], now: number): TrainCar =>
  ({ id, level, parent, members, branch: `train/${id}`, created: false, assembled: [], pr: null, status: "new", startedAt: now });

export const skipKey = (c: { taskId: string; head: string }) => `${c.taskId}:${c.head.toLowerCase()}`;
/** What the next train must leave out: the last one's skip list plus, unless it was void, the cards it sent serial or bounced. */
export function nextSkip(prev: TrainState | null): string[] {
  if (!prev) return [];
  const own = prev.outcome === "void" ? [] : [...prev.serial.map((id) => member(prev, id)), ...prev.bounced].map(skipKey);
  return [...new Set([...(prev.skip ?? []), ...own])];
}

/** Form at most one train per project; the caller only asks when the project has no live train. */
export async function formTrain(project: string, all: readonly TrainCandidate[], deps: TrainDeps,
  files: (c: TrainCandidate) => Promise<string[] | null> = (c) => deps.gh.prFiles(c.prRef), skipped: readonly string[] = []): Promise<TrainState | null> {
  const cands = all.filter((c) => !skipped.includes(skipKey(c)));
  if (cands.length < TRAIN_MIN || trainMode(project) === "off") return null;
  const repo = repoOfPr(cands[0]!.prRef);
  const listed: TrainMember[] = [];
  for (const c of cands) {
    if (repoOfPr(c.prRef) !== repo) continue;
    const f = await files(c);
    if (f) listed.push({ ...c, files: [...new Set(f)].sort() });
  }
  const batch = pickBatch(listed), mode = trainMode(project); // re-read: the switch may have moved while files were listed
  if (!batch.length || mode !== "on") return batch.length && mode === "observe" ? observeBatch(project, batch, deps) : null; // off: nothing written
  const base = await deps.gh.mainHead(repo), now = deps.now(), seq = deps.store.nextSeq(project);
  const id = `${seq.toString(36)}-${now.toString(36).slice(-5)}`;
  const s: TrainState = { v: 1, id, seq, project, repo, base, phase: "testing", outcome: null, reason: null, members: batch, cars: [],
    cleared: [], merged: [], bounced: [], serial: [], dropped: [], ciRuns: 0, startedAt: now, updatedAt: now,
    skip: skipped.filter((k) => all.some((c) => skipKey(c) === k)) };
  s.cars.push(newCar(s, id, 0, null, batch.map((m) => m.taskId), now));
  save(s, deps);
  await emit(s, deps, "form", `组车 ${batch.length} 张：${names(s, batch.map((m) => m.taskId))}，起点 main ${short(base)}`,
    { members: batch.map((m) => ({ taskId: m.taskId, head: m.head, files: m.files.length })), base }, true);
  return s;
}

/** Void: whatever already merged stays merged (its own merge run recorded it), the rest regroups next tick. */
async function voidTrain(s: TrainState, deps: Io, reason: string): Promise<void> {
  if (s.phase === "cleanup" || s.phase === "done") return;
  s.phase = "cleanup"; s.outcome = "void"; s.reason = reason;
  save(s, deps);
  await emit(s, deps, "void", `作废：${reason}；已合并 ${names(s, s.merged.map((m) => m.taskId))}，其余回去重新组车`, { reason }, true);
}

async function toSerial(s: TrainState, deps: TrainDeps, ids: readonly string[], why: string): Promise<void> {
  const fresh = ids.filter((id) => !s.serial.includes(id));
  if (!fresh.length) return;
  s.serial.push(...fresh);
  await emit(s, deps, "serial", `${names(s, fresh)} 回串行路径：${why}`, { members: fresh });
}

/** Members' heads and main must be what the train was built from; otherwise the train tested something else. */
async function drifted(s: TrainState, deps: TrainDeps, ids: readonly string[]): Promise<string | null> {
  for (const id of ids) {
    const m = member(s, id), st = deps.memberStatus(id, m.head);
    if (st.kind === "gone") return `${id} 已离开合并队列：${st.why}`;
    const head = await deps.gh.prHead(m.prRef);
    if (!sameSha(head, m.head)) return `${id} head 变成 ${short(head)}`;
  }
  return null;
}

async function assemble(s: TrainState, car: TrainCar, deps: TrainDeps): Promise<void> {
  if (car.status === "new") {
    if (!TRAIN_BRANCH.test(car.branch)) throw new Error(`列车分支名不合法：${car.branch}`);
    if (!car.created) { car.created = true; save(s, deps); } // claim first: a create that landed before a crash is still cleaned up
    await deps.gh.createBranch(s.repo, car.branch, s.base);
    car.status = "assemble";
    save(s, deps);
  }
  for (const id of [...car.members]) {
    if (car.assembled.includes(id)) continue;
    const m = member(s, id);
    const got = await deps.gh.mergeInto(s.repo, car.branch, m.head, `merge train ${s.id}: ${id} ${short(m.head)}`);
    if (got === "conflict") {
      car.members = car.members.filter((x) => x !== id);
      await emit(s, deps, "conflict", `${id} 拼车冲突，踢出本批`, { taskId: id, car: car.id });
      await toSerial(s, deps, [id], "拼车冲突");
    } else car.assembled.push(id);
    save(s, deps);
  }
  if (car.members.length < (car.level === 0 ? TRAIN_MIN : 1)) {
    await toSerial(s, deps, car.members, "拼车后不足两张");
    car.status = "dropped";
    return save(s, deps);
  }
  car.pr = await deps.gh.openDraft(s.repo, car.branch, `[merge train ${s.id}] ${car.members.join(", ")}`,
    `合并列车 ${trainLabel(s)}，车厢 ${car.id}（第 ${car.level} 层），只跑 CI，不合并。成员：${car.members.join("、")}`);
  car.status = "ci"; car.startedAt = deps.now(); s.ciRuns++;
  save(s, deps);
}

/** red = any check failed or cancelled; green = every required check passed and nothing is pending. */
function ciVerdict(checks: readonly TrainCheck[], required: readonly string[]): "green" | "red" | "pending" {
  if (checks.some((c) => c.bucket === "fail" || c.bucket === "cancel")) return "red";
  if (checks.some((c) => c.bucket === "pending")) return "pending";
  return required.every((n) => checks.some((c) => c.name === n && c.bucket === "pass")) ? "green" : "pending";
}

const oneLine = (t: string) => t.replace(/[\s\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").trim();

async function redCar(s: TrainState, car: TrainCar, checks: readonly TrainCheck[], deps: TrainDeps): Promise<void> {
  const failed = checks.filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => ({ name: c.name, link: typeof c.link === "string" && /^https:\/\/\S+$/.test(c.link) ? c.link : "" }));
  let summary = "";
  try { summary = oneLine(await deps.gh.failLog(s.repo, failed.find((f) => f.link)?.link ?? "")).slice(0, 200); }
  catch (e) { summary = `日志没取到：${oneLine((e as Error).message).slice(0, 120)}`; } // the bounce still names the checks and links
  car.status = "red"; car.failed = failed; car.summary = summary;
  await emit(s, deps, "ci", `车厢 ${car.id}（${names(s, car.members)}）CI 红：${failed.map((f) => f.name).join("、")}；${summary}`,
    { car: car.id, level: car.level, result: "red", failed, pr: car.pr }, true);
  if (car.members.length === 1) {
    const id = car.members[0]!, m = member(s, id);
    const req = failed.filter((f) => deps.requiredChecks.includes(f.name));
    if (!req.length) return toSerial(s, deps, [id], "单独跑红的是非必需检查，退回串行路径由它自己的 CI 判");
    const receipt = bounceReceipt({ cause: "ci_fail", prHead: m.head, mainHead: null,
      checks: req.map((f) => ({ name: f.name, link: `${f.link} 列车 ${s.id} 日志摘要：${summary}`.trim() })) });
    s.bounced.push({ taskId: id, head: m.head, receipt });
    return emit(s, deps, "bisect", `定位到 ${id} 让 CI 变红，等它拿到合并槽时退回 fix`, { taskId: id, receipt }, true);
  }
  if (car.level >= TRAIN_MAX_DEPTH) return giveUp(s, deps, `二分 ${TRAIN_MAX_DEPTH} 层仍定位不到`);
  const half = Math.ceil(car.members.length / 2);
  const kids = [car.members.slice(0, half), car.members.slice(half)].map((ids, i) =>
    newCar(s, `${car.id}${i ? "b" : "a"}`, car.level + 1, car.id, ids, deps.now()));
  car.status = "split";
  s.cars.push(...kids);
  await emit(s, deps, "bisect", `第 ${car.level + 1} 层二分：${kids.map((k) => `[${names(s, k.members)}]`).join(" / ")}`,
    { car: car.id, level: car.level + 1, halves: kids.map((k) => k.members) }, true);
}

/** Bisect could not pin it down: the whole batch goes serial and PM hears about it. */
async function giveUp(s: TrainState, deps: TrainDeps, why: string): Promise<void> {
  s.cleared = [];
  await toSerial(s, deps, s.members.map((m) => m.taskId).filter((id) => !s.bounced.some((b) => b.taskId === id)), why);
  for (const car of s.cars) if (["new", "assemble", "ci"].includes(car.status)) car.status = "dropped";
  s.phase = "cleanup"; s.outcome = "serial"; s.reason = why;
  save(s, deps);
  await emit(s, deps, "alarm", `${why}，整批回串行路径，请 PM 看看（CI ${s.ciRuns} 次）`, { reason: why }, true, true);
}

const ACTIVE: readonly CarStatus[] = ["new", "assemble", "ci"];

async function stepTesting(s: TrainState, deps: TrainDeps): Promise<void> {
  if (deps.now() - s.startedAt > TRAIN_DEADLINE_MS) return voidTrain(s, deps, "列车超过总时限");
  const main = await deps.gh.mainHead(s.repo);
  if (!sameSha(main, s.base)) return voidTrain(s, deps, `列车 CI 期间 main 前进到 ${short(main)}`);
  const live = s.cars.filter((c) => ACTIVE.includes(c.status));
  const why = await drifted(s, deps, [...new Set(live.flatMap((c) => c.members))]);
  if (why) return voidTrain(s, deps, why);
  for (const car of live) {
    if (s.phase !== "testing") return;
    if (car.status !== "ci") { await assemble(s, car, deps); continue; }
    const checks = await deps.gh.checks(s.repo, car.pr!), verdict = ciVerdict(checks, deps.requiredChecks);
    if (verdict === "pending") {
      if (deps.now() - car.startedAt > TRAIN_CI_TIMEOUT_MS) return voidTrain(s, deps, `车厢 ${car.id} CI 超时`);
      continue;
    }
    if (verdict === "red") await redCar(s, car, checks, deps);
    else {
      car.status = "green";
      s.cleared.push(...car.members.filter((id) => !s.cleared.includes(id)));
      await emit(s, deps, "ci", `车厢 ${car.id}（${names(s, car.members)}）CI 绿`, { car: car.id, level: car.level, result: "green", pr: car.pr }, true);
    }
    save(s, deps);
  }
  if (s.phase !== "testing" || s.cars.some((c) => ACTIVE.includes(c.status))) return;
  // A red car whose halves all came back green failed only in combination: nothing to bounce, so nothing is trusted.
  const lost = s.cars.find((c) => c.status === "split" && !s.cars.some((k) => k.parent === c.id && (k.status === "red" || k.status === "split")));
  if (lost) return giveUp(s, deps, `车厢 ${lost.id} 整体红、拆开都绿，定位不到`);
  s.phase = s.cleared.length || s.bounced.length ? "settling" : "cleanup";
  if (s.phase === "cleanup") s.outcome = "serial";
  save(s, deps);
}

/** main since the train's base holds nothing but merges of cleared members (first parent = previous main). */
async function mainOnlyMembers(s: TrainState, mainHead: string, gh: TrainGh): Promise<boolean> {
  const heads = new Set(s.members.filter((m) => s.cleared.includes(m.taskId)).map((m) => m.head.toLowerCase()));
  let cur = mainHead;
  for (let i = 0; i <= s.members.length; i++) {
    if (sameSha(cur, s.base)) return true;
    const parents = await gh.parents(s.repo, cur);
    if (parents.length !== 2 || !heads.has(parents[1]!.toLowerCase())) return false;
    cur = parents[0]!;
  }
  return false;
}

const unsettled = (s: TrainState): string[] => [...s.cleared, ...s.bounced.map((b) => b.taskId)]
  .filter((id) => !s.merged.some((m) => m.taskId === id) && !s.dropped.includes(id));

async function stepSettling(s: TrainState, deps: TrainDeps): Promise<void> {
  for (const id of unsettled(s)) {
    const st = deps.memberStatus(id, member(s, id).head);
    if (st.kind === "merged") {
      s.merged.push({ taskId: id, sha: st.sha });
      await emit(s, deps, "merge", `${id} 已合并 ${short(st.sha)}`, { taskId: id, sha: st.sha });
    } else if (st.kind === "gone") { // a verified member may leave (PM hold, stage), but never with another head
      const moved = !s.cleared.includes(id) ? null : st.moved ? st.why : await headMoved(s, id, deps.gh);
      if (moved) return voidTrain(s, deps, `${id} ${moved}`);
      s.dropped.push(id);
    }
    save(s, deps);
  }
  const left = unsettled(s).filter((id) => s.cleared.includes(id));
  if (left.length) {
    if (deps.now() - s.startedAt > TRAIN_DEADLINE_MS) return voidTrain(s, deps, "列车超过总时限");
    const why = await drifted(s, deps, left);
    if (why) return voidTrain(s, deps, why);
    if (!(await mainOnlyMembers(s, await deps.gh.mainHead(s.repo), deps.gh))) return voidTrain(s, deps, "main 自列车起点以来多了非本批的提交");
  }
  if (unsettled(s).length) return;
  s.phase = "cleanup"; s.outcome = s.merged.length ? "merged" : "void";
  save(s, deps);
}

/** Remote heads of every verified member still to merge: one moved = the train tested something else (a crash can't hide it). */
async function headsMoved(s: TrainState, gh: TrainGh): Promise<string | null> {
  for (const id of unsettled(s).filter((x) => s.cleared.includes(x))) { const moved = await headMoved(s, id, gh); if (moved) return `${id} ${moved}`; }
  return null;
}
const headMoved = async (s: TrainState, id: string, gh: TrainGh): Promise<string | null> => {
  const m = member(s, id), head = await gh.prHead(m.prRef); return sameSha(head, m.head) ? null : `head 变成 ${short(head)}`;
};

/** Close this train's PRs and delete only its own recorded `train/` branches. */
async function stepCleanup(s: TrainState, deps: TrainDeps): Promise<void> {
  const refused: string[] = [];
  for (const car of s.cars) {
    if (car.pr != null) { await deps.gh.closePr(s.repo, car.pr); car.pr = null; save(s, deps); }
    if (!car.created && car.status === "new") continue; // never claimed on GitHub
    if (!TRAIN_BRANCH.test(car.branch)) { refused.push(car.branch); continue; }
    await deps.gh.deleteBranch(s.repo, car.branch);
    car.created = false; car.status = car.status === "new" ? "dropped" : car.status;
    save(s, deps);
  }
  if (refused.length) await emit(s, deps, "alarm", `状态里记了非 train/ 分支 ${refused.join("、")}，拒绝删除`, { refused }, true, true);
  await emit(s, deps, "cleanup", `已关临时 PR、删临时分支`, { branches: s.cars.map((c) => c.branch).filter((b) => TRAIN_BRANCH.test(b)) });
  s.phase = "done";
  save(s, deps);
  await emit(s, deps, "done", `结束（${s.outcome ?? "void"}）：合并 ${names(s, s.merged.map((m) => m.taskId))}，退回 ${names(s, s.bounced.map((b) => b.taskId))}` +
    `，串行 ${names(s, s.serial)}，CI ${s.ciRuns} 次`, { outcome: s.outcome, ciRuns: s.ciRuns }, true);
}

export async function stepTrain(s: TrainState, deps: TrainDeps): Promise<TrainState> { // one step of a live train
  if (trainMode(s.project) !== "on") await voidTrain(s, deps, TRAIN_CLOSED); // switched to off / observe (i28-MT1sw): members go serial
  if (s.phase === "testing") await stepTesting(s, deps);
  else if (s.phase === "settling") await stepSettling(s, deps);
  else if (s.phase === "cleanup") await stepCleanup(s, deps);
  return s;
}

/**
 * Asked by the merge driver at ready and at await_ci, before any update-branch or merge (scheduler-merge-driver.ts): wait while this
 * card's train is testing, bounce the card the bisect pinned, clear a verified member to skip update-branch only while every
 * verified member's remote head is still the tested one and main holds only this train's merges; else void. null = serial path.
 */
export async function trainGate(s: TrainState | null, run: MergeRun, deps: Io & Pick<TrainDeps, "gh">): Promise<TrainGate> {
  if (!s || (s.phase !== "testing" && s.phase !== "settling") || trainMode(s.project) !== "on") return null;
  const m = s.members.find((x) => x.taskId === run.taskId && sameSha(x.head, run.reviewedHead) && x.prRef === run.prRef);
  if (!m || s.serial.includes(m.taskId) || s.dropped.includes(m.taskId) || s.merged.some((x) => x.taskId === m.taskId)) return null;
  const bounce = s.bounced.find((b) => b.taskId === m.taskId && sameSha(b.head, m.head));
  if (bounce) return { bounce: bounce.receipt };
  if (s.phase === "testing") return "wait";
  if (!s.cleared.includes(m.taskId)) return null;
  const why = await verdictNow(s, deps.gh);
  if (!why) return "cleared";
  await voidTrain(s, deps, `合并前核对：${why}`);
  return null;
}

/** Every verified member's remote head as tested and main = base + this train's merges only; the reason it fails, or null. */
async function verdictNow(s: TrainState, gh: TrainGh): Promise<string | null> {
  return await headsMoved(s, gh) ?? (await mainOnlyMembers(s, await gh.mainHead(s.repo), gh) ? null : "main 自列车起点以来多了非本批的提交");
}

/** Recheck after the durable merging claim: a moved main or sibling voids the train before the merge API. */
export async function recheckCleared(s: TrainState, deps: Io & Pick<TrainDeps, "gh">): Promise<void> {
  const why = await verdictNow(s, deps.gh);
  if (!why) return;
  await voidTrain(s, deps, `合并前核对：${why}`);
  throw new Error(`合并前核对：${why}，列车 ${s.id} 作废，不发合并`);
}
/** The verified member the merge override may merge with `--match-head-commit` (any project's settling train). */
export function clearedMember(states: readonly TrainState[], prRef: string, head: string): TrainState | null {
  return states.find((s) => s.phase === "settling" && trainMode(s.project) === "on" && s.members.some((m) => m.prRef === prRef && sameSha(m.head, head) &&
    s.cleared.includes(m.taskId) && !s.merged.some((x) => x.taskId === m.taskId))) ?? null;
}
