/**
 * AUDH2-1：merge 阶段、本次停留已交给仓库方合并（merge_handoff 事件，scheduler-merge-handoff.ts）的卡，PM 这边没有合并动作可做。
 * ship_stalled 不再按本机合并的 30 分钟口径催「补做合并部署」：PR 还开着（或这轮没读到）停够 HANDOFF_STALL_MS 才报「去问仓库方」；
 * PR 已合并进 main、合并时 head 是交接跟的 head、本机 clone 的 main 证实含合并提交（与调度器落 live 同一套事实）才提示部署，
 * 证不了就只提示核查、不建议部署 / 推 live；PR 被关掉没合并单独说。冻结 / 列车排队照原规则不报、keep 住。
 * merge_ready 对交接卡一律不报：合并由对方队列做，走正式合并入口就是重复合并。
 * key = 卡 + 进 merge 时刻 + 交接事件：同一次交接最多推一次。没有交接事件的卡照原规则。tests/ledger-audit-handoff.test.ts。
 */
import type { LedgerEvent, LedgerTask } from "./ledger-stages.js";
import { runBounded } from "./run-bounded.js";
import { ghEnv } from "./peer-pr-github.js";
import { readSchedulerConfig } from "./scheduler-config.js";
import { handoffOnMain } from "./scheduler-merge-handoff-tick.js";

const MIN = 60_000;
/** 交接后 PR 还开着多久才报：仓库方合并队列常要等 main 修绿 / 前置卡，半天内都算正常 */
export const HANDOFF_STALL_MS = 12 * 60 * MIN;

/**
 * 交接卡 PR 的现读状态。mergedAt = GitHub 记的合并时刻；base / head = PR 的目标分支与（合并时的）head；
 * landing = MERGED 进 main 时本机 clone 的 main 含不含合并提交（scheduler-merge-handoff-tick.ts handoffOnMain），没核对 = undefined
 */
export interface HandoffPrFact {
  state: "OPEN" | "MERGED" | "CLOSED"; mergeSha: string | null; mergedAt: number | null; base: string | null; head: string | null;
  landing?: { ok: true } | { ok: false; reason: string };
}
export interface HandoffInputs {
  /** 按任务 id；某卡 null = 这一轮没读到；整个 undefined = 快照没带这个来源（交接卡都按「没读到」处理） */
  handoffPr?: Readonly<Record<string, HandoffPrFact | null>>;
}

/** 本次 merge 停留里的交接事件（与 scheduler-merge-handoff.ts handoffOf 同口径：最近一次进 merge 之后） */
export function handoffEvent(events: readonly LedgerEvent[]): LedgerEvent | null {
  const entry = events.findLast((e) => e.kind === "stage" && e.data.to === "merge")?.seq ?? 0;
  return events.findLast((e) => e.seq > entry && e.kind === "scheduler" && e.data.op === "merge_handoff") ?? null;
}

/** 交接后跟的 PR head：交接的 head，按调度器自己记的 carry 依次前移（handoffOf 同口径） */
function followedHead(events: readonly LedgerEvent[], ev: LedgerEvent): string | null {
  const handed = (ev.data.evidence as { head?: unknown } | undefined)?.head;
  if (typeof handed !== "string") return null;
  return events.reduce((head, e) => e.seq > ev.seq && e.actor === "scheduler" && e.data.op === "merge_handoff_carry"
    && e.data.handoffSeq === ev.seq && e.data.from === head && typeof e.data.to === "string" ? e.data.to : head, handed);
}

type Finding = { rule: "ship_stalled"; taskId: string; since: number; keyParts: (string | number)[]; detail: string; suggestion: string };
interface Out { emit(f: Finding): void; keep(rule: "ship_stalled", keyParts: (string | number)[]): void }

const ago = (ms: number) => (ms >= 2 * 60 * MIN ? `${Math.floor(ms / (60 * MIN))} 小时` : `${Math.floor(ms / MIN)} 分钟`);
const short = (s: string | null) => (s ?? "（无）").slice(0, 12);

/** 已合并的 PR 证不证得了「进了 main、就是交接跟的 head」：证得了 = null，否则是为什么 */
function unproved(pr: HandoffPrFact, follow: string | null): string | null {
  if (pr.base !== "main") return `PR 合进的是 ${pr.base ?? "（读不出的分支）"}，交接只认合进 main`;
  if (!follow || !pr.head || pr.head.toLowerCase() !== follow.toLowerCase()) return `合并时 PR head ${short(pr.head)} 不是交接后跟的 ${short(follow)}`;
  if (!pr.landing) return "没核对本机 main 是否含合并提交";
  return pr.landing.ok ? null : pr.landing.reason;
}

