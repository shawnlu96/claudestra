/**
 * The auto tick's side of the merge handoff (scheduler-merge-handoff.ts): where a local-merge project would plan its merge
 * intent, a handoff project's card is handed to the repository owner and then only watched until its PR is merged or closed.
 * Every road here either writes through the scheduler CLI or gives the card to PM; nothing merges, updates a branch, forms a
 * train or plans a merge intent. tests/scheduler-merge-handoff.test.ts, tests/scheduler-merge-handoff-carry.test.ts.
 */
import { asInfo } from "./pm-notice-level.js";
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { ghEnv } from "./peer-pr-github.js";
import { WHOLE_DIFF_ARGS } from "./git-diff-args.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { CarryUndecidable, MAIN_REF, mainMergeCarry, type MainMergeCarry } from "./scheduler-main-merge-carry.js";
import { handoffNarrowSettled, handoffOf, narrowHandoffLocks, type HandoffFollow } from "./scheduler-merge-handoff.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { pendingRemoteBounce, remoteBounceRefusal } from "./remote-review-bounce.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import type { PmNoticeLevel } from "./pm-notice-level.js";

/**
 * `carry`: asked to follow a head and the PR sits on another one, whether it got there only by merging main in.
 * `files`: asked while the handoff's narrowing is unsettled (`handing`), the PR's changed paths at its head (null = could not tell).
 */
export interface HandoffPr {
  state: "OPEN" | "MERGED" | "CLOSED"; head: string; mergeSha: string | null; carry?: MainMergeCarry; files?: PrFiles | null;
  /** The PR's base branch as GitHub reports it: a handoff is only ever about main, a PR retargeted elsewhere goes to PM. */
  base?: string;
  /** MERGED after the handoff: whether the configured clone's main holds the merge commit (only then may the card go live). */
  landing?: MainLanding;
  /** GitHub's isDraft (absent = not reported: neither turned ready nor back to a draft). */
  draft?: boolean;
  /** Why `gh pr ready` (or `--undo`) refused to move the PR to the draft state asked for this time: tried again on a later read. */
  flipError?: string;
}
/** `mainHead` = the main commit, read from the PR repository's main, that was found to contain the merge commit. */
type MainLanding = { ok: true; mainHead: string } | { ok: false; reason: string };
/** Whether the PR repository's main (fetched into the project's clone) contains this merge commit. A failed git step throws. */
export type HandoffOnMain = (prRef: string, mergeSha: string) => Promise<MainLanding>;
/** `refused`: reading this head again gives the same answer (the list is too long to vouch for); recorded once, locks stay whole. */
type PrFiles = string[] | { refused: string };
/**
 * `follow` = the PR head this machine follows after the handoff (absent before it). A failed read or git step throws. A PR read
 * OPEN at the followed head is moved to the draft state its stage wants (RRL-3: the owner's queue skips drafts): ready once
 * handed over, back to a draft with `want: "draft"` (an owner P1 sending it back to fix).
 */
export type ReadPr = (prRef: string, follow?: { project: string; head: string }, handing?: { project: string }, want?: "draft") => Promise<HandoffPr>;
/** The PR's net changed paths (merge-base with main → head, renames as both sides); null when the clone cannot tell this time. */
export type HandoffFiles = (prRef: string, head: string) => Promise<PrFiles | null>;
/** `mergeSha` set = the PR is merged: its main parent must be on main before that merge, not on the main that now holds the PR. */
export type HandoffCarry = (prRef: string, oldHead: string, newHead: string, mergeSha: string | null) => Promise<MainMergeCarry>;
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface HandoffCard<O> {
  db: Database;
  task: LedgerTask;
  deps: { manager: Manager; notifyPm(task: LedgerTask, text: string, level: PmNoticeLevel): Promise<void>; now(): number; prState?: ReadPr };
  out(step: string, detail: string): O;
  escalate(reason: string): Promise<O>;
}

