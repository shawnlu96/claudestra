/**
 * The auto tick's side of the merge handoff (scheduler-merge-handoff.ts): where a local-merge project would plan its merge
 * intent, a handoff project's card is handed to the repository owner and then only watched until its PR is merged or closed.
 * Every road here either writes through the scheduler CLI or gives the card to PM; nothing merges, updates a branch, forms a
 * train or plans a merge intent. tests/scheduler-merge-handoff.test.ts, tests/scheduler-merge-handoff-carry.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { ghEnv } from "./peer-pr-github.js";
import { WHOLE_DIFF_ARGS } from "./git-diff-args.js";
import { runBounded } from "./run-bounded.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { CarryUndecidable, MAIN_REF, mainMergeCarry, type MainMergeCarry } from "./scheduler-main-merge-carry.js";
import { handoffNarrowSettled, handoffOf, narrowHandoffLocks, type HandoffFollow } from "./scheduler-merge-handoff.js";
import { withLedgerWriter } from "./ledger-scheduler-lease-sync.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { recordFeatureRegress } from "./handoff-gate-notice.js";

/**
 * `carry`: asked to follow a head and the PR sits on another one, whether it got there only by merging main in.
 * `files`: asked while the handoff's narrowing is unsettled (`handing`), the PR's changed paths at its head (null = could not tell).
 */