/** 这次交接该说什么、从哪算、阈值多少（没满阈值由调用方 keep） */
function verdict(ev: LedgerEvent, events: readonly LedgerEvent[], pr: HandoffPrFact | null | undefined, mergeStallMs: number, prUrl: string,
  now: number): { since: number; limit: number; detail: string; suggestion: string } {
  if (pr?.state === "CLOSED") {
    return { since: ev.ts, limit: mergeStallMs, detail: `交给仓库方的 ${prUrl} 被关闭、没有合并`, suggestion: "问仓库方为什么关了，按结论退回 fix 重交或作废这张卡" };
  }
  if (pr?.state === "MERGED") {
    const since = Math.max(ev.ts, pr.mergedAt ?? ev.ts), why = unproved(pr, followedHead(events, ev));
    const what = `${prUrl} 已由仓库方合并${pr.mergeSha ? ` ${short(pr.mergeSha)}` : ""}（${ago(now - since)}前），卡还在 merge`;
    return why ? { since, limit: mergeStallMs, detail: `${what}；没证实进了 main：${why}`, suggestion: "先核查 PR 合到了哪、合的是不是交接的 head；证实前不要部署、不要推 live" }
      : { since, limit: mergeStallMs, detail: what, suggestion: "需要部署：等本机自动更新，或执行 manager update 后推到 live（不用再走合并入口）" };
  }
  const state = pr ? "PR 还开着" : "PR 状态这轮没读到";
  return { since: ev.ts, limit: HANDOFF_STALL_MS, detail: `已交给仓库方合并（${prUrl}），${state}，仓库方合并队列停了 ${ago(now - ev.ts)}`,
    suggestion: "去问仓库方 PR 卡在哪（main 红 / 等前置卡 / 没排上），本机不用补做合并部署" };
}

/**
 * 交接卡的 ship_stalled；返回 false = 不是交接卡，调用方照原规则判。parked = 冻结 / 列车排队（与原规则同口径：不报、keep 住）。
 */
export function handoffStall(t: { task: LedgerTask; events: readonly LedgerEvent[]; stageSince: number }, pr: HandoffPrFact | null | undefined,
  o: { mergeStallMs: number; parked: boolean; now: number }, out: Out): boolean {
  const ev = handoffEvent(t.events);
  if (!ev) return false;
  const { task } = t, keyParts = [task.id, task.stage, t.stageSince, "handoff", ev.seq];
  const v = verdict(ev, t.events, pr, o.mergeStallMs, task.pr ?? "PR", o.now);
  if (o.parked || o.now - v.since <= v.limit) { out.keep("ship_stalled", keyParts); return true; }
  out.emit({ rule: "ship_stalled", taskId: task.id, since: v.since, keyParts, detail: `${task.id} ${v.detail}`, suggestion: v.suggestion });
  return true;
}

const PR = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/?$/;
const SHA = /^[a-f0-9]{40}$/i;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** 一次 gh pr view；失败 / 输出不合规 = null（规则按「没读到」处理，不猜） */
export async function readHandoffPr(prUrl: string, command: typeof runBounded = runBounded): Promise<HandoffPrFact | null> {
  const r = await command(["gh", "pr", "view", prUrl, "--json", "state,mergeCommit,mergedAt,baseRefName,headRefOid"], { env: ghEnv(), timeoutMs: 30_000 });
  if (r.code !== 0 || r.timedOut) return null;
  let raw: { state?: unknown; mergeCommit?: { oid?: unknown } | null; mergedAt?: unknown; baseRefName?: unknown; headRefOid?: unknown };
  try { raw = JSON.parse(r.stdout); } catch { return null; /* 输出坏了等同没读到，规则按长阈值口径处理 */ }
  if (!["OPEN", "MERGED", "CLOSED"].includes(String(raw?.state))) return null;
  const oid = str(raw.mergeCommit?.oid), head = str(raw.headRefOid), at = Date.parse(str(raw.mergedAt) ?? "");
  return { state: raw.state as HandoffPrFact["state"], mergeSha: oid && SHA.test(oid) ? oid : null, mergedAt: Number.isFinite(at) ? at : null,
    base: str(raw.baseRefName), head: head && SHA.test(head) ? head : null };
}

/** 生产取数：gh 读 PR；合进 main 的再在项目 clone（scheduler.json repoDir）里核对 main 含不含合并提交，与调度器落 live 同一个函数 */
async function liveHandoffPr(prUrl: string, project: string): Promise<HandoffPrFact | null> {
  const pr = await readHandoffPr(prUrl);
  if (pr?.state !== "MERGED" || pr.base !== "main" || !pr.mergeSha) return pr;
  const dir = readSchedulerConfig().projects[project]?.repoDir;
  if (!dir) return { ...pr, landing: { ok: false, reason: "项目没配 repoDir，核对不了 main 是否含合并提交" } };
  const landing = await handoffOnMain(dir)(prUrl, pr.mergeSha).catch((e: Error) => ({ ok: false as const, reason: `核对 main 失败：${e.message}` }));
  return { ...pr, landing: landing.ok ? { ok: true } : landing };
}

/** 快照取数：只读 merge 阶段、本次停留有交接事件的卡；单卡读失败记 null，不影响别的卡 */
export async function collectHandoffPr(tasks: readonly { task: LedgerTask; events: readonly LedgerEvent[] }[],
  read: (prUrl: string, project: string) => Promise<HandoffPrFact | null> = liveHandoffPr): Promise<Record<string, HandoffPrFact | null>> {
  const want = tasks.filter(({ task, events }) => task.stage === "merge" && PR.test(task.pr ?? "") && handoffEvent(events));
  const got = await Promise.all(want.map(async ({ task }) => [task.id, await read(task.pr!, task.project).catch(() => null)] as const)); // 抛错同读失败：按没读到处理
  return Object.fromEntries(got);
}