/** A handed-over PR can wait days for its owner: read it at most once a minute, not every pass. */
export const HANDOFF_POLL_MS = 60_000;
const polled = new WeakMap<Database, Map<string, number>>();
const SHA = /^[a-f0-9]{40}$/i;
/** Half runBounded's output cap: a changed-file list this long is read as "cannot tell" (no narrowing). */
const LIST_CAP = 512 * 1024;
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const short = (s: string | null | undefined): string => (s ?? "（无）").slice(0, 12);
/** A base GitHub reported that is not main; an unreported one is judged at landing (no proof of main → held). */
const offMain = (pr: HandoffPr): boolean => pr.base !== undefined && pr.base !== "main";

/**
 * `gh pr view` of a full PR URL; anything malformed throws, so the caller skips the round instead of acting on a guess. A moved
 * head is checked against the project's repoDir from scheduler.json; a project without one gets no carry, so it goes to PM.
 */
export function ghPrState(command: typeof runBounded = runBounded,
  carryOf: (project: string) => HandoffCarry | null = (project) => {
    const dir = readSchedulerConfig().projects[project]?.repoDir;
    return dir ? handoffCarry(dir, command) : null;
  },
  filesOf: (project: string) => HandoffFiles | null = (project) => {
    const dir = readSchedulerConfig().projects[project]?.repoDir;
    return dir ? handoffFiles(dir, command) : null;
  },
  mainOf: (project: string) => HandoffOnMain | null = (project) => {
    const dir = readSchedulerConfig().projects[project]?.repoDir;
    return dir ? handoffOnMain(dir, command) : null;
  }): ReadPr {
  return async (prRef, follow, handing, want) => {
    const read = await ghPrRead(prRef, command, 30_000);
    if (!read.ok) throw new Error(read.message);
    const { pr } = read, { mergeSha } = pr;
    // a PR retargeted off main goes to PM: neither its files, its carry nor its landing are worth a git read
    if (offMain(pr)) return pr;
    const files = handing && pr.state === "OPEN" ? { files: await prFiles(filesOf(handing.project), prRef, pr.head) } : {};
    const landing = follow && pr.state === "MERGED" && mergeSha ? { landing: await mainLanding(mainOf(follow.project), prRef, pr.base, mergeSha) } : {};
    // only the head that was handed over: a PR moved off it goes to PM or is carried first, never readied on a guess
    const at = follow && pr.state === "OPEN" && same(pr.head, follow.head);
    const flip = !at ? {} : want === "draft" ? (pr.draft === false ? await setDraft(prRef, command, true) : {}) : pr.draft ? await setDraft(prRef, command, false) : {};
    const full: HandoffPr = { ...pr, ...files, ...landing, ...flip };
    // CLOSED goes to PM anyway; MERGED without its merge commit is read again next round
    if (!follow || same(pr.head, follow.head) || pr.state === "CLOSED" || (pr.state === "MERGED" && !mergeSha)) return full;
    const carry = carryOf(follow.project);
    return carry ? { ...full, carry: await carry(prRef, follow.head, pr.head, pr.state === "MERGED" ? mergeSha : null) } : full;
  };
}

/**
 * One `gh pr view` of a full PR URL. A refusal carries the old thrown message (`message`, stderr's first line included) and, apart
 * from it, a class and exit code only (`kind`, `code`): a private repository's stderr may name its remote (PRIVLOCK2).
 */
export type GhPrRead = { ok: true; pr: HandoffPr } | { ok: false; kind: "timeout" | "failed" | "malformed"; code: number | null; message: string };
export async function ghPrRead(prRef: string, command: typeof runBounded, timeoutMs: number): Promise<GhPrRead> {
  const r = await command(["gh", "pr", "view", prRef, "--json", "state,headRefOid,mergeCommit,baseRefName,isDraft"], { env: ghEnv(), timeoutMs });
  if (r.code !== 0 || r.timedOut) {
    return { ok: false, kind: r.timedOut ? "timeout" : "failed", code: r.code ?? null,
      message: `gh pr view 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}` };
  }
  let raw: { state?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null; baseRefName?: unknown; isDraft?: unknown };
  try { raw = JSON.parse(r.stdout); } catch (e) { return { ok: false, kind: "malformed", code: 0, message: (e as Error).message }; }
  const mergeSha = typeof raw?.mergeCommit?.oid === "string" && SHA.test(raw.mergeCommit.oid) ? raw.mergeCommit.oid : null;
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(raw?.state)) || typeof raw.headRefOid !== "string" || !SHA.test(raw.headRefOid)) {
    return { ok: false, kind: "malformed", code: 0, message: "gh pr view 输出不合规" };
  }
  return { ok: true, pr: { state: raw.state as HandoffPr["state"], head: raw.headRefOid, mergeSha,
    ...(typeof raw.baseRefName === "string" ? { base: raw.baseRefName } : {}), ...(typeof raw.isDraft === "boolean" ? { draft: raw.isDraft } : {}) } };
}