export interface HandoffPr { state: "OPEN" | "MERGED" | "CLOSED"; head: string; mergeSha: string | null; carry?: MainMergeCarry; files?: PrFiles | null }
/** `refused`: reading this head again gives the same answer (the list is too long to vouch for); recorded once, locks stay whole. */
type PrFiles = string[] | { refused: string };
/** `follow` = the PR head this machine follows after the handoff (absent before it). A failed read or git step throws. */
export type ReadPr = (prRef: string, follow?: { project: string; head: string }, handing?: { project: string }) => Promise<HandoffPr>;
/** The PR's net changed paths (merge-base with main → head, renames as both sides); null when the clone cannot tell this time. */
export type HandoffFiles = (prRef: string, head: string) => Promise<PrFiles | null>;
/** `mergeSha` set = the PR is merged: its main parent must be on main before that merge, not on the main that now holds the PR. */
export type HandoffCarry = (prRef: string, oldHead: string, newHead: string, mergeSha: string | null) => Promise<MainMergeCarry>;
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;
export interface HandoffCard<O> {
  db: Database;
  task: LedgerTask;
  deps: { manager: Manager; notifyPm(task: LedgerTask, text: string): Promise<void>; now(): number; prState?: ReadPr };
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
  }): ReadPr {
  return async (prRef, follow, handing) => {
    const r = await command(["gh", "pr", "view", prRef, "--json", "state,headRefOid,mergeCommit"], { env: ghEnv(), timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh pr view 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    const raw = JSON.parse(r.stdout) as { state?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null };
    const mergeSha = typeof raw.mergeCommit?.oid === "string" && SHA.test(raw.mergeCommit.oid) ? raw.mergeCommit.oid : null;
    if (!["OPEN", "MERGED", "CLOSED"].includes(String(raw.state)) || typeof raw.headRefOid !== "string" || !SHA.test(raw.headRefOid)) {
      throw new Error("gh pr view 输出不合规");
    }
    const pr: HandoffPr = { state: raw.state as HandoffPr["state"], head: raw.headRefOid, mergeSha };
    const read = handing && pr.state === "OPEN" ? { ...pr, files: await prFiles(filesOf(handing.project), prRef, pr.head) } : pr;
    // CLOSED goes to PM anyway; MERGED without its merge commit is read again next round
    if (!follow || same(pr.head, follow.head) || pr.state === "CLOSED" || (pr.state === "MERGED" && !mergeSha)) return read;
    const carry = carryOf(follow.project);
    return carry ? { ...read, carry: await carry(prRef, follow.head, pr.head, pr.state === "MERGED" ? mergeSha : null) } : read;
  };
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
function gitIn(repoDir: string, command: typeof runBounded) {
  return async (...args: string[]) => {
    const r = await command(["git", ...args], { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 120_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`git ${args[0]} 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    return r.stdout;
  };
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

/** Same clone and origin check as a carry; the three-dot diff is what GitHub lists as the PR's files. */
export function handoffFiles(repoDir: string, command: typeof runBounded = runBounded): HandoffFiles {
  const git = gitIn(repoDir, command);
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

/** Best effort: the ledger event is the durable record; a stop still ends the pass. */
const tell = (c: HandoffCard<unknown>, text: string): Promise<void> => c.deps.notifyPm(c.task, text).catch((e) => {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [scheduler] ${c.task.id} 合并交接通知没发出去（台账已记）：${(e as Error).message}`);
});

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

/** A sibling of this card's feature batch fell back after the handoff: PM hears once, the handoff itself stays (HDG-1 #7). */
async function regressNotice(c: HandoffCard<unknown>): Promise<void> {
  let text: string | null;
  try { text = recordFeatureRegress(c.db, c.task, c.deps.now()); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [scheduler] ${c.task.id} 同批退回的升级没记上，下轮再试：${(e as Error).message}`);
    return;
  }
  if (text) await tell(c, text);
}

/** First call hands the card over (PR open at the card's head, or PM); later calls follow the PR until merged / closed. */
export async function driveHandoff<O>(c: HandoffCard<O>): Promise<O> {
  const { task } = c;
  if (!task.pr || !task.headSHA) return c.escalate("合并要交给仓库方，但卡上没有 PR 或 head");
  if (!c.deps.prState) return c.out("held", "没有读 PR 状态的通道，合并交接暂停");
  const follow = handoffOf(c.db, task), handed = follow?.evidence;
  // the evidence is bound to the PR it was handed with: a card whose PR was changed since then cannot borrow another PR's merge
  if (handed && handed.pr !== task.pr) return c.escalate(`卡上的 PR 已不是交接的那个（${handed.pr} → ${task.pr}），交接证据不覆盖新 PR`);
  if (follow) await regressNotice(c);
  const seen = polled.get(c.db) ?? polled.set(c.db, new Map()).get(c.db)!;
  const last = seen.get(task.id);
  if (handed && last !== undefined && c.deps.now() - last < HANDOFF_POLL_MS) return c.out("waiting", "已交仓库方合并，等 PR 结果");
  let pr: HandoffPr;
  try {
    // files until this handoff's narrowing is settled: a busy ledger or a failed git read is tried again on the next poll
    const handing = follow && handoffNarrowSettled(c.db, task.id, follow.event.seq) ? undefined : { project: task.project };
    pr = await c.deps.prState(handed?.pr ?? task.pr, follow ? { project: task.project, head: follow.head } : undefined, handing);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return c.out("held", `读 PR 状态失败，下轮再试：${(e as Error).message}`);
  }
  seen.set(task.id, c.deps.now());
  if (!follow) {
    if (pr.state !== "OPEN" || !same(pr.head, task.headSHA)) {
      return c.escalate(`不交接：PR ${pr.state}，PR head ${short(pr.head)}，台账 head ${short(task.headSHA)}，两边要一致且 PR 开着`);
    }
    const r = await c.deps.manager("ledger", "scheduler-merge-handoff", task.id, "--head", task.headSHA, "--pr", task.pr);
    if (r.ok !== true) return c.out("held", `交接没记上：${String(r.error)}`);
    if (r.duplicate !== true) await tell(c, `[调度引擎] ${task.id} 审查通过，合并交给仓库方：${task.pr} @ ${short(task.headSHA)}（证据见台账 merge_handoff）`);
    return c.out("handoff", `已交仓库方合并 ${task.pr}${narrowAfterHandoff(c, pr.files)}`);
  }
  if (pr.state === "CLOSED") return c.escalate(`交给仓库方的 PR 被关闭、没有合并：${task.pr}`);
  if (pr.state === "MERGED" && !pr.mergeSha) return c.out("held", "PR 已合并但还读不到合并提交，下轮再看");
  const moved = !same(pr.head, follow.head);
  const stop = moved ? await followMoved(c, follow, pr) : null;
  if (stop) return stop;
  if (pr.state === "OPEN") {
    return c.out("waiting", `${moved ? `PR 只合入了 main（→ ${short(pr.head)}），继续等合并` : "已交仓库方合并，等 PR 结果"}${narrowAfterHandoff(c, pr.files)}`);
  }
  const r = await c.deps.manager("ledger", "scheduler-merge-handoff", task.id, "--head", follow.evidence.head, "--pr", task.pr, "--merged", pr.mergeSha!);
  if (r.ok !== true) return c.out("held", `合并结果没记上：${String(r.error)}`);
  const via = same(pr.head, follow.evidence.head) ? "" : `；交接后只合入过 main，合并时 head ${short(pr.head)}`;
  await tell(c, `[调度引擎] ${task.id} 的 PR 已由仓库方合并（${short(pr.mergeSha)}${via}），卡片进 live：本机跟上 main 后跑 ledger verify`);
  return c.out("landed", `仓库方已合并 ${short(pr.mergeSha)}，进 live`);
}
