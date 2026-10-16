/**
 * merge-arch-CIUNREL1 item 3 · the scheduler pass's retry step (one line in scheduler-pass.ts). For each card's live registration
 * (ci-main-fix-retry.ts): the card is still in fix on the registered head, nothing holds it (PEERHEAD1's flowBlock: freeze, hold,
 * pause, safety hold, open ask), GitHub's PR head is still the registered one, and main has a commit after the registered main head
 * that changed one of the failing test files. Then one recordObserved sample per registration: observe or a local card = "would
 * retry", done; on + peer PR card = the intent, then one update-branch with expected_head_sha = the registered head. Send order:
 * authority read again (sync) → the send mark recorded → authority read again (sync, no await before the send) → update-branch.
 * No mark = known never sent: a stop or a held mark (card paused, v2 skip) leaves nothing to undo and a later tick goes on. A mark =
 * possibly sent, used up for good (a 502, a crash right after, a restart change nothing); only the process that wrote the mark and
 * then read a stop before sending writes its release (held: kept in this process for a later tick; lost on restart = stays spent).
 * GitHub refusing it (422: the head moved) is logged, never a failure. The new head is PEERHEAD1's from there.
 * tests/ci-main-fix-retry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getTask, listEvents } from "./ledger-store.js";
import { flowBlock } from "./peer-pr-head-review.js";
import type { ObservedAction, RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { ciBehindGh } from "./scheduler-merge-ci-behind.js";
import { isTestProcess } from "./test-guard.js";
import { CI_MAIN_FIX_RETRY_KEY, isPeerPrCard, ledgerJudge, liveRegistrations, releaseActionKey, retryActionKey, retryMode, retryPlan, retryState,
  sentActionKey, type Registration } from "./ci-main-fix-retry.js";

/** GitHub reads and the one write this step needs; a test puts its own. */
export interface RetryGh {
  prHead(repo: string, pull: string): Promise<string>;
  /** Commits on main after `base` (compare `base...main`), with the main head they end at. */
  mainSince(repo: string, base: string): Promise<{ mainHead: string; commits: string[] }>;
  fileCommits(repo: string, file: string, mainHead: string): Promise<string[]>;
  updateBranch(repo: string, pull: string, expectedHead: string): Promise<void>;
}
export interface RetryPorts {
  gh: RetryGh;
  /** The sample write: the leased `ledger scheduler-recovery-observe` in a pass; tests write to their ledger directly. */
  record(a: ObservedAction): Promise<{ recorded: boolean }>;
  policy?: RecoveryPolicyPort;
  now?: () => number;
  assertActive?: () => void;
}
type Manager = (...args: string[]) => Promise<Record<string, unknown>>;

const PULL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;
const SHA = /^[a-f0-9]{40}$/i;
const oneLine = (e: unknown) => (e as Error).message.replace(/\s+/g, " ").slice(0, 300);

