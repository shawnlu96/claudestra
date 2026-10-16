/**
 * merge-arch-CIUNREL1 item 3 · the scheduler pass's retry step (one line in scheduler-pass.ts). For each card's live registration
 * (ci-main-fix-retry.ts): the card is still in fix on the registered head, nothing holds it (PEERHEAD1's flowBlock: freeze, hold,
 * pause, safety hold, open ask), its retry sample is not written yet, GitHub's PR head is still the registered one, and main has a
 * commit after the registered main head that changed one of the failing test files. Then one recordObserved sample per registration
 * (written first: the write-ahead mark), and only under on and only for a peer PR card one update-branch with expected_head_sha =
 * the registered head. Switch, card and flow blocks are read again after the GitHub reads and after the sample write (no await between
 * that last read and the send); stopped there, a release sample hands the registration its next attempt. GitHub refusing it (422:
 * the head moved) is logged, never a failure. The new head is PEERHEAD1's from there.
 * A restart re-reads the same facts: the sample is there and the PR head moved, so nothing is sent twice.
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
import { CI_MAIN_FIX_RETRY_KEY, isPeerPrCard, ledgerJudge, liveRegistrations, releaseActionKey, retryActionKey, retryAttempt, retryMode, retryPlan,
  retrySampled, type Registration } from "./ci-main-fix-retry.js";

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
 * head), every flow block (freeze, hold, pause, safety hold, open ask), whether the current attempt is sampled (`sampleFree`), the PR.
 */
function authority(db: Database, reg: Registration, ports: RetryPorts, sampleFree: boolean): Authority {
  const mode = retryMode(reg.project, ports.policy);
  if (mode === "off") return { ok: false, why: "开关是 off" };
  const task = getTask(db, reg.taskId);
  const block = task ? flowBlock(db, task, listEvents(db, { project: task.project, target: task.id })) : null;
  const ledger = ledgerJudge(task, reg, block, sampleFree && retrySampled(db, reg.taskId, reg));
  if (!ledger.ok) return ledger;
  const pull = PULL.exec(task!.pr ?? reg.pr);
  if (!pull) return { ok: false, why: "卡上没有 PR 链接" };
  return { ok: true, mode, peer: isPeerPrCard(task!), repo: pull[1]!, pull: pull[2]! };
}

async function retryOne(db: Database, reg: Registration, ports: RetryPorts): Promise<string | null> {
  const first = authority(db, reg, ports, true);
  if (!first.ok) return null;
  const prHead = await ports.gh.prHead(first.repo, first.pull);
  const fixes = await mainFixes(ports.gh, first.repo, reg);
  // The GitHub reads awaited: a freeze, hold, switch change or card move may have landed meanwhile.
  const now = authority(db, reg, ports, true);
  if (!now.ok || now.repo !== first.repo || now.pull !== first.pull) return null;
  const plan = retryPlan(reg, now.mode, now.peer, prHead, fixes);
  if (plan.kind === "void" || plan.kind === "wait") return null;
  ports.assertActive?.();
  const executed = plan.kind === "update", attempt = retryAttempt(db, reg.taskId, reg), key = retryActionKey(reg, attempt);
  const fixed = Object.entries(plan.commits).filter(([, c]) => c.length).map(([f, c]) => `${f}（${c.join("、")}）`).join("、");
  const { recorded } = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId, actionKey: key,
    action: `${executed ? "已" : ""}按 main 的修复重试：合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），main 改过 ${fixed}`.slice(0, 400),
    data: { registrationSeq: reg.seq, prHead: reg.prHead, run: reg.run, files: reg.files, mainHead: reg.mainHead, commits: plan.commits, peer: now.peer,
      mode: now.mode, executed, ...(attempt ? { attempt } : {}),
      ...(executed ? {} : { why: now.peer ? "开关是 observe：只记样本" : "本机执行者的卡：只记样本，不自动 update-branch" }) } });
  if (!executed || !recorded) return null;
  // The sample write awaited too: read it all once more, then send with no await in between.
  const last = authority(db, reg, ports, false);
  const stop = !last.ok ? last.why : last.mode !== "on" ? "开关已不是 on" : !last.peer ? "已不是 peer PR 卡"
    : last.repo !== now.repo || last.pull !== now.pull ? "卡上的 PR 变了" : null;
  if (stop) return release(reg, ports, attempt, key, stop);
  try {
    await ports.gh.updateBranch(now.repo, now.pull, reg.prHead);
    console.error(`🔁 [merge] ${reg.taskId} main 已修好失败测试，已合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），新 head 交 PEERHEAD1`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [merge] ${reg.taskId} main 修好后的 update-branch 没成（不算失败，交正常流程）：${oneLine(e)}`);
  }
  return null;
}

/** Nothing was sent after the executed sample: a release sample gives the registration its next attempt once the stop clears. */
async function release(reg: Registration, ports: RetryPorts, attempt: number, key: string, why: string): Promise<null> {
  console.error(`⏸️ [merge] ${reg.taskId} main 修好后的重试在发 update-branch 前被拦下（${why}），没发，登记留给下一轮`);
  const { recorded } = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId,
    actionKey: releaseActionKey(reg, attempt), action: `重试样本 ${key} 没执行就撤回：${why}`.slice(0, 400),
    data: { registrationSeq: reg.seq, prHead: reg.prHead, run: reg.run, files: reg.files, executed: false, released: key, why } });
  if (!recorded) console.error(`⚠️ [merge] ${reg.taskId} 撤回重试样本 ${key} 没记上，这条登记按已用掉处理（不会再发）`);
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
