/**
 * M2 deliver：执行者交付当前的单，效果等同 `ledger deliver <task> --from build|fix --head --evidence`（写经 lib/order-ledger-exit.ts）。
 * 顺序即保证，改动前先读 tests/order-deliver.test.ts：
 * 1. 参数先过 T87 parseDeliverWire，再要求 head 是小写 40 位 SHA；不过就拒，什么都不写、不投。
 * 2. 同一 orderId + head 的重试按 dedup 键找回第一次的事件（必须是调用方自己写的），原样返回——第一次已经把卡推到 review，
 *    再往下走会被「不是当前的单」挡掉，所以回放在前。
 * 3. orderId 必须是调用方当前的单（lib/order-take.ts，含会话绑定），这样替别的 agent / 会话交付、交错卡都进不来。
 * 4. bridge 自己查 origin 上这张卡分支的 head（台账的 branch，不收参数），查不到或不一致就拒，不写。
 * 5. 查远端之前记下卡的 rev 与分支，作为 CLI 的前置条件（--rev / --branch）：CLI 在写入的同一事务里核对，查询期间卡被改过
 *    （换分支、PM 收回等）就抛 conflict，台账不动；阶段与执行者 CLI 也会再核一次。
 * 6. 远端 head 核对过后查这个分支的 open PR（lib/order-deliver-pr.ts）：0 个 / 多个 / 跨仓 / base 不是 main / head 不一致 / gh 失败都拒，不写；
 *    通过的 URL 以 --pr 交给 CLI，在同一事务里写进空的或非完整的 task.pr；卡上已是另一个完整 URL 就拒（PR 换了要 PM 处理）。
 * 6b. scheduler.json localMerge 项目（没有 origin / PR）：4、6 换成 `git rev-parse refs/heads/<branch>`（项目 repoDir 里），不调 gh，不带 --pr，task.pr 保持原样。
 * 7. 只有本次 CLI 新写入成功后，已验证的 bridge 回调才确认来源；确认事务重核回执、卡与会话。
 *    CLI 自报参数/环境不产生来源，重放不补确认；确认前崩溃也保持 manual。
 * 回执只由单号与交付事件决定（阶段固定是交付推到的 review），重试每次一样，不随卡后来的阶段变。
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup } from "./ledger-store.js";
import { BRANCH, pickPr, prConflict, type PrRows } from "./order-deliver-pr.js";
import { ledgerWrite, type LedgerRun } from "./order-ledger-exit.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { parseDeliverWire } from "./order-wire.js";
import { deliveredScope } from "./order-deliver-scope.js";
import { deliverDedupKey, withMemoryRefs } from "./memory-tools-refs.js";
import type { confirmOrderDelivery } from "./ledger-autostart-resume.js";
import type { BoundedResult } from "./run-bounded.js";
import { uiReplaySame } from "./ledger-deliver-ui.js";
import { noChangeReplay, type NoChange } from "./order-no-change.js";

const SHA40 = /^[0-9a-f]{40}$/;

export type RemoteHead = { ok: true; head: string } | { ok: false; error: string };

export interface DeliverDeps {
  /** 台账只读连接；没有台账 = null */
  db: Database | null;
  /** origin 上某个分支现在的 head（bridge 在调用方的工作目录里跑 git ls-remote） */
  remoteHead(call: VerifiedCall, branch: string): Promise<RemoteHead>;
  /** 这个分支在 origin 上 open 的 PR（bridge 在调用方工作目录跑 gh，lib/order-deliver-pr.ts findPrRows）；必填，没有就不让交付 */
  findPr(call: VerifiedCall, branch: string): Promise<PrRows>;
  run: LedgerRun;
  /** localMerge 项目的仓库目录（lib/scheduler-config.ts localMergeOf）；null / 不注入 = 走 origin + PR */
  localMerge?(project: string): { repoDir: string } | null;
  /** 本机分支的 head（localBranchHead）；localMerge 项目必需，没有就不让交付 */
  localHead?(repoDir: string, branch: string): Promise<RemoteHead>;
  /** Bridge-owned confirmation; absent means delivery succeeds without automatic handback eligibility. */
  confirmSource?(call: VerifiedCall, input: Parameters<typeof confirmOrderDelivery>[2]): boolean;
}

export { deliverDedupKey }; // 定义在 memory-tools-refs.ts（memoryRefs 认同一个键；放那边免得两文件互相 import 成环）

/** 解析 `git ls-remote origin refs/heads/<branch>` 的输出：恰好一行、ref 名完全一致才算 */
export function parseLsRemote(r: BoundedResult, branch: string): RemoteHead {
  if (r.timedOut) return { ok: false, error: "git ls-remote 超时，查不到 origin 上的分支 head" };
  if (r.code !== 0) return { ok: false, error: `git ls-remote 失败（exit ${r.code}）：${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}` };
  const rows = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2 && p[1] === `refs/heads/${branch}`);
  if (rows.length !== 1 || !SHA40.test(rows[0][0])) return { ok: false, error: `origin 上没有分支 ${branch}（先 push）` };
  return { ok: true, head: rows[0][0] };
}