/** `gh pr ready [--undo]` of a full PR URL: the PR's new draft state, or why not (stderr's first line, as ghPrRead's refusal carries it). */
async function setDraft(prRef: string, command: typeof runBounded, draft: boolean): Promise<Pick<HandoffPr, "draft" | "flipError">> {
  const argv = ["gh", "pr", "ready", prRef, ...(draft ? ["--undo"] : [])];
  const r = await command(argv, { env: ghEnv(), timeoutMs: 30_000 });
  if (r.code === 0 && !r.timedOut) return { draft };
  return { flipError: `gh pr ready${draft ? " --undo" : ""} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}` };
}

/** `owner/repo` (lowercased) of an origin on exactly github.com — scp form `git@github.com:o/r`, `https://` or `ssh://` — else null. */
function githubRepoOf(url: string): string | null {
  const repo = /^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
  const scp = /^git@github\.com:(.+)$/i.exec(url);
  if (scp) return repo.exec(scp[1]!)?.[1]?.toLowerCase() ?? null;
  let u: URL;
  try { u = new URL(url); } catch { return null; /* neither scp form nor a URL: names no repository to vouch for */ }
  if (!["https:", "ssh:"].includes(u.protocol) || u.hostname.toLowerCase() !== "github.com" || u.port) return null;
  return repo.exec(u.pathname.slice(1))?.[1]?.toLowerCase() ?? null;
}

/**
 * Local git in the project's clone (git output is read like the local merge driver's), and only when its origin
 * as configured is the PR repository on github.com itself (checked before any fetch): another repository's main vouches for
 * nothing. Refusals no retry changes are `ok: false`.
 */
