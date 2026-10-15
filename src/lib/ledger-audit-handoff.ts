/**
 * AUDH2-1：merge 阶段、本次停留已交给仓库方合并（merge_handoff 事件，scheduler-merge-handoff.ts）的卡，PM 这边没有合并动作可做。
 * ship_stalled 不再按本机合并的 30 分钟口径催「补做合并部署」：PR 还开着（或这轮没读到）停够 HANDOFF_STALL_MS 才报一条「去问仓库方」；
 * PR 已合并、卡还在 merge 才按原阈值提示部署（本机 HEAD 含不含合并提交快照里没有，照实写「需要部署」）。
 * merge_ready 对交接卡一律不报：合并由对方队列做，走正式合并入口就是重复合并。
 * key = 卡 + 进 merge 时刻 + 交接事件：同一次交接最多推一次，没到阈值时 keep 住。没有交接事件的卡照原规则。
 * tests/ledger-audit-handoff.test.ts。
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { runBounded } from "./run-bounded.js";
import { ghEnv } from "./peer-pr-github.js";

const MIN = 60_000;
/** 交接后 PR 还开着多久才报：仓库方合并队列常要等 main 修绿 / 前置卡，半天内都算正常 */
export const HANDOFF_STALL_MS = 12 * 60 * MIN;

/** 交接卡 PR 的现读状态；mergedAt = GitHub 记的合并时刻（读不出 = null） */
export interface HandoffPrFact { state: "OPEN" | "MERGED" | "CLOSED"; mergeSha: string | null; mergedAt: number | null }
export interface HandoffInputs {
  /** 按任务 id；某卡 null = 这一轮没读到；整个 undefined = 快照没带这个来源（交接卡都按「没读到」处理） */
  handoffPr?: Readonly<Record<string, HandoffPrFact | null>>;
}

/** 本次 merge 停留里的交接事件（与 scheduler-merge-handoff.ts handoffOf 同口径：最近一次进 merge 之后） */
export function handoffEvent(events: readonly LedgerEvent[]): LedgerEvent | null {
  const entry = events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;
  return events.findLast((e) => e.seq > entry && e.kind === "scheduler" && e.data.op === "merge_handoff") ?? null;
}

type Finding = { rule: "ship_stalled"; taskId: string; since: number; keyParts: (string | number)[]; detail: string; suggestion: string };
interface Out { emit(f: Finding): void; keep(rule: "ship_stalled", keyParts: (string | number)[]): void }

const ago = (ms: number) => (ms >= 2 * 60 * MIN ? `${Math.floor(ms / (60 * MIN))} 小时` : `${Math.floor(ms / MIN)} 分钟`);

/**
 * 交接卡的 ship_stalled；返回 false = 不是交接卡，调用方照原规则判。mergeStallMs 由调用方传入（与原规则同一个阈值）。
 */
export function handoffStall(t: { task: LedgerTask; events: readonly LedgerEvent[]; stageSince: number },
  pr: HandoffPrFact | null | undefined, mergeStallMs: number, now: number, out: Out): boolean {
  const ev = handoffEvent(t.events);
  if (!ev) return false;
  const { task } = t, keyParts = [task.id, task.stage, t.stageSince, "handoff", ev.seq];
  const prUrl = task.pr ?? "PR";
  if (pr?.state === "MERGED") {
    const since = Math.max(ev.ts, pr.mergedAt ?? ev.ts);
    if (now - since <= mergeStallMs) { out.keep("ship_stalled", keyParts); return true; }
    out.emit({ rule: "ship_stalled", taskId: task.id, since, keyParts,
      detail: `${task.id} 的 ${prUrl} 已由仓库方合并${pr.mergeSha ? ` ${pr.mergeSha.slice(0, 12)}` : ""}（${ago(now - since)}前），卡还在 merge`,
      suggestion: "需要部署：等本机自动更新，或执行 manager update 后推到 live（不用再走合并入口）" });
    return true;
  }
  if (now - ev.ts <= HANDOFF_STALL_MS) { out.keep("ship_stalled", keyParts); return true; }
  const state = !pr ? "PR 状态这轮没读到" : pr.state === "CLOSED" ? "PR 已被关掉、没有合并" : "PR 还开着";
  out.emit({ rule: "ship_stalled", taskId: task.id, since: ev.ts, keyParts,
    detail: `${task.id} 已交给仓库方合并（${prUrl}），${state}，仓库方合并队列停了 ${ago(now - ev.ts)}`,
    suggestion: "去问仓库方 PR 卡在哪（main 红 / 等前置卡 / 没排上），本机不用补做合并部署" });
  return true;
}

const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;
const SHA = /^[a-f0-9]{40}$/i;

/** 一次 gh pr view；失败 / 输出不合规 = null（规则按「没读到」处理，不猜） */
export async function readHandoffPr(prUrl: string, command: typeof runBounded = runBounded): Promise<HandoffPrFact | null> {
  const r = await command(["gh", "pr", "view", prUrl, "--json", "state,mergeCommit,mergedAt"], { env: ghEnv(), timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) return null;
  let raw: { state?: unknown; mergeCommit?: { oid?: unknown } | null; mergedAt?: unknown };
  try { raw = JSON.parse(r.stdout); } catch { return null; /* 输出坏了等同没读到，规则按长阈值口径处理 */ }
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(raw?.state))) return null;
  const oid = raw.mergeCommit?.oid, at = typeof raw.mergedAt === "string" ? Date.parse(raw.mergedAt) : NaN;
  return { state: raw.state as HandoffPrFact["state"], mergeSha: typeof oid === "string" && SHA.test(oid) ? oid : null, mergedAt: Number.isFinite(at) ? at : null };
}

/** 快照取数：只读 merge 阶段、本次停留有交接事件的卡；单卡读失败记 null，不影响别的卡 */
export async function collectHandoffPr(tasks: readonly { task: LedgerTask; events: readonly LedgerEvent[] }[],
  read: (prUrl: string) => Promise<HandoffPrFact | null> = readHandoffPr): Promise<Record<string, HandoffPrFact | null>> {
  const want = tasks.filter(({ task, events }) => task.stage === "merge" && PR.test(task.pr ?? "") && handoffEvent(events));
  const got = await Promise.all(want.map(async ({ task }) => [task.id, await read(task.pr!).catch(() => null)] as const)); // 抛错同读失败：按没读到处理
  return Object.fromEntries(got);
}
