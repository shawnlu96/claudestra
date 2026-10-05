/**
 * The auto tick's side of the merge handoff (scheduler-merge-handoff.ts): where a local-merge project would plan its merge
 * intent, a handoff project's card is handed to the repository owner and then only watched until its PR is merged or closed.
 * Every road here either writes through the scheduler CLI or gives the card to PM; nothing merges, updates a branch, forms a
 * train or plans a merge intent. tests/scheduler-merge-handoff.test.ts.
 */
import type { Database } from "bun:sqlite";
import type { LedgerTask } from "./ledger-stages.js";
import { ghEnv } from "./peer-pr-github.js";
import { runBounded } from "./run-bounded.js";
import { handoffOf, type HandoffEvidence } from "./scheduler-merge-handoff.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export interface HandoffPr { state: "OPEN" | "MERGED" | "CLOSED"; head: string; mergeSha: string | null }
export type ReadPr = (prRef: string) => Promise<HandoffPr>;
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
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const short = (s: string | null | undefined): string => (s ?? "（无）").slice(0, 12);

/** `gh pr view` of a full PR URL; anything malformed throws, so the caller skips the round instead of acting on a guess. */
export function ghPrState(command: typeof runBounded = runBounded): ReadPr {
  return async (prRef) => {
    const r = await command(["gh", "pr", "view", prRef, "--json", "state,headRefOid,mergeCommit"], { env: ghEnv(), timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) throw new Error(`gh pr view 失败：${r.stderr.trim().split("\n")[0]?.slice(0, 200) || `exit ${r.code ?? "timeout"}`}`);
    const raw = JSON.parse(r.stdout) as { state?: unknown; headRefOid?: unknown; mergeCommit?: { oid?: unknown } | null };
    const mergeSha = typeof raw.mergeCommit?.oid === "string" && SHA.test(raw.mergeCommit.oid) ? raw.mergeCommit.oid : null;
    if (!["OPEN", "MERGED", "CLOSED"].includes(String(raw.state)) || typeof raw.headRefOid !== "string" || !SHA.test(raw.headRefOid)) {
      throw new Error("gh pr view 输出不合规");
    }
    return { state: raw.state as HandoffPr["state"], head: raw.headRefOid, mergeSha };
  };
}

/** Best effort: the ledger event is the durable record; a stop still ends the pass. */
const tell = (c: HandoffCard<unknown>, text: string): Promise<void> => c.deps.notifyPm(c.task, text).catch((e) => {
  if (e instanceof SchedulerStopped) throw e;
  console.error(`⚠️ [scheduler] ${c.task.id} 合并交接通知没发出去（台账已记）：${(e as Error).message}`);
});

/** First call hands the card over (PR open at the card's head, or PM); later calls follow the PR until merged / closed. */
export async function driveHandoff<O>(c: HandoffCard<O>): Promise<O> {
  const { task } = c;
  if (!task.pr || !task.headSHA) return c.escalate("合并要交给仓库方，但卡上没有 PR 或 head");
  if (!c.deps.prState) return c.out("held", "没有读 PR 状态的通道，合并交接暂停");
  const handed = handoffOf(c.db, task)?.data.evidence as HandoffEvidence | undefined;
  // the evidence is bound to the PR it was handed with: a card whose PR was changed since then cannot borrow another PR's merge
  if (handed && handed.pr !== task.pr) return c.escalate(`卡上的 PR 已不是交接的那个（${handed.pr} → ${task.pr}），交接证据不覆盖新 PR`);
  const seen = polled.get(c.db) ?? polled.set(c.db, new Map()).get(c.db)!;
  const last = seen.get(task.id);
  if (handed && last !== undefined && c.deps.now() - last < HANDOFF_POLL_MS) return c.out("waiting", "已交仓库方合并，等 PR 结果");
  let pr: HandoffPr;
  try { pr = await c.deps.prState(handed?.pr ?? task.pr); } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    return c.out("held", `读 PR 状态失败，下轮再试：${(e as Error).message}`);
  }
  seen.set(task.id, c.deps.now());
  if (!handed) {
    if (pr.state !== "OPEN" || !same(pr.head, task.headSHA)) {
      return c.escalate(`不交接：PR ${pr.state}，PR head ${short(pr.head)}，台账 head ${short(task.headSHA)}，两边要一致且 PR 开着`);
    }
    const r = await c.deps.manager("ledger", "scheduler-merge-handoff", task.id, "--head", task.headSHA, "--pr", task.pr);
    if (r.ok !== true) return c.out("held", `交接没记上：${String(r.error)}`);
    if (r.duplicate !== true) await tell(c, `[调度引擎] ${task.id} 审查通过，合并交给仓库方：${task.pr} @ ${short(task.headSHA)}（证据见台账 merge_handoff）`);
    return c.out("handoff", `已交仓库方合并 ${task.pr}`);
  }
  if (pr.state === "CLOSED") return c.escalate(`交给仓库方的 PR 被关闭、没有合并：${task.pr}`);
  if (!same(pr.head, handed.head)) return c.escalate(`交接后 PR head 变了（${short(handed.head)} → ${short(pr.head)}），本机审查证据只覆盖交接的 head`);
  if (pr.state === "OPEN") return c.out("waiting", "已交仓库方合并，等 PR 结果");
  if (!pr.mergeSha) return c.out("held", "PR 已合并但还读不到合并提交，下轮再看");
  const r = await c.deps.manager("ledger", "scheduler-merge-handoff", task.id, "--head", handed.head, "--pr", task.pr, "--merged", pr.mergeSha);
  if (r.ok !== true) return c.out("held", `合并结果没记上：${String(r.error)}`);
  await tell(c, `[调度引擎] ${task.id} 的 PR 已由仓库方合并（${short(pr.mergeSha)}），卡片进 live：本机跟上 main 后跑 ledger verify`);
  return c.out("landed", `仓库方已合并 ${short(pr.mergeSha)}，进 live`);
}
