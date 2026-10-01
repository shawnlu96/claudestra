/**
 * 出借方 B 的批量心跳 beat（docs/design/remote-capacity.md §8.3）：proto 2 下续租只走它，按 peer 一批（≤50 单，超了分批），
 * 间隔用 A 回的 beatMs（夹在 5–60 秒，缺省 15 秒）。收录这个 peer 名下占着租约的单，外加收回时停下、等着告诉 A 的单（带 ended）。
 * 应答逐单做成和 v1 renew 同形的结果（Renewal），交回 lend-drive.ts heartbeat 的现有处理（GONE 表、「等回执的只停 worker」那条例外）：
 * ok 且代数相同 → 截止 = 收到应答的时刻 + ms；代数对不上 → stale_gen；其余 verdict 原样当码。应答里有没发过的单号、重复单号或看不懂
 * → 整批当没收到，一单都不续；失败只记日志，截止不动。被 A 以 invalid 拒 → 本轮摘要全部置空重发一次（摘要不能连累续租）。
 * 摘要处理顺序固定：去 ANSI / 控制字符 → redactForPeer → 按字节留末尾 ≤1 KiB → 和整批一起过 A 的解析器。tests/lend-beat.test.ts。
 */
import { redactForPeer } from "./dispatch-redact.js";
import { roleOfStep } from "./lend-git.js";
import { isRevoked } from "./lend-grant.js";
import { helloState, metaJson, notV2, type HelloDeps } from "./lend-hello.js";
import { liveOrders, orderOf, patchOrder, setMeta, unsettledOrders, LEASED_STATES, type LendRow } from "./lend-journal.js";
import { LEND_OLD_PEER, lendRequest, type Lease, type LendRes } from "./lend-remote.js";
import { parseV2Request, type BeatAnswer, type BeatOrder } from "./lend-wire-v2.js";
import { publishFail, publishFailLine } from "./lend-pr-takeover-retry.js";

/** heartbeat 拿到的续租结果：res 同 v1 renew 的 lendRequest 结果，at = 收到 beat 应答的时刻 */
export type Renewal = { res: LendRes<Lease | null>; at: number };

const BATCH_MAX = 50;
const EXCERPT_MAX = 1024;
const EVERY_MS = { min: 5_000, max: 60_000, fallback: 15_000 };
const beatKey = (peer: string): string => `beat:${peer}`;

/** ANSI 转义（CSI / OSC / 单字符）与 A 不收的控制字符（只留 \n、\t；\r 也去掉） */
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const CTRL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** 摘要：先脱敏、后截断（先截的话开头可能留下半截 token，脱敏规则认不出来）；按字节留末尾，不切断多字节字符 */
export function excerptOf(raw: string): string {
  const clean = redactForPeer(raw.replace(ANSI_RE, "").replace(CTRL_RE, "")).text;
  const b = Buffer.from(clean, "utf8");
  if (b.length <= EXCERPT_MAX) return clean;
  let i = b.length - EXCERPT_MAX;
  while (i < b.length && (b[i] & 0xc0) === 0x80) i++;
  return b.subarray(i).toString("utf8");
}

const stepOf = (row: LendRow): string => String(orderOf(row)?.step ?? row.preview.step ?? "");

/** 收回停单的 phase 按停之前走到哪算（终态行没有原状态，看起没起过 worker） */
export function phaseOf(row: LendRow): BeatOrder["phase"] {
  if (row.work && !row.payload) return "publishing";
  if (row.state === "claimed") return "cloning";
  if (row.state === "cloned") return "starting";
  if (row.state === "result_pending") return "result_pending";
  return row.state === "started" || row.startedAt !== null ? "working" : "starting";
}

/**
 * 收回停单能不能报 clean：worker 已确认退出（走到 stopped 终态本身就是 kill 确认之后），并且是审查单，或者是从没推送过的写单
 * （没有交来的 work，也没有交付正文）。work 交了但还没有正文时推送可能已经做过，不算 clean。
 */
const cleanEnd = (row: LendRow): boolean => roleOfStep(stepOf(row)) === "review" || (!row.work && !row.payload);

const clearNotify = (d: HelloDeps, row: LendRow): LendRow => patchOrder(d.db, row.orderId, [row.state], { settle: { ...row.settle!, notify: null } }, d.now());

/** 收回时停下、等着在 beat 里告诉 A 的单；本地租约截止已过还没送到的不再等（清标记、记日志，A 会按租约过期交 PM） */
function endedRows(d: HelloDeps, peer: string, now: number): LendRow[] {
  return unsettledOrders(d.db).filter((r) => r.peer === peer && r.settle?.notify === "stopped" && isRevoked(r)).filter((r) => {
    if (r.leaseGen !== null && r.leaseGen >= 1 && r.leaseUntil !== null && now < r.leaseUntil) return true;
    clearNotify(d, r);
    d.log(`${r.orderId} 收回停单的 ended 在本地租约截止前没送到 ${peer}，不再报（A 会按租约过期交 PM）`);
    return false;
  });
}

interface Item { row: LendRow; ended: boolean }