function gitIn(repoDir: string, command: typeof runBounded, timeoutMs = 120_000) {
  const raw = gitRaw(repoDir, command, timeoutMs);
  return async (...args: string[]) => {
    const r = await raw(...args);
    if (r.code !== 0 || r.timedOut) throw new GitStepFailed(args[0]!, r.timedOut ? null : r.code ?? null,
      `git ${args[0]} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
}
/** A failed git step: the message as before, and apart from it the step and exit code (null = timed out) without stderr (PRIVLOCK2). */
export class GitStepFailed extends Error {
  constructor(readonly step: string, readonly code: number | null, message: string) { super(message); this.name = "GitStepFailed"; }
}
/** The bare git step in the project's clone, exit code and all (for a question whose `no` is exit 1). */
function gitRaw(repoDir: string, command: typeof runBounded, timeoutMs = 120_000) {
  return (...args: string[]) => command(["git", ...args], { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
}

/** `owner/repo` of a full PR URL when the clone's origin is that very repository, else null (checked before any fetch). */
async function prRepoIn(git: ReturnType<typeof gitIn>, prRef: string): Promise<string | null> {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1]?.toLowerCase();
  return repo && githubRepoOf((await git("config", "--get", "remote.origin.url")).trim()) === repo ? repo : null;
}

export function handoffCarry(repoDir: string, command: typeof runBounded = runBounded): HandoffCarry {
  const git = gitIn(repoDir, command);
  return async (prRef, oldHead, newHead, mergeSha) => {
    const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+\/?$/.exec(prRef)?.[1]?.toLowerCase();
    if (!repo || ![oldHead, newHead, mergeSha ?? oldHead].every((s) => SHA.test(s))) return { ok: false, reason: "PR 或 head 不是完整的 URL / SHA" };
    if (!(await prRepoIn(git, prRef))) return { ok: false, reason: `repoDir 的 origin 不是 PR 仓库 ${repo}` };
    await git("fetch", "--no-tags", "--quiet", "origin", newHead, ...(mergeSha ? [mergeSha] : []), `+refs/heads/main:${MAIN_REF}`);
    try {
      return await mainMergeCarry(git, command, repoDir, oldHead, newHead, mergeSha ? `${mergeSha}^1` : MAIN_REF);
    } catch (e) {
      if (e instanceof CarryUndecidable) return { ok: false, reason: e.message };
      throw e;
    }
  };
}

/** Only a base reported as main, checked in the project's own clone, proves a landing; anything else is a refusal (held). */
async function mainLanding(onMain: HandoffOnMain | null, prRef: string, base: string | undefined, mergeSha: string): Promise<MainLanding> {
  if (base !== "main") return { ok: false, reason: `读不出 PR 合进的分支（base ${base ?? "（无）"}）` };
  if (!onMain) return { ok: false, reason: "项目没配 repoDir，核对不了 main 是否含合并提交" };
  try { return await onMain(prRef, mergeSha); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return { ok: false, reason: `核对 main 是否含合并提交失败：${(e as Error).message}` };
  }
}

/** Same clone and origin check as a carry: fetch the PR repository's main and ask git whether the merge commit is on it. */
export function handoffOnMain(repoDir: string, command: typeof runBounded = runBounded): HandoffOnMain {
  const git = gitIn(repoDir, command);
  return async (prRef, mergeSha) => {
    if (!SHA.test(mergeSha) || !(await prRepoIn(git, prRef))) return { ok: false, reason: "合并提交不是完整 SHA，或 repoDir 的 origin 不是 PR 仓库" };
    await git("fetch", "--no-tags", "--quiet", "origin", `+refs/heads/main:${MAIN_REF}`);
    const mainHead = (await git("rev-parse", "--verify", `${MAIN_REF}^{commit}`)).trim();
    if (!SHA.test(mainHead)) throw new Error(`main 读出来不是完整 SHA：${mainHead.slice(0, 60)}`);
    const r = await gitRaw(repoDir, command)("merge-base", "--is-ancestor", mergeSha, mainHead);
    if (r.code === 0 && !r.timedOut) return { ok: true, mainHead };
    if (r.code === 1 && !r.timedOut) return { ok: false, reason: `main（${short(mainHead)}）还不含合并提交 ${short(mergeSha)}` };
    throw new Error(`git merge-base 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
  };
}

/** Same clone and origin check as a carry; the three-dot diff is what GitHub lists as the PR's files. */
export function handoffFiles(repoDir: string, command: typeof runBounded = runBounded, timeoutMs = 120_000): HandoffFiles {
  const git = gitIn(repoDir, command, timeoutMs);
  return async (prRef, head) => {
    if (!SHA.test(head) || !(await prRepoIn(git, prRef))) return null;
    await git("fetch", "--no-tags", "--quiet", "origin", head, `+refs/heads/main:${MAIN_REF}`);
    const out = await git("diff", "--name-only", ...WHOLE_DIFF_ARGS, "-z", `${MAIN_REF}...${head}`);
    // runBounded cuts output at 1 MiB without saying so: a list that may be cut short would give away locks on files it lost
    if (Buffer.byteLength(out) >= LIST_CAP || (out && !out.endsWith("\0"))) return { refused: "PR 改动文件列表太长，读不全" };
    return out.split("\0").filter(Boolean);
  };
}

/** Narrowing is optional: a clone that cannot answer leaves the card's locks whole, it never holds the handoff up. */
async function prFiles(files: HandoffFiles | null, prRef: string, head: string): Promise<PrFiles | null> {
  if (!files) return null;
  try { return await files(prRef, head); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] ${prRef} 读不出 PR 改动文件，交接后文件锁不收窄：${(e as Error).message}`);
    return null;
  }
}

/**
 * Best effort: the ledger event is the durable record; a stop still ends the pass. `routine` = 只记卡片不送 PM（交接进度）；
 * 合并落地要 PM 本机跟上 main 再 verify，没人推就停在 live，所以那条不能标常规（tests/pm-notice-level.test.ts）。
 */
const tell = (c: HandoffCard<unknown>, text: string, routine = false): Promise<void> => {
  const send = () => c.deps.notifyPm(c.task, text, routine ? "info" : "action");
  return (routine ? asInfo(send) : send()).catch((e) => {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] ${c.task.id} 合并交接通知没发出去（台账已记）：${(e as Error).message}`);
  });
};

