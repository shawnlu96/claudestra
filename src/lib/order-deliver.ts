/**
 * M2 deliver：执行者交付当前的单，效果等同 `ledger deliver <task> --from build|fix --head --evidence`（写经 lib/order-ledger-exit.ts）。
 * 顺序即保证，改动前先读 tests/order-deliver.test.ts：
 * 1. 参数先过 T87 parseDeliverWire，再要求 head 是小写 40 位 SHA；不过就拒，什么都不写、不投。
 * 2. 同一 orderId + head 的重试按 dedup 键找回第一次的事件（必须是调用方自己写的），原样返回——第一次已经把卡推到 review，
 *    再往下走会被「不是当前的单」挡掉，所以回放在前。
 * 3. orderId 必须是调用方当前的单（lib/order-take.ts，含会话绑定），这样替别的 agent / 会话交付、交错卡都进不来。
 * 4. bridge 自己查 origin 上这张卡分支的 head（台账的 branch，不收参数），查不到或不一致就拒，不写。
 * 5. CLI 在事务里再核一次阶段与执行者：两步之间卡被 PM 收回，CLI 抛 conflict / forbidden，台账不动。
 */
import type { Database } from "bun:sqlite";
import { getEventByDedup, getTask } from "./ledger-store.js";
import { ledgerWrite, type LedgerRun } from "./order-ledger-exit.js";
import { currentOrders } from "./order-take.js";
import { refuse, type OrderToolResult, type VerifiedCall } from "./order-tool-route.js";
import { parseDeliverWire } from "./order-wire.js";
import type { BoundedResult } from "./run-bounded.js";

const SHA40 = /^[0-9a-f]{40}$/;
/** git 分支名里能出现、又不会被当成选项或路径穿越的字符；台账写 branch 时不校验形状，这里兜一次 */
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;

export type RemoteHead = { ok: true; head: string } | { ok: false; error: string };

export interface DeliverDeps {
  /** 台账只读连接；没有台账 = null */
  db: Database | null;
  /** origin 上某个分支现在的 head（bridge 在调用方的工作目录里跑 git ls-remote） */
  remoteHead(call: VerifiedCall, branch: string): Promise<RemoteHead>;
  run: LedgerRun;
}

export const deliverDedupKey = (orderId: string, head: string): string => `mcp-deliver:${orderId}:${head}`;

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

function replayed(db: Database, call: VerifiedCall, key: string): OrderToolResult | null {
  const e = getEventByDedup(db, key);
  if (!e) return null;
  if (e.kind !== "deliver" || e.actor !== call.agent) return refuse("dedup_conflict", "这个单号 + head 已被别的交付用过");
  const task = getTask(db, e.target);
  return { ok: true, duplicate: true, taskId: e.target, stage: task?.stage ?? null, eventSeq: e.seq };
}

export async function deliverOrder(call: VerifiedCall, args: unknown, deps: DeliverDeps): Promise<OrderToolResult> {
  const w = parseDeliverWire(args);
  if (!w.ok) return refuse("invalid_wire", w.error);
  const { orderId, head, evidence, summary, selfCheck } = w.value;
  if (!SHA40.test(head)) return refuse("invalid_wire", "head 要是小写的完整 40 位 SHA");
  if (!deps.db) return refuse("no_ledger", "这台机器没有台账");
  const key = deliverDedupKey(orderId, head);
  const again = replayed(deps.db, call, key);
  if (again) return again;
  const cur = currentOrders(deps.db, call).find((o) => o.orderId === orderId);
  if (!cur) return refuse("not_current_order", `${orderId} 不是你当前的单（take_order 看当前的单；卡可能已被收回或换了人 / 会话）`);
  if (!cur.task.branch) return refuse("no_branch", `台账里 ${cur.task.id} 没记分支，bridge 没法核对 head：请 PM 补 --branch，或走 CLI`);
  const remote = await deps.remoteHead(call, cur.task.branch);
  if (!remote.ok) return refuse("head_unverifiable", remote.error);
  if (remote.head !== head) return refuse("head_mismatch", `origin 上 ${cur.task.branch} 的 head 是 ${remote.head}，不是 ${head}：先 push，或用远端的 head 交付`);
  const r = await ledgerWrite(call, deps.run, "deliver", cur.task.id, { from: cur.stage, head, evidence, text: `${summary}\n自查：${selfCheck}` }, key);
  if (!r.ok) return r;
  const ev = r.event as { seq?: number } | undefined;
  const task = r.task as { stage?: string } | undefined;
  return { ok: true, duplicate: r.duplicate === true, orderId, taskId: cur.task.id, stage: task?.stage ?? null, eventSeq: ev?.seq ?? null };
}