async function lineOf(d: HelloDeps, it: Item): Promise<Record<string, unknown>> {
  const { row } = it;
  const phase = phaseOf(row);
  const failed = !it.ended && phase === "publishing" ? publishFail(d.db, row.orderId) : null; // 发不出交付：摘要报原因，不报 worker 输出
  const running = !it.ended && !failed && (row.state === "started" || row.state === "result_pending");
  const got = running && d.v2.excerpt ? await d.v2.excerpt(row).catch((e) => (d.log(`读 ${row.orderId} 的输出摘要失败：${(e as Error).message}`), null)) : null;
  const excerpt = failed ? excerptOf(publishFailLine(failed, d.now())) : got ? excerptOf(got.text) : "";
  return { orderId: row.orderId, gen: row.leaseGen, phase, lastActivityAt: Math.max(0, Math.floor(got?.at ?? row.updatedAt)),
    excerpt, ...(it.ended ? { ended: { reason: "revoked", clean: cleanEnd(row) } } : {}) };
}

const blank = (lines: Record<string, unknown>[]) => lines.map((l) => ({ ...l, excerpt: "" }));

function renewalOf(a: BeatAnswer, row: LendRow, at: number): Renewal | null {
  if (a.verdict !== "ok") return { res: { ok: false, status: 200, code: a.verdict, error: `beat：A 说这一单 ${a.verdict}` }, at };
  if (!a.lease) return null;
  if (a.lease.gen !== row.leaseGen) return { res: { ok: false, status: 200, code: "stale_gen", error: `beat 回的租约代数 ${a.lease.gen} 不是本地的 ${row.leaseGen}` }, at };
  return { res: { ok: true, value: a.lease }, at };
}

type BatchOut = { error: string | null; old?: true };

/** 发一批、收一批：结果只落进 renewals（续租交给 heartbeat）和 ended 行的通知标记 */
async function sendBatch(d: HelloDeps, peer: string, items: Item[], lines: Record<string, unknown>[], st: { blank: boolean },
  renewals: Map<string, Renewal>): Promise<BatchOut> {
  let body = st.blank ? blank(lines) : lines;
  if (!parseV2Request("beat", { v: 1, orders: body }).ok) [st.blank, body] = [true, blank(lines)];
  const self = parseV2Request("beat", { v: 1, orders: body });
  if (!self.ok) return { error: `自检没过：${self.error}` };
  let r = await lendRequest(d.v2.call, peer, "beat", { orders: body });
  if (!r.ok && r.code === "invalid" && !st.blank) {
    st.blank = true; // A 嫌正文不合格：摘要全部置空再发一次，续租不能被摘要连累
    r = await lendRequest(d.v2.call, peer, "beat", { orders: blank(lines) });
  }
  const at = d.now();
  if (!r.ok) return notV2(r) ? { error: LEND_OLD_PEER, old: true } : { error: `${r.code} ${r.error}`.slice(0, 200) };
  const sent = new Map(items.map((it) => [it.row.orderId, it]));
  const ids = r.value.map((a) => a.orderId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !sent.has(id))) return { error: "应答里有没发过的或重复的单号，整批当没收到" };
  for (const a of r.value) {
    const it = sent.get(a.orderId)!;
    if (it.ended) clearNotify(d, it.row); // A 回了这一行（不管什么 verdict）：收回已告诉它
    else {
      const v = renewalOf(a, it.row, at);
      if (v) renewals.set(a.orderId, v);
    }
  }
  return { error: null };
}

/** 一个 proto 2 peer 这一轮的 beat；对方回 404（旧版）/ 403 messages_only 返回 "old_peer"，调用方当轮切回 v1 逐单续租、补 poll */
export async function beatPeer(d: HelloDeps, peer: string, renewals: Map<string, Renewal>): Promise<"old_peer" | null> {
  const now = d.now();
  const leased = liveOrders(d.db).filter((r) => r.peer === peer && LEASED_STATES.includes(r.state) && (r.leaseGen ?? 0) >= 1);
  const ended = endedRows(d, peer, now);
  if (!leased.length && !ended.length) return null;
  const last = metaJson<{ at: number; error: string | null }>(d.db, beatKey(peer));
  const every = Math.min(EVERY_MS.max, Math.max(EVERY_MS.min, helloState(d.db, peer)?.beatMs ?? EVERY_MS.fallback));
  if (last && now - last.at < every) return null;
  const items: Item[] = [...leased.map((row) => ({ row, ended: false })), ...ended.map((row) => ({ row, ended: true }))];
  const lines: Record<string, unknown>[] = [];
  for (const it of items) lines.push(await lineOf(d, it));
  const st = { blank: false };
  let error: string | null = null;
  for (let i = 0; i < items.length; i += BATCH_MAX) {
    const out = await sendBatch(d, peer, items.slice(i, i + BATCH_MAX), lines.slice(i, i + BATCH_MAX), st, renewals);
    error = out.error ?? error;
    if (out.old) break;
  }
  setMeta(d.db, beatKey(peer), JSON.stringify({ at: now, error }));
  if (error) d.log(`给 ${peer} 的 beat 没全成（${error}），没续上的单截止不动`);
  return error === LEND_OLD_PEER ? "old_peer" : null;
}

/** doctor 用：最近一次 beat 的时刻与错误 */
export function beatView(d: Pick<HelloDeps, "db">, peer: string): string | null {
  const last = metaJson<{ at: number; error: string | null }>(d.db, beatKey(peer));
  return last ? `${new Date(last.at).toISOString().slice(11, 19)}${last.error ? `（${last.error}）` : ""}` : null;
}