/**
 * The owner merged main into the PR after the handoff: record the move when only main came in (the review still covers the
 * PR), otherwise PM. Hops are judged one at a time from the head followed so far; two unseen between reads go to PM too.
 */
async function followMoved<O>(c: HandoffCard<O>, follow: HandoffFollow, pr: HandoffPr): Promise<O | null> {
  const { carry } = pr, moved = `交接后 PR head 变了（${short(follow.head)} → ${short(pr.head)}）`;
  if (!carry?.ok || !carry.mainParent || !carry.mainHead || !carry.diffHash || !carry.basis) {
    return c.escalate(`${moved}，${carry?.reason ?? "没核对是否只合入了 main"}：本机审查证据只覆盖交接的 head`);
  }
  const r = await c.deps.manager("ledger", "scheduler-merge-handoff", c.task.id, "--head", follow.evidence.head, "--pr", follow.evidence.pr,
    "--carry", pr.head, "--from", follow.head, "--main-parent", carry.mainParent, "--main-head", carry.mainHead, "--diff-hash", carry.diffHash,
    "--basis", carry.basis);
  return r.ok === true ? null : c.out("held", `${moved}，只合入了 main，但没记上：${String(r.error)}`);
}

/** Locks down to the PR's own files right after the handoff record; any refusal keeps them whole and says why in the tick detail. */
function narrowAfterHandoff(c: HandoffCard<unknown>, files: PrFiles | null | undefined): string {
  const { task } = c;
  if (!files || !task.pr || !task.headSHA) return "";
  try {
    const input = { taskId: task.id, head: task.headSHA, pr: task.pr, files };
    const r = withLedgerWriter(c.db, (db) => narrowHandoffLocks(db, { actor: "scheduler", now: c.deps.now() }, input));
    return r.narrowed ? `；文件锁收窄 ${r.from.length} → ${r.to.length}` : `；文件锁不收窄（${r.reason}）`;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `；文件锁不收窄（${(e as Error).message}）`;
  }
}

/**
 * The landing write through the scheduler CLI, with what the PR read proved (base main, the merged PR head, the main that holds
 * the merge commit) for the writer to recheck against the handoff in its own transaction. Returns why it was refused, or null.
 */
async function landAfterHandoff(c: HandoffCard<unknown>, follow: HandoffFollow, pr: HandoffPr): Promise<string | null> {
  if (!pr.landing?.ok) return "没有核对过的合入证据"; // driveHandoff holds first; never a landing on an unchecked read
  const r = await c.deps.manager("ledger", "scheduler-merge-handoff", c.task.id, "--head", follow.evidence.head, "--pr", follow.evidence.pr,
    "--merged", pr.mergeSha!, "--base", pr.base ?? "", "--pr-head", pr.head, "--main-head", pr.landing.mainHead);
  return r.ok === true ? null : String(r.error);
}

/**
 * An owner P1 booked on this stay's head (before or after the handoff) sends the card back to fix (RRL-2), or to PM when a lender
 * wrote the head or the owner's bounces are used up — only on a PR just read OPEN at that very head, since no fix can be delivered
 * to a merged or closed one. Merged at that head with the P1 unhandled: PM, never a silent live. Closed / moved: the handoff's own
 * roads. Null = nothing to do here, the handoff goes on.
 */
async function remoteBounce<O>(c: HandoffCard<O>, pr: string, head: string, read: HandoffPr): Promise<O | null> {
  const p = pendingRemoteBounce(c.db, c.task);
  if (!p || !same(read.head, p.head)) return null;
  const report = `仓库方审查 ${p.remote.reportId} 的 ${p.remote.p1} 个 P1；报告：${p.remote.reportPath}`;
  if (read.state === "MERGED") return c.escalate(`仓库方已合并 PR（${short(read.mergeSha)}），但这个 head 上还有没处理的${report}。不自动进 live，请 PM 接手`);
  if (read.state !== "OPEN") return null;
  const refused = remoteBounceRefusal(c.db, c.task, p);
  if (refused) return c.escalate(refused);
  const ready = await backToDraft(c, pr, p.head, read);
  if (ready) return c.out("held", ready);
  const r = await c.deps.manager("ledger", "scheduler-merge-handoff", c.task.id, "--head", head, "--pr", pr, "--remote-bounce", String(p.remote.seq));
  if (r.ok !== true) return c.out("held", `仓库方 P1 打回没记上：${String(r.error)}`);
  if (r.duplicate !== true) await tell(c, `[调度引擎] ${c.task.id} 仓库方审查 ${p.remote.reportId} 有 P1，已退回 fix 给作者（报告：${p.remote.reportPath}）`, true);
  return c.out("remote_bounce", `仓库方审查 ${p.remote.reportId} 有 ${p.remote.p1} 个 P1，退回 fix`);
}

