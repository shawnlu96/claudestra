/**
 * merge-arch-CIUNREL1 item 3 · the scheduler pass's retry step (one line in scheduler-pass.ts). For each card's live registration
 * (ci-main-fix-retry.ts): the card is still in fix on the registered head, nothing holds it (PEERHEAD1's flowBlock: freeze, hold,
 * pause, safety hold, open ask), its retry sample is not written yet, GitHub's PR head is still the registered one, and main has a
 * commit after the registered main head that changed one of the failing test files. Then one recordObserved sample per registration
 * (written first: the write-ahead mark), and only under on and only for a peer PR card one update-branch with expected_head_sha =
 * the registered head. GitHub refusing it (422: the head moved) is logged, never a failure. The new head is PEERHEAD1's from there.
 * A restart re-reads the same facts: the sample is there and the PR head moved, so nothing is sent twice.
 * tests/ci-main-fix-retry*.test.ts.
 */
import type { Database } from "bun:sqlite";
import { getTask, listEvents } from "./ledger-store.js";
import { flowBlock } from "./peer-pr-head-review.js";
import { recordObserved, type ObservedAction, type RecoveryPolicyPort } from "./recovery-policy.js";
import { runBounded } from "./run-bounded.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { ciBehindGh } from "./scheduler-merge-ci-behind.js";
import { isTestProcess } from "./test-guard.js";
import { CI_MAIN_FIX_RETRY_KEY, isPeerPrCard, ledgerJudge, liveRegistrations, retryActionKey, retryMode, retryPlan, retrySampled,
  type Registration } from "./ci-main-fix-retry.js";

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

async function retryOne(db: Database, reg: Registration, ports: RetryPorts): Promise<string | null> {
  const mode = retryMode(reg.project, ports.policy);
  if (mode === "off") return null;
  const task = getTask(db, reg.taskId);
  const block = task ? flowBlock(db, task, listEvents(db, { project: task.project, target: task.id })) : null;
  const ledger = ledgerJudge(task, reg, block, retrySampled(db, reg.taskId, reg));
  if (!ledger.ok) return null;
  const pull = PULL.exec(task!.pr ?? reg.pr);
  if (!pull) return null;
  const repo = pull[1]!, peer = isPeerPrCard(task!);
  const plan = retryPlan(reg, mode, peer, await ports.gh.prHead(repo, pull[2]!), await mainFixes(ports.gh, repo, reg));
  if (plan.kind === "void" || plan.kind === "wait") return null;
  ports.assertActive?.();
  const executed = plan.kind === "update";
  const fixed = Object.entries(plan.commits).filter(([, c]) => c.length).map(([f, c]) => `${f}（${c.join("、")}）`).join("、");
  const { recorded } = await ports.record({ project: reg.project, mechanism: CI_MAIN_FIX_RETRY_KEY, target: reg.taskId, actionKey: retryActionKey(reg),
    action: `${executed ? "已" : ""}按 main 的修复重试：合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），main 改过 ${fixed}`.slice(0, 400),
    data: { registrationSeq: reg.seq, prHead: reg.prHead, run: reg.run, files: reg.files, mainHead: reg.mainHead, commits: plan.commits, peer, mode, executed,
      ...(executed ? {} : { why: peer ? "开关是 observe：只记样本" : "本机执行者的卡：只记样本，不自动 update-branch" }) } });
  if (!executed || !recorded) return null;
  try {
    await ports.gh.updateBranch(repo, pull[2]!, reg.prHead);
    console.error(`🔁 [merge] ${reg.taskId} main 已修好失败测试，已合入 main 更新 PR（expected_head_sha ${reg.prHead.slice(0, 12)}），新 head 交 PEERHEAD1`);
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    console.error(`⚠️ [merge] ${reg.taskId} main 修好后的 update-branch 没成（不算失败，交正常流程）：${oneLine(e)}`);
  }
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
 * scheduler-pass.ts's call. Without a real command (a test world's injected external) and in a test process nothing is read;
 * the sample goes through the leased manager there, or straight to the ledger when no manager is given.
 */
export async function ciMainFixRetryStep(db: Database, projects: readonly string[], o: { manager?: Manager; command?: typeof runBounded;
  policy?: RecoveryPolicyPort; active?: () => void; gh?: RetryGh }): Promise<{ taskId: string; error: string }[]> {
  const gh = o.gh ?? (o.command && !isTestProcess() ? retryGh(o.command) : null);
  if (!gh) return [];
  const manager = o.manager;
  const record = manager ? async (a: ObservedAction) => {
    const r = await manager("ledger", "scheduler-recovery-observe", a.target, "--mechanism", a.mechanism, "--action-key", a.actionKey,
      "--action", a.action, "--data", JSON.stringify(a.data ?? {}));
    if (r.held === true) return { recorded: false }; // the card is held (pause / v2 skip): nothing written, nothing sent
    if (r.ok !== true) throw new Error(String(r.error ?? "scheduler-recovery-observe 失败"));
    return { recorded: r.recorded === true };
  } : async (a: ObservedAction) => ({ recorded: recordObserved(db, a, Date.now()).recorded });
  return ciMainFixRetryTick(db, projects, { gh, record, policy: o.policy, assertActive: o.active });
}
