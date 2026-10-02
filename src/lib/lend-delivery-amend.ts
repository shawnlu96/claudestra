/**
 * 写单交付说明补写（i28-RPX1）：A 回 `delivery_note`（交付说明缺『复现测试：』，只要补文字就能过）时不停单——
 * 把拒收原因发回原 worker 会话，让它只补写一行摘要（不改代码、不提交、不推送），出借服务按同一个 head、同一租约重交。
 * 发出前先自查：订单 acceptance 要复现测试、摘要里却没有的，先补一次再发，省一个来回。
 * 规矩：同一张单最多补 MAX_AMENDS 次（自查与 A 拒收合计），再不合格停单；补写期间单留在 result_pending、交付正文清空，
 * 续租 / 失租照现有规则（lend-drive.ts heartbeat）；head 取 journal 里 worker 交的那个，推送的永远是它，worker 之后多出的提交不进。
 * 补写状态记 lend_meta（delivery-amend:<单号>，不加列），先写状态再发给 worker；没送到下一轮补发。
 * worker 把补好的摘要写进工作副本里的 NOTE_FILE，lend 循环每轮看一次，读到就删。tests/lend-delivery-amend.test.ts。
 */
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getMeta, orderOf, patchOrder, setMeta, type LendRow } from "./lend-journal.js";
import type { LendDeps } from "./lend-drive.js";
import { REPRO_NOTE_RE } from "./lend-delivery-amend-code.js";

export { DELIVERY_NOTE } from "./lend-delivery-amend-code.js";

const MAX_AMENDS = 2;
/** 发出补写指令后等 worker 写回的上限：worker 不回就停单，不无限占着租约 */
const AMEND_WAIT_MS = 30 * 60_000;
export const NOTE_FILE = "lend-delivery-note.txt";
const SUMMARY_MAX = 500;
const REPRO_ASK_RE = /复现测试(?:名)?[:：]/;
const BAD_LINE = /[\p{Cc}\u2028\u2029]/u;

type AmendDeps = Pick<LendDeps, "db" | "now" | "log"> & { worker: Pick<LendDeps["worker"], "send"> };
interface AmendState { n: number; head: string; waiting: boolean; told: boolean; since: number; why: string }

const key = (orderId: string) => `delivery-amend:${orderId}`;
export const amendState = (d: Pick<LendDeps, "db">, orderId: string): AmendState | null => {
  const v = getMeta(d.db, key(orderId));
  return v ? (JSON.parse(v) as AmendState) : null;
};
const save = (d: AmendDeps, orderId: string, s: AmendState) => setMeta(d.db, key(orderId), JSON.stringify(s));

/** 订单验收线里有没有「交付说明写复现测试」这一条（FIX_STRATEGY_RULE 进了 acceptance 的修复单） */
function needsReproNote(row: Pick<LendRow, "wire">): boolean {
  const acc = orderOf(row)?.acceptance;
  return Array.isArray(acc) && acc.some((a) => typeof a === "string" && REPRO_ASK_RE.test(a));
}

/** 补好的摘要合不合格：null = 合格，否则是发回给 worker 的原因 */
function noteProblem(summary: string): string | null {
  if (!summary || BAD_LINE.test(summary) || Buffer.byteLength(summary) > SUMMARY_MAX) return `补写的摘要要是一行、非空、不超过 ${SUMMARY_MAX} 字节`;
  return REPRO_NOTE_RE.test(summary) ? null : "补写的摘要里仍没有『复现测试：<测试名>』";
}

const notePath = (row: LendRow) => join(row.dir ?? "", NOTE_FILE);
const drop = (path: string) => { try { unlinkSync(path); } catch { /* 没有就算了 */ } };

/** 读 worker 写回的摘要并删掉文件；没有 = null。只收普通文件（软链 / 目录不跟），读到的按一行处理 */
function takeNote(row: LendRow): string | null {
  const path = notePath(row);
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (!st.isFile() || st.size > 4 * SUMMARY_MAX) return (drop(path), ""); // 不是普通文件 / 太大：按补写不合格处理
  const text = readFileSync(path, "utf8").trim();
  drop(path);
  return text;
}