/**
 * A draft PR just handed over is read once more as handed over, which turns it ready (ghPrState, RRL-3): the owner's queue skips
 * drafts, so until then nobody there reviews it. A miss only delays that: every later poll of a handed-over draft tries again.
 */
async function readyNow(c: HandoffCard<unknown>, pr: string, head: string): Promise<string> {
  try {
    const r = await c.deps.prState!(pr, { project: c.task.project, head });
    return r.flipError ? `；草稿没转成 ready，下轮再试：${r.flipError}` : "";
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `；草稿转 ready 前读 PR 失败，下轮再试：${(e as Error).message}`;
  }
}

/**
 * A PR going back to fix is made a draft again first (RRL-3): the owner's queue skips drafts, so it cannot review the fix's heads
 * before this machine has; the next handoff turns it ready again. Refused: the bounce waits (a pending P1 skips the poll pace, so
 * it is tried on every pass). A PR whose draft state gh did not report is left as it is. Null = a draft, go on. A PR this read
 * finds closed or on another head is not bounced on the first read: the next pass takes it through the handoff's own roads.
 */
async function backToDraft(c: HandoffCard<unknown>, pr: string, head: string, read: HandoffPr): Promise<string | null> {
  if (read.draft !== false) return null;
  // driveHandoff's read already asked for the draft (a P1 pending on the followed head): one refused undo a pass is enough
  if (read.flipError) return `仓库方 P1 退回前没把 PR 转回草稿，下轮再试：${read.flipError}`;
  try {
    const r = await c.deps.prState!(pr, { project: c.task.project, head }, undefined, "draft");
    if (r.state !== "OPEN" || !same(r.head, head)) return `仓库方 P1 退回前 PR 变了（${r.state} @ ${short(r.head)}），不按旧读数退回，下轮按新状态处理`;
    return r.draft === true ? null : `仓库方 P1 退回前没把 PR 转回草稿，下轮再试：${r.flipError ?? "gh 没报出草稿状态"}`;
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return `仓库方 P1 退回前读 PR 失败，下轮再试：${(e as Error).message}`;
  }
}

