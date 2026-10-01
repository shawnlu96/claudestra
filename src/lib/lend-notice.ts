/**
 * 给出借方 owner 的三种通知（He 要求 3）：开跑（起 worker 之前）、交付（结论 A 已验收）、停止（含收回）。都经 `ledger lend-inform` 发到控制频道，
 * bridge 收下（送达或进了押后队列）才算交出去。规矩：开跑通知没交出去就不起 worker；交付 / 停止通知和终态同一次写进 journal 的 notices，
 * 发成功才记 sentAt，没发成的随 settle 每轮补发，进程重启后照样补。只有发过开跑通知的单才有交付 / 停止通知（没起过 worker 的单不打扰）。
 * tests/lend-notice.test.ts。
 */
import { lendAskProblem, type LendAskParams } from "./lend-ask.js";
import type { LendEntry } from "./lend-config.js";
import type { LendDeps } from "./lend-drive.js";
import { openSlots, orderOf, ordersToday, patchOrder, type LendRow } from "./lend-journal.js";
import { SHELL_SENTENCE } from "./lend-grant-rules.js";

const KINDS = ["start", "acked", "stopped"] as const;
type LendNoticeKind = (typeof KINDS)[number];
export interface LendNoticeParams extends LendAskParams { kind: LendNoticeKind; why: string | null }

export function lendNoticeProblem(p: unknown): string | null {
  const bad = lendAskProblem(p, ["kind", "why"]);
  if (bad) return bad;
  const r = p as Record<string, unknown>;
  if (!(KINDS as readonly unknown[]).includes(r.kind)) return `kind 只能是 ${KINDS.join(" / ")}`;
  if (r.why !== null && (typeof r.why !== "string" || r.why.length > 300 || /[\p{Cc}]/u.test(r.why))) return "why 要是 300 字以内的一行字或 null";
  return null;
}

const familyOf = (p: LendAskParams) => (p.family === "codex" ? "Codex" : p.family === "claude" ? "Claude" : p.family);
const verbOf = (p: LendAskParams) => (p.step === "write" ? "写代码（开工单）：" : p.step === "fix" ? "改代码（修复单）：" : "审 ");
const HEADS: Record<LendNoticeKind, string> = { start: "出借开跑", acked: "出借交付", stopped: "出借停止" };
const TAILS: Record<LendNoticeKind, string> = {
  start: "worker 马上起。", acked: "结论已交给对方，回执已验。", stopped: "worker 已停。",
};

export function lendNoticeText(p: LendNoticeParams): string {
  const what = `${p.peer} 借的一个 ${familyOf(p)} 位${verbOf(p)}${p.repo}${p.pr ? `#${p.pr}` : ""}`;
  return [
    `${HEADS[p.kind]}：${what}，${TAILS[p.kind]}`,
    ...(p.why ? [`原因：${p.why}`] : []),
    ...(p.kind === "start" ? [`${SHELL_SENTENCE}：它和你是同一个系统用户，能读你家目录里的文件、能用你机器上的 git / SSH 凭据。`] : []),
    `PR：${p.pr ? `https://github.com/${p.repo}/pull/${p.pr}` : "（无 PR，按 head）"}`,
    `head：${p.head}`,
    `对方的卡：${p.taskId} · ${p.step}`,
    `额度：${p.quota}`,
    `随时收回：manager lend revoke --peer ${p.peer}（收回后在跑的 worker 立刻停）`,
  ].join("\n");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 通知参数：claim 之后以完整订单为准，之前用挂单摘要 */
function noticeParams(row: LendRow, kind: LendNoticeKind, why: string | null, quota: string): LendNoticeParams {
  const p = { ...row.preview, ...(orderOf(row) ?? {}) };
  return {
    orderId: row.orderId, peer: row.peer, fp: row.fp, family: row.family, repo: str(p.repo), pr: typeof p.pr === "number" ? p.pr : null, head: str(p.head),
    taskId: str(p.taskId), step: str(p.step), quota, kind, why: why ? why.replace(/[\p{Cc}\s]+/gu, " ").slice(0, 300) : null,
  };
}

function quotaOf(row: LendRow, entry: LendEntry, d: Pick<LendDeps, "db" | "now">): string {
  const fam = entry.families[row.family as "codex"] ?? 0;
  return `今天第 ${ordersToday(d.db, row.peer, d.now())}/${entry.ordersPerDay} 单，${row.family} 位 ${openSlots(d.db, row.peer, row.family)}/${fam}，授权到 ${entry.until}`;
}

/** 起 worker 之前：开跑通知交出去了返回（记了 start 的）行；没交出去返回 null，调用方这轮不起 worker、下轮再发 */
export async function ensureStartNotice(row: LendRow, entry: LendEntry, d: LendDeps): Promise<LendRow | null> {
  if (row.notices?.start) return row;
  const told = await d.notify(noticeParams(row, "start", null, quotaOf(row, entry, d)));
  if (!told.ok) return (d.log(`${row.orderId} 开跑通知没交出去，暂不起 worker：${told.error}`), null);
  return patchOrder(d.db, row.orderId, [row.state], { notices: { ...row.notices, start: d.now() } }, d.now());
}

/** 终态那次写入要带的 notices：发过开跑通知、走到 acked / stopped 的单记一条待发的交付 / 停止通知 */
export function endNotice(row: LendRow, to: string, why: string | null): Pick<LendRow, "notices"> | Record<string, never> {
  if (!row.notices?.start || (to !== "acked" && to !== "stopped")) return {};
  return { notices: { ...row.notices, end: { kind: to, why, sentAt: null } } };
}

/** settle 里调：有待发的交付 / 停止通知就发；发不出去返回 null（保留 settle，下一轮再发），发了或没有要发的返回最新的行 */
export async function flushEndNotice(row: LendRow, d: LendDeps): Promise<LendRow | null> {
  const end = row.notices?.end;
  if (!end || end.sentAt !== null) return row;
  const told = await d.notify(noticeParams(row, end.kind, end.why, "（已结束）"));
  if (!told.ok) return (d.log(`${row.orderId} ${end.kind === "acked" ? "交付" : "停止"}通知没交出去，下轮补发：${told.error}`), null);
  return patchOrder(d.db, row.orderId, [row.state], { notices: { ...row.notices, end: { ...end, sentAt: d.now() } } }, d.now());
}