type Runner = (argv: string[], o: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs: number }) => Promise<BoundedResult>;

export async function remoteBranchHead(cwd: string | undefined, branch: string, run: Runner): Promise<RemoteHead> {
  if (!cwd) return { ok: false, error: "registry 里没有调用方的工作目录，没法查 origin" };
  if (!BRANCH.test(branch)) return { ok: false, error: `台账里的分支名 ${branch.slice(0, 80)} 不合法` };
  const r = await run(["git", "ls-remote", "origin", `refs/heads/${branch}`], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000 });
  return parseLsRemote(r, branch);
}

/** 本机 `git rev-parse --verify refs/heads/<branch>^{commit}`：localMerge 项目的分支不离开这台机器 */
export async function localBranchHead(repoDir: string, branch: string, run: Runner): Promise<RemoteHead> {
  if (!BRANCH.test(branch)) return { ok: false, error: `台账里的分支名 ${branch.slice(0, 80)} 不合法` };
  const argv = ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`];
  const r = await run(argv, { cwd: repoDir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 15_000 });
  if (r.timedOut) return { ok: false, error: "git rev-parse 超时，查不到本机分支 head" };
  const sha = r.stdout.trim();
  return r.code === 0 && SHA40.test(sha) ? { ok: true, head: sha } : { ok: false, error: `本机仓库里没有分支 ${branch}（先 commit）` };
}

type Checked = { ok: true; pr: string | null } | { ok: false; refusal: OrderToolResult };
const no = (code: string, error: string): Checked => ({ ok: false, refusal: refuse(code, error) });

/** 第 4、6 步：origin 上的 head 与 open PR */
async function remoteChecked(call: VerifiedCall, deps: DeliverDeps, task: { id: string; pr: string | null }, branch: string, head: string): Promise<Checked> {
  const remote = await deps.remoteHead(call, branch);
  if (!remote.ok) return no("head_unverifiable", remote.error);
  if (remote.head !== head) return no("head_mismatch", `origin 上 ${branch} 的 head 是 ${remote.head}，不是 ${head}：先 push，或用远端的 head 交付`);
  const found = await deps.findPr(call, branch);
  if (!found.ok) return no("pr_unverifiable", found.error);
  const pr = pickPr(found.rows, branch, head);
  if (!pr.ok) return no(pr.code, pr.error);
  if (prConflict(task.pr, pr.url)) return no("pr_mismatch", `台账里 ${task.id} 的 PR 是 ${task.pr}，查到的是 ${pr.url}：PR 换了请 PM 处理`);
  return { ok: true, pr: pr.url };
}

/** 第 6b 步：本机分支的 head，没有 PR */
async function localChecked(deps: DeliverDeps, repoDir: string, branch: string, head: string): Promise<Checked> {
  if (!deps.localHead) return no("head_unverifiable", "这台 bridge 没接本机分支核对，localMerge 项目没法交付");
  const local = await deps.localHead(repoDir, branch);
  if (!local.ok) return no("head_unverifiable", local.error);
  if (local.head !== head) return no("head_mismatch", `本机分支 ${branch} 的 head 是 ${local.head}，不是 ${head}：用本机分支的 head 交付`);
  return { ok: true, pr: null };
}

/** deliver 带 --from 时同一事务把卡推到 review（lib/ledger-write.ts deliver） */
const DELIVERED_STAGE = "review";

const receipt = (duplicate: boolean, orderId: string, taskId: string, eventSeq: number | null): OrderToolResult =>
  ({ ok: true, duplicate, orderId, taskId, stage: DELIVERED_STAGE, eventSeq });

function replayed(db: Database, call: VerifiedCall, key: string, orderId: string, uiEvidence: unknown): OrderToolResult | null {
  const e = getEventByDedup(db, key);
  if (!e) return null;
  if (e.kind !== "deliver" || e.actor !== call.agent) return refuse("dedup_conflict", "这个单号 + head 已被别的交付用过");
  if (!uiReplaySame(e, uiEvidence)) return refuse("dedup_conflict", "这个单号 + head 已用另一份截图清单交付过，不覆盖");
  return receipt(true, orderId, e.target, e.seq);
}

/**
 * CINOOP1：带 noChange 的正式单交付（head = 卡的当前 head，不推空提交）。out_of_scope_ci 仍先核 origin 上分支 head；之后交给
 * `ledger deliver --no-change`（ci-no-change-recovery.ts 专用事务），不带 --from、不推 review；本地合并项目没有 PR CI，不走此出口。
 * 单号与会话（来自身份）作为 --order / --session 交给 CLI，在写事务里核「仍是调用方当前的单」。成功后卡已离开 build / fix，所以重试先按单号查
 * noChange 回执（noChangeReceipt）：同一份返回原 outcome，换了理由 / 证据拒。恢复 / 取消与否看回执里的 noChange.outcome；未恢复是拒绝（带原因），不是成功回执。
 */
function noChangeReplayed(db: Database, call: VerifiedCall, orderId: string, head: string, nc: NoChange): OrderToolResult | null {
  const r = noChangeReplay(db, orderId, nc, { head, actor: call.agent });
  if (r.kind === "none") return null;
  if (r.kind === "conflict") return refuse("dedup_conflict", "这个单号已用另一份 noChange（或别人）入账，不覆盖");
  return { ok: true, duplicate: true, orderId, taskId: r.event.target, noChange: { outcome: r.outcome, eventSeq: r.event.seq }, eventSeq: r.event.seq };
}

async function deliverNoChange(call: VerifiedCall, deps: DeliverDeps, task: { id: string; rev: number; headSHA: string | null },
  w: { orderId: string; head: string; evidence: string; noChange: NoChange; local: boolean; branch: string }, key: string): Promise<OrderToolResult> {
  if (w.local) return refuse("no_change_local", "本地合并项目没有 PR CI，noChange 不适用：按标准答复在证据报告里写明失败的检查");
  if (task.headSHA && task.headSHA !== w.head) return refuse("invalid_wire", "带 noChange 的交付 head 必须就是卡的当前 head：无需改码就不该有新提交");
  if (w.noChange.kind === "out_of_scope_ci") {
    const remote = await deps.remoteHead(call, w.branch);
    if (!remote.ok) return refuse("head_unverifiable", remote.error);
    if (remote.head !== w.head) return refuse("head_mismatch", `origin 上 ${w.branch} 的 head 是 ${remote.head}，不是 ${w.head}`);
  }
  const r = await ledgerWrite(call, deps.run, "deliver", task.id, { head: w.head, evidence: w.evidence, "no-change": JSON.stringify(w.noChange),
    order: w.orderId, ...(call.sessionId ? { session: call.sessionId } : {}), rev: String(task.rev), branch: w.branch }, key);
  if (!r.ok) return r;
  return { ok: true, duplicate: r.duplicate === true, orderId: w.orderId, taskId: task.id, noChange: r.noChange ?? null, eventSeq: r.eventSeq ?? null };
}

export async function deliverOrder(call: VerifiedCall, args: unknown, deps: DeliverDeps): Promise<OrderToolResult> {
  const w = parseDeliverWire(args);
  if (!w.ok) return refuse("invalid_wire", w.error);
  const { orderId, head, evidence, summary, selfCheck, disputes, memoryRefs, uiEvidence, noChange } = w.value;
  if (!SHA40.test(head)) return refuse("invalid_wire", "head 要是小写的完整 40 位 SHA");
  if (!deps.db) return refuse("no_ledger", "这台机器没有台账");
  const key = deliverDedupKey(orderId, head);
  const ncAgain = noChange ? noChangeReplayed(deps.db, call, orderId, head, noChange) : null;
  if (ncAgain) return ncAgain;
  const again = replayed(deps.db, call, key, orderId, uiEvidence);
  if (again) return withMemoryRefs(again, call, deps.run, orderId, head, memoryRefs); // 交付之后补记 memoryRefs（wrong → dispute），重放也补
  const cur = currentOrders(deps.db, call).find((o) => o.orderId === orderId);
  if (!cur) return refuse("not_current_order", `${orderId} 不是你当前的单（take_order 看当前的单；卡可能已被收回或换了人 / 会话）`);
  const { branch, rev } = cur.task;
  if (!branch) return refuse("no_branch", `台账里 ${cur.task.id} 没记分支，bridge 没法核对 head：请 PM 补 --branch，或走 CLI`);
  const local = deps.localMerge?.(cur.task.project) ?? null;
  if (noChange) return deliverNoChange(call, deps, cur.task, { orderId, head, evidence, noChange, local: !!local, branch }, key);
  const checked = local ? await localChecked(deps, local.repoDir, branch, head) : await remoteChecked(call, deps, cur.task, branch, head);
  if (!checked.ok) return checked.refusal;
  const flags = { from: cur.stage, head, evidence, text: `${summary}\n自查：${selfCheck}`, rev: String(rev), branch,
    ...(checked.pr ? { pr: checked.pr } : {}), ...(disputes ? { disputes: JSON.stringify(disputes) } : {}),
    ...(uiEvidence ? { "ui-evidence": JSON.stringify(uiEvidence) } : {}) };
  const r = await ledgerWrite(call, deps.run, "deliver", cur.task.id, flags, key);
  if (!r.ok) return r;
  const eventSeq = (r.event as { seq?: number } | undefined)?.seq, deliveredRev = (r.task as { rev?: number } | undefined)?.rev;
  if (r.duplicate === false && Number.isInteger(eventSeq) && Number.isInteger(deliveredRev)) {
    deps.confirmSource?.(call, { before: cur.task, orderId, head, eventSeq: eventSeq!, deliveredRev: deliveredRev! });
  }
  await deliveredScope(deps.db, cur.task.id, head); // 规格外文件登记：异步、不抛，失败只记事件（order-deliver-scope.ts）
  return withMemoryRefs(receipt(r.duplicate === true, orderId, cur.task.id, (r.event as { seq?: number } | undefined)?.seq ?? null), call, deps.run, orderId, head, memoryRefs);
}