export function retryGh(command: typeof runBounded = runBounded): RetryGh {
  const behind = ciBehindGh(command);
  return {
    async prHead(repo, pull) {
      const r = await command(["gh", "api", `repos/${repo}/pulls/${pull}`, "--jq", ".head.sha"], { timeoutMs: 120_000,
        env: { ...process.env, DISCORD_CHANNEL_ID: "", CLAUDESTRA_SCHEDULER_SERVICE: "", GIT_TERMINAL_PROMPT: "0" } });
      const sha = r.stdout.trim();
      if (r.code !== 0 || r.timedOut || !SHA.test(sha)) throw new Error(`gh api pulls 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code}`}`);
      return sha.toLowerCase();
    },
    mainSince: (repo, base) => behind.mainSince(repo, base),
    fileCommits: (repo, file, mainHead) => behind.fileCommits(repo, file, mainHead),
    updateBranch: (repo, pull, expectedHead) => behind.updateBranch(repo, pull, expectedHead),
  };
}

/** main's commits after the registered main head that changed each failing file (short SHAs). */
async function mainFixes(gh: RetryGh, repo: string, reg: Registration): Promise<Record<string, string[]>> {
  const since = await gh.mainSince(repo, reg.mainHead);
  const after = new Set(since.commits.map((c) => c.toLowerCase()));
  const out: Record<string, string[]> = {};
  if (!after.size) return out;
  for (const file of reg.files) out[file] = (await gh.fileCommits(repo, file, since.mainHead)).filter((c) => after.has(c.toLowerCase())).map((c) => c.slice(0, 12));
  return out;
}

type Authority = { ok: true; mode: "on" | "observe"; peer: boolean; repo: string; pull: string } | { ok: false; why: string };
/**
 * Everything that allows this registration now, read fresh each time (never carried over an await): the switch, the card (stage,
 * head), every flow block (freeze, hold, pause, safety hold, open ask), the PR.
 */
function authority(db: Database, reg: Registration, ports: RetryPorts): Authority {
  const mode = retryMode(reg.project, ports.policy);
  if (mode === "off") return { ok: false, why: "开关是 off" };
  const task = getTask(db, reg.taskId);
  const block = task ? flowBlock(db, task, listEvents(db, { project: task.project, target: task.id })) : null;
  const ledger = ledgerJudge(task, reg, block);
  if (!ledger.ok) return ledger;
  const pull = PULL.exec(task!.pr ?? reg.pr);
  if (!pull) return { ok: false, why: "卡上没有 PR 链接" };
  return { ok: true, mode, peer: isPeerPrCard(task!), repo: pull[1]!, pull: pull[2]! };
}
/** Why update-branch may not go out now (sync, right before the mark and right before the send), or null. */
function stopNow(db: Database, reg: Registration, ports: RetryPorts, was: { repo: string; pull: string }): string | null {
  const last = authority(db, reg, ports);
  return !last.ok ? last.why : last.mode !== "on" ? "开关已不是 on" : !last.peer ? "已不是 peer PR 卡"
    : last.repo !== was.repo || last.pull !== was.pull ? "卡上的 PR 变了" : null;
}

/** Releases this process owes (a mark written, a stop read before the send, the release held), per ledger: `card\nmark key` → why. */
const stoppedHere = new WeakMap<Database, Map<string, string>>();
const stoppedOf = (db: Database): Map<string, string> => {
  const m = stoppedHere.get(db) ?? new Map<string, string>();
  stoppedHere.set(db, m);
  return m;
};

async function retryOne(db: Database, reg: Registration, ports: RetryPorts): Promise<null> {
  if (retryMode(reg.project, ports.policy) === "off") return null;
  const state = retryState(db, reg.taskId, reg);
  if (state.sampled) return null; // its one "would retry" sample
  if (state.marked) { // possibly sent: used up, unless this very process knows it stopped before the send
    const why = stoppedOf(db).get(`${reg.taskId}\n${sentActionKey(reg, state.attempt)}`);
    return why === undefined ? null : release(db, reg, ports, state.attempt, why);
  }
  const first = authority(db, reg, ports);
  if (!first.ok) return null;
  const prHead = await ports.gh.prHead(first.repo, first.pull);
  const fixes = await mainFixes(ports.gh, first.repo, reg);
  // The GitHub reads awaited: a freeze, hold, switch change or card move may have landed meanwhile.
  const now = authority(db, reg, ports);
  if (!now.ok || now.repo !== first.repo || now.pull !== first.pull) return null;
  const plan = retryPlan(reg, now.mode, now.peer, prHead, fixes);
  if (plan.kind === "void" || plan.kind === "wait") return null;
  ports.assertActive?.();
  const intentKey = retryActionKey(reg), update = plan.kind === "update";
  const fixed = Object.entries(plan.commits).filter(([, c]) => c.length).map(([f, c]) => `${f}（${c.join("、")}）`).join("、");
  const data = { registrationSeq: reg.seq, prHead: reg.prHead, run: reg.run, files: reg.files, mainHead: reg.mainHead, commits: plan.commits, peer: now.peer,
    mode: now.mode };
  if (!update || !state.intent) {
    const { recorded } = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId,
      actionKey: update || !state.intent ? intentKey : `${intentKey}:observe`,
      action: `按 main 的修复重试：合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），main 改过 ${fixed}`.slice(0, 400),
      data: { ...data, executed: update, ...(update ? {} : { why: now.peer ? "开关是 observe：只记样本" : "本机执行者的卡：只记样本，不自动 update-branch" }) } });
    if (!update || !recorded) return null;
  }
  const was = { repo: now.repo, pull: now.pull }, markKey = sentActionKey(reg, state.attempt);
  // Before the mark a stop costs nothing: no mark = never sent, a later tick goes on from here.
  const early = stopNow(db, reg, ports, was);
  if (early) return held(reg, `发 update-branch 前被拦下（${early}），没写发送记号、没发`);
  const mark = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId, actionKey: markKey,
    action: `已按 main 的修复重试：发 update-branch（expected_head_sha ${reg.prHead.slice(0, 12)}），main 改过 ${fixed}`.slice(0, 400),
    data: { ...data, executed: true, sent: intentKey, attempt: state.attempt } });
  if (!mark.recorded) return held(reg, "发送记号没记上（卡暂停 / 被跳过），没发");
  // The mark write awaited too: read it all once more, then send with no await in between.
  const stop = stopNow(db, reg, ports, was);
  if (stop) return release(db, reg, ports, state.attempt, stop);
  try {
    await ports.gh.updateBranch(was.repo, was.pull, reg.prHead);
    console.error(`🔁 [merge] ${reg.taskId} main 已修好失败测试，已合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），新 head 交 PEERHEAD1`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [merge] ${reg.taskId} main 修好后的 update-branch 没成（不算失败，交正常流程；发送记号在，不再发）：${oneLine(e)}`);
  }
  return null;
}