function instruction(row: LendRow, s: AmendState): string {
  return [`【补写交付说明（第 ${s.n}/${MAX_AMENDS} 次）】单号 ${row.orderId} 的交付没能入账：${s.why}`,
    "代码不用改：不要 git commit、不要 push、不要重跑 lend submit。",
    `只把补好的一行摘要（≤ ${SUMMARY_MAX} 字节，必须写「复现测试：<测试名>」并说明先红后绿结果）写进这个文件：${notePath(row)}`,
    `写完结束本轮即可；出借服务按同一个 head（${s.head.slice(0, 12)}）、同一租约重新交。`].join("\n");
}

async function tell(row: LendRow, s: AmendState, d: AmendDeps): Promise<void> {
  const r = await d.worker.send(row.agent!, row.sessionId!, instruction(row, s), `${row.orderId}:delivery-note:${s.n}`);
  if (r.ok || r.delivered !== false) return save(d, row.orderId, { ...s, told: true }); // 送没送到不明：不重发（同首条派单）
  d.log(`${row.orderId} 补写说明指令没送到（${r.reason}），下轮再发`);
}

/** 让 worker 补一次；超过次数返回停单原因，否则 null */
async function ask(row: LendRow, why: string, d: AmendDeps): Promise<string | null> {
  const n = (amendState(d, row.orderId)?.n ?? 0) + 1;
  if (n > MAX_AMENDS) return `补写说明 ${MAX_AMENDS} 次仍不合格：${why}`.slice(0, 400);
  const s: AmendState = { n, head: row.work!.head, waiting: true, told: false, since: d.now(), why: why.slice(0, 300) };
  save(d, row.orderId, s);
  drop(notePath(row)); // 上一次的残留不算这一次的回复
  await tell(row, s, d);
  return null;
}

/**
 * 写单推送 / 拼交付正文之前（lend-drive.ts forwardResult）：返回行 = 可以发（摘要可能已换成补好的）；false = 等 worker 补写；
 * 字符串 = 停单原因（补写次数用完、等太久）
 */
export async function preflightDelivery(row: LendRow, d: AmendDeps): Promise<LendRow | false | string> {
  const s = amendState(d, row.orderId);
  if (s?.waiting) {
    if (!s.told) await tell(row, s, d);
    const note = takeNote(row);
    if (note === null) return d.now() - s.since > AMEND_WAIT_MS ? `补写说明等了 ${AMEND_WAIT_MS / 60_000} 分钟 worker 没写回，停单` : false;
    const bad = noteProblem(note);
    if (bad) return (await ask(row, bad, d)) ?? false;
    save(d, row.orderId, { ...s, waiting: false });
    return patchOrder(d.db, row.orderId, ["result_pending"], { work: { ...row.work!, head: s.head, summary: note } }, d.now());
  }
  if (needsReproNote(row) && !REPRO_NOTE_RE.test(row.work?.summary ?? "")) {
    return (await ask(row, "订单验收线要求交付说明写「复现测试：<测试名>」，摘要里没有（发出前自查）", d)) ?? false;
  }
  return row;
}

/** A 回 delivery_note：清掉这份交付正文，让 worker 补写（下一轮 preflightDelivery 接着走）；null = 已转补写，字符串 = 停单原因 */
export async function amendDelivery(row: LendRow, error: string, d: AmendDeps): Promise<string | null> {
  if (!row.work) return `A 不收结论：delivery_note ${error}`;
  if ((amendState(d, row.orderId)?.n ?? 0) >= MAX_AMENDS) return `补写说明 ${MAX_AMENDS} 次仍不合格：A 不收结论：${error}`.slice(0, 400);
  row = patchOrder(d.db, row.orderId, ["result_pending"], { payload: null, payloadSha: null }, d.now());
  return ask(row, `A 拒收：${error}`, d);
}