/** First call hands the card over (PR open at the card's head, or PM); later calls follow the PR until merged / closed. */
export async function driveHandoff<O>(c: HandoffCard<O>): Promise<O> {
  const { task } = c;
  if (!task.pr || !task.headSHA) return c.escalate("合并要交给仓库方，但卡上没有 PR 或 head");
  if (!c.deps.prState) return c.out("held", "没有读 PR 状态的通道，合并交接暂停");
  const follow = handoffOf(c.db, task), handed = follow?.evidence;
  // the evidence is bound to the PR it was handed with: a card whose PR was changed since then cannot borrow another PR's merge
  if (handed && handed.pr !== task.pr) return c.escalate(`卡上的 PR 已不是交接的那个（${handed.pr} → ${task.pr}），交接证据不覆盖新 PR`);
  const seen = polled.get(c.db) ?? polled.set(c.db, new Map()).get(c.db)!;
  const last = seen.get(task.id), pending = pendingRemoteBounce(c.db, task);
  // an owner P1 waiting on this head is acted on this pass (RRL-2): the PR is read now instead of at the next minute
  if (handed && last !== undefined && c.deps.now() - last < HANDOFF_POLL_MS && !pending) return c.out("waiting", "已交仓库方合并，等 PR 结果");
  let pr: HandoffPr;
  try {
    // files until this handoff's narrowing is settled: a busy ledger or a failed git read is tried again on the next poll
    const handing = follow && handoffNarrowSettled(c.db, task.id, follow.event.seq) ? undefined : { project: task.project };
    // a P1 pending on the followed head (pendingRemoteBounce's head) keeps the PR a draft on this very read: turned ready first, the
    // owner's queue could pick up a head about to go back to fix (last pass undone, its bounce write refused)
    pr = await c.deps.prState(handed?.pr ?? task.pr, follow ? { project: task.project, head: follow.head } : undefined, handing, follow && pending ? "draft" : undefined);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return c.out("held", `读 PR 状态失败，下轮再试：${(e as Error).message}`);
  }
  seen.set(task.id, c.deps.now());
  if (!follow) {
    if (offMain(pr)) return c.escalate(`不交接：PR 要合进 ${pr.base}，交接只认合进 main 的 PR`);
    if (pr.state !== "OPEN" || !same(pr.head, task.headSHA)) {
      return c.escalate(`不交接：PR ${pr.state}，PR head ${short(pr.head)}，台账 head ${short(task.headSHA)}，两边要一致且 PR 开着`);
    }
    const bounced = await remoteBounce(c, task.pr, task.headSHA, pr);
    if (bounced) return bounced;
    const r = await c.deps.manager("ledger", "scheduler-merge-handoff", task.id, "--head", task.headSHA, "--pr", task.pr);
    if (r.ok !== true) return c.out("held", `交接没记上：${String(r.error)}`);
    if (r.duplicate !== true) await tell(c, `[调度引擎] ${task.id} 审查通过，合并交给仓库方：${task.pr} @ ${short(task.headSHA)}（证据见台账 merge_handoff）`, true);
    const ready = pr.draft ? await readyNow(c, task.pr, task.headSHA) : "";
    return c.out("handoff", `已交仓库方合并 ${task.pr}${ready}${narrowAfterHandoff(c, pr.files)}`);
  }
  if (pr.state === "CLOSED") return c.escalate(`交给仓库方的 PR 被关闭、没有合并：${task.pr}`);
  if (offMain(pr)) return c.escalate(`交给仓库方的 PR 被改投到 ${pr.base}（${pr.state}），交接只认合进 main：不进 live`);
  // merged with an owner P1 unhandled on that head goes to PM now: it can never be fixed, waiting for the landing proof changes nothing
  const merged = pr.state === "MERGED" ? await remoteBounce(c, task.pr, task.headSHA, pr) : null;
  if (merged) return merged;
  if (pr.state === "MERGED" && !pr.mergeSha) return c.out("held", "PR 已合并但还读不到合并提交，下轮再看");
  if (pr.state === "MERGED" && pr.landing && !pr.landing.ok) return c.out("held", `PR 已合并但没证实进了 main，下轮再看：${pr.landing.reason}`);
  const moved = !same(pr.head, follow.head);
  const stop = moved ? await followMoved(c, follow, pr) : null;
  if (stop) return stop;
  const bounced = await remoteBounce(c, task.pr, task.headSHA, pr); // after a recorded carry: the head followed now
  if (bounced) return bounced;
  if (pr.state === "OPEN") {
    const ready = pr.flipError ? `；草稿没转成 ready，下轮再试：${pr.flipError}` : "";
    return c.out("waiting", `${moved ? `PR 只合入了 main（→ ${short(pr.head)}），继续等合并` : "已交仓库方合并，等 PR 结果"}${ready}${narrowAfterHandoff(c, pr.files)}`);
  }
  // a read that never said whether main holds the merge commit proves nothing: held, never live (a moved head still went to PM above)
  if (!pr.landing?.ok) return c.out("held", "PR 已合并但没证实进了 main，下轮再看：读 PR 没给出 main 是否含合并提交");
  const landed = await landAfterHandoff(c, follow, pr);
  if (landed) return c.out("held", `合并结果没记上：${landed}`);
  const via = same(pr.head, follow.evidence.head) ? "" : `；交接后只合入过 main，合并时 head ${short(pr.head)}`;
  await tell(c, `[调度引擎] ${task.id} 的 PR 已由仓库方合并（${short(pr.mergeSha)}${via}），卡片进 live：本机跟上 main 后跑 ledger verify`);
  return c.out("landed", `仓库方已合并 ${short(pr.mergeSha)}，进 live`);
}