function held(reg: Registration, why: string): null {
  console.error(`⏸️ [merge] ${reg.taskId} main 修好后的重试${why}，登记留给下一轮`);
  return null;
}

/**
 * Attempt n's mark was written but nothing was sent after it: its release gives the registration attempt n + 1 once the stop clears.
 * Held (the card paused, a v2 skip) or failed, it stays owed in this process and a later tick writes it; a restart forgets it and the
 * attempt stays spent (never sent twice).
 */
async function release(db: Database, reg: Registration, ports: RetryPorts, attempt: number, why: string): Promise<null> {
  const markKey = sentActionKey(reg, attempt), owed = `${reg.taskId}\n${markKey}`;
  console.error(`⏸️ [merge] ${reg.taskId} main 修好后的重试写了发送记号但在发 update-branch 前被拦下（${why}），没发，撤回记号`);
  stoppedOf(db).set(owed, why);
  const { recorded } = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId,
    actionKey: releaseActionKey(reg, attempt), action: `发送记号 ${markKey} 没发就撤回：${why}`.slice(0, 400),
    data: { registrationSeq: reg.seq, prHead: reg.prHead, run: reg.run, files: reg.files, executed: false, released: markKey, why } });
  if (recorded) stoppedOf(db).delete(owed);
  else console.error(`⚠️ [merge] ${reg.taskId} 撤回发送记号 ${markKey} 这次没记上（卡暂停 / 被跳过），下一轮再记；记上之前不会发`);
  return null;
}

/** One pass: every live registration of these projects, each on its own (one card's error never stops the others). */
export async function ciMainFixRetryTick(db: Database, projects: readonly string[], ports: RetryPorts): Promise<{ taskId: string; error: string }[]> {
  const failed: { taskId: string; error: string }[] = [];
  for (const reg of liveRegistrations(db, projects, (ports.now ?? Date.now)())) {
    ports.assertActive?.();
    try {
      await retryOne(db, reg, ports);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ taskId: reg.taskId, error: `main 修好后重试：${oneLine(e)}` });
    }
  }
  return failed;
}

/**
 * scheduler-pass.ts's call (merge-arch-CIUNREL1, after the merge tick). Without a real command (a test world's injected external)
 * and in a test process nothing is read. The sample goes through the leased pass manager; a held card (pause / v2 skip) records
 * nothing and so sends nothing.
 */
export async function ciMainFixRetryStep(db: Database, config: { projects: Record<string, unknown> }, manager: Manager, active: () => void,
  policy: RecoveryPolicyPort | undefined, command: typeof runBounded | false): Promise<{ taskId: string; error: string }[]> {
  if (!command || isTestProcess()) return [];
  const record = async (a: ObservedAction) => {
    const r = await manager("ledger", "scheduler-recovery-observe", a.target, "--mechanism", a.mechanism, "--action-key", a.actionKey,
      "--action", a.action, "--data", JSON.stringify(a.data ?? {}));
    if (r.held === true) return { recorded: false };
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
    return { recorded: r.recorded === true };
  };
  return ciMainFixRetryTick(db, Object.keys(config.projects), { gh: retryGh(command), record, policy, assertActive: active });
}
