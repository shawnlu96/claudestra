/**
 * 出借单逐状态推进（docs/design/remote-capacity.md §2.3、§6）：lend 循环每轮对 journal 里每张活着的单调一次 driveOrder，按状态做下一步。
 * 规矩：先写 journal 再做外部效果；同一件外部效果重启后只会重做幂等的那几种（claim 同 orderId、result 同原始字节、续租），
 * 建 worker 前先把 agent 名记进 journal，重启后先按名字在 registry 里认领、不建第二个；首条派单「发出前」落 sending，重启后不重发。
 * 租约以本机时钟算截止（claim / 续租成功时的 now + ms）：过了还没续上就自停 worker（心跳过期），保留工作副本和 journal。
 * 依赖全部注入（LendDeps，生产接线在 lend-deps.ts），tests/lend-loop.test.ts 用假依赖逐条走。
 */
import type { Database } from "bun:sqlite";
import { advance, localDay, openSlots, orderOf, ordersToday, patchOrder, LEASED_STATES, type LendRow, type LendState } from "./lend-journal.js";
import type { LendEntry } from "./lend-config.js";
import type { LendAskParams, LendAskVerdict } from "./lend-ask.js";
import { lendRequest, type LendCall, type Lease, type Receipt } from "./lend-remote.js";
import type { CloneResult } from "./lend-clone.js";
import type { SendResult } from "./worker-ports.js";
import { payloadSha } from "./lend-submit.js";
import { createHash } from "node:crypto";

export const BEAT_MS = 60_000;
/** 首条派单后一直没交结论的上限：外来任务不能无限期占着 B 的一个 shell */
const MAX_RUN_MS = 3 * 3600_000;

interface WorkerPort {
  /** registry 里这个名字的 agent（会话 id、工作目录）；没有 = undefined */
  find(name: string): { sessionId?: string; cwd?: string } | undefined;
  create(name: string, dir: string, purpose: string): Promise<{ ok: true } | { ok: false; error: string }>;
  send(name: string, sessionId: string, text: string, key: string): Promise<SendResult>;
  /** 结束 worker 并确认窗口已不在；ok:false = 没确认退出（调用方保留现场） */
  kill(name: string): Promise<{ ok: boolean; reason?: string }>;
  /** worker 还在不在跑（窗口在、且窗口里有子进程）；null = 查不到（按还在算） */
  alive(name: string): Promise<boolean | null>;
}

export interface LendDeps {
  db: Database;
  now: () => number;
  call: LendCall;
  /** 开 / 核逐单确认 ask（lend-ask.ts；开经 `ledger lend-ask`，核读台账）；inform = 预先授权期间的每单通知（`ledger lend-inform`） */
  ask: {
    open(p: LendAskParams): Promise<{ ok: true; askId: string } | { ok: false; error: string }>;
    verdict(askId: string, p: LendAskParams): LendAskVerdict;
    inform(p: LendAskParams): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  clone(input: { orderId: string; repo: string; pr: number | null; head: string }): Promise<CloneResult>;
  removeDir(orderId: string): void;
  worker: WorkerPort;
  /** 回执验签：A 钉在 peers.json 的完整公钥；验不过 = false */
  verifyReceipt(peer: string, r: Receipt): Promise<boolean>;
  writeReceipt(row: LendRow): Promise<void>;
  /** worker 的首条派单尾注（怎么交结论） */
  footer(row: LendRow): string;
  log(msg: string): void;
}

export const workerName = (orderId: string): string => `agent-lend-${createHash("sha256").update(orderId).digest("hex").slice(0, 10)}`;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** lease release 的 detail：单行、≤ 500 字节（T93 wire），空 = null；按字节截，不切断多字节字符 */
export function detailOf(s: string | null): string | null {
  let t = (s ?? "").replace(/[\p{Cc}\s\u2028\u2029]+/gu, " ").trim();
  while (Buffer.byteLength(t) > 500) t = [...t].slice(0, -1).join("");
  return t || null;
}
const leaseFields = (l: Lease, now: number) => ({ leaseGen: l.gen, leaseUntil: now + l.ms, lastBeatAt: now });

/** A 回这几个码 = 这张单在 A 那边已经不归我们了：停 worker，按码记终态 */
const GONE: Record<string, "cancelled" | "stopped"> = { cancelled: "cancelled", lease_expired: "stopped", stale_gen: "stopped", not_found: "stopped", conflict: "cancelled" };

export function askParams(row: LendRow, entry: LendEntry, d: LendDeps): LendAskParams {
  const p = row.preview;
  const fam = entry.families[row.family as "codex"] ?? 0;
  const fresh = `今天第 ${ordersToday(d.db, row.peer, d.now()) + 1}/${entry.quota.ordersPerDay} 单，${row.family} 位 ${openSlots(d.db, row.peer, row.family)}/${fam}`;
  return {
    orderId: row.orderId, peer: row.peer, fp: row.fp, family: row.family, repo: str(p.repo), pr: typeof p.pr === "number" ? p.pr : null, head: str(p.head),
    taskId: str(p.taskId), step: str(p.step),
    quota: entry.confirm === "auto" ? `${fresh}，预先授权到 ${entry.until ?? "?"}` : typeof p.askQuota === "string" ? p.askQuota : fresh,
  };
}

/** 这张还没 claim 的单现在还能不能领：声明仍在、仓库仍在白名单、今日额度与在跑位都还有 */
export function claimProblem(row: LendRow, entry: LendEntry | undefined, db: Database, now: number): string | null {
  if (!entry) return `已不再向 ${row.peer} 出借（lend.json 关了或删了这条）`;
  if (!entry.repos.includes(str(row.preview.repo))) return `仓库 ${str(row.preview.repo)} 已不在白名单`;
  const slots = entry.families[row.family as "codex"] ?? 0;
  const busy = db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND state IN (${LEASED_STATES.map(() => "?").join(",")})`)
    .get(row.peer, row.family, ...LEASED_STATES) as { n: number };
  if (busy.n >= slots) return "wait";
  if (ordersToday(db, row.peer, now) >= entry.quota.ordersPerDay) return "wait";
  return null;
}

export async function claimOrder(row: LendRow, d: LendDeps): Promise<void> {
  const r = await lendRequest(d.call, row.peer, "claim", { orderId: row.orderId, worker: workerName(row.orderId) });
  const now = d.now();
  if (!r.ok) {
    if (r.code === "transport" || r.code === "bad_response" || r.code === "max_open") return d.log(`claim ${row.orderId} 暂未成功（${r.code}），下轮再试`);
    advance(d.db, row.orderId, "asked", "declined", { reason: `A 拒绝领单：${r.code} ${r.error}` }, now);
    return;
  }
  const o = r.value.order;
  const p = row.preview;
  const mismatch = o.orderId !== row.orderId ? "orderId" : (o.head ?? "").toLowerCase() !== str(p.head) ? "head" : o.repo !== p.repo ? "repo"
    : o.pr !== (p.pr ?? null) ? "pr" : o.step !== "review" ? "step" : null;
  const claimed = advance(d.db, row.orderId, "asked", "claimed",
    { wire: { order: o as unknown as Record<string, unknown>, text: r.value.text }, day: localDay(now), ...leaseFields(r.value.lease, now) }, now);
  if (mismatch) await release(claimed, "claimed", `完整订单的 ${mismatch} 与挂单摘要不一致`, d);
}

/** 没起过 worker 就退回：先记 released 再告诉 A（not_started）；告诉失败不重试，A 那边租约到期会停给 PM */
async function release(row: LendRow, from: LendState, why: string, d: LendDeps): Promise<void> {
  const done = advance(d.db, row.orderId, from, "released", { reason: why }, d.now());
  const r = await lendRequest(d.call, row.peer, "lease", { orderId: row.orderId, gen: row.leaseGen, action: "release", reason: "not_started", detail: detailOf(why) });
  if (!r.ok) d.log(`释放 ${row.orderId}（not_started）没送到 A：${r.code}`);
  try { d.removeDir(row.orderId); } catch (e) { d.log(`删 ${row.orderId} 的工作目录失败：${(e as Error).message}`); }
  await d.writeReceipt(done);
}

/**
 * worker 已起过的单收尾：先停 worker，确认窗口没了才记终态、写收据；没确认退出就什么都不记，下一轮再停（单仍算活着，
 * 续租 / 自停照常，doctor 看得见），绝不留一个没人管的 worker。只有 acked / cancelled 才删工作副本，stopped 保留现场。
 * notify = 要不要告诉 A 我们停了（release stopped）；A 已经判过期 / 撤单的就不再说。
 */
async function finish(row: LendRow, to: "acked" | "stopped" | "cancelled", why: string | null, d: LendDeps, notify: boolean,
  extra: Partial<Pick<LendRow, "receipt">> = {}): Promise<void> {
  const killed = row.agent ? await d.worker.kill(row.agent) : { ok: true };
  if (!killed.ok) return d.log(`${row.orderId} 要收尾（${to}：${why ?? ""}），但 ${row.agent} 没确认退出（${killed.reason ?? "原因不明"}），下轮再停`);
  const done = advance(d.db, row.orderId, row.state, to, { reason: why, ...extra }, d.now());
  if (notify && to === "stopped") {
    const r = await lendRequest(d.call, row.peer, "lease", { orderId: row.orderId, gen: row.leaseGen, action: "release", reason: "stopped", detail: detailOf(why) });
    if (!r.ok) d.log(`告诉 A ${row.orderId} 已停没送到：${r.code}`);
  }
  if (to === "acked" || to === "cancelled") {
    try { d.removeDir(row.orderId); } catch (e) { d.log(`删 ${row.orderId} 的工作目录失败：${(e as Error).message}`); }
  }
  await d.writeReceipt(done);
}

async function startWorker(row: LendRow, d: LendDeps): Promise<void> {
  const name = row.agent ?? workerName(row.orderId);
  if (!row.agent) row = patchOrder(d.db, row.orderId, ["cloned"], { agent: name }, d.now()); // 先记名字：重启后按名字认领，不建第二个
  let found = d.worker.find(name);
  if (!found) {
    const o = orderOf(row);
    const made = await d.worker.create(name, row.dir!, `出借：${row.peer} 的 ${str(o?.taskId)} ${str(o?.step)}（${row.orderId}）`);
    found = d.worker.find(name);
    if (!found && !made.ok) return release(row, "cloned", `起 worker 失败：${made.error}`.slice(0, 400), d);
  }
  if (!found?.sessionId) return d.log(`${name} 已在 registry，还没有会话 id，下轮再看`);
  if (found.cwd && found.cwd !== row.dir) return finish(row, "stopped", `${name} 的工作目录 ${found.cwd} 不是这张单的工作副本`, d, true);
  advance(d.db, row.orderId, "cloned", "started", { sessionId: found.sessionId, startedAt: d.now() }, d.now());
}

async function submitOrder(row: LendRow, d: LendDeps): Promise<void> {
  const text = `${row.wire!.text}\n\n${d.footer(row)}`;
  row = patchOrder(d.db, row.orderId, ["started"], { submit: "sending" }, d.now());
  const r = await d.worker.send(row.agent!, row.sessionId!, text, row.orderId);
  if (r.ok) patchOrder(d.db, row.orderId, ["started"], { submit: "sent" }, d.now());
  else if (r.delivered === false) patchOrder(d.db, row.orderId, ["started"], { submit: null, reason: `首条派单没送到：${r.reason}`.slice(0, 300) }, d.now());
  else d.log(`${row.orderId} 首条派单是否送到不明（${r.reason}），不重发`);
}

async function forwardResult(row: LendRow, d: LendDeps): Promise<void> {
  const raw = JSON.stringify(row.payload);
  if (payloadSha(raw) !== row.payloadSha) return finish(row, "stopped", "journal 里的结论和记下的 sha256 对不上，不发", d, true);
  const { v: _v, ...body } = row.payload as Record<string, unknown>;
  const r = await lendRequest(d.call, row.peer, "result", body);
  if (!r.ok) {
    if (r.code === "transport" || r.code === "bad_response") return d.log(`转发 ${row.orderId} 的结论暂未成功（${r.code}），下轮原样重发`);
    const gone = GONE[r.code];
    return finish(row, gone ?? "stopped", `A 不收结论：${r.code} ${r.error}`, d, !gone);
  }
  const rc = r.value;
  const o = orderOf(row);
  const bad = rc.orderId !== row.orderId ? "orderId" : rc.sha256 !== row.payloadSha ? "sha256" : rc.taskId !== str(o?.taskId) ? "taskId" : null;
  if (bad || !(await d.verifyReceipt(row.peer, rc))) return finish(row, "stopped", `A 的回执${bad ? `的 ${bad} 对不上` : "验签没过"}，不算入账`, d, false);
  await finish(row, "acked", null, d, false, { receipt: rc as unknown as Record<string, unknown> });
}

/**
 * 续租；到点才续。A 说单已不归我们 → 停；本机截止已过还没续上 → 自停（心跳过期）。
 * result_pending 例外：结论已落本地，A 可能已经入账、只是回执丢了（A 的 result 按同一 sha256 回旧回执，不看租约）。
 * 这时只停 worker，单留给 forwardResult 原字节重发取回执；A 明确拒收才按码收尾。
 */
async function heartbeat(row: LendRow, d: LendDeps): Promise<LendRow | null> {
  const now = d.now();
  if (row.lastBeatAt === null || now - row.lastBeatAt >= BEAT_MS) {
    const r = await lendRequest(d.call, row.peer, "lease", { orderId: row.orderId, gen: row.leaseGen, action: "renew", reason: null, detail: null });
    const at = d.now();
    if (r.ok && r.value) return patchOrder(d.db, row.orderId, [row.state], leaseFields(r.value, at), at);
    if (!r.ok && GONE[r.code] && row.state === "result_pending") return stopForResult(row, `续租被拒：${r.code}`, d);
    if (!r.ok && GONE[r.code] && r.code !== "conflict") {
      await finish(row, GONE[r.code], `续租被拒：${r.code}（${r.error}）`, d, false);
      return null;
    }
    if (!r.ok) d.log(`${row.orderId} 续租失败（${r.code}）`);
  }
  if (row.leaseUntil !== null && d.now() >= row.leaseUntil) {
    if (row.state === "result_pending") return stopForResult(row, "心跳过期", d);
    await finish(row, "stopped", "心跳过期：租约截止前没续上，自停 worker（保留工作副本与 journal）", d, false);
    return null;
  }
  return row;
}

/** result_pending 失了租约：worker 一定停（没确认退出就记日志，下一轮再停；已不在跑就不再每轮调 kill），单照常往下转发结论 */
async function stopForResult(row: LendRow, why: string, d: LendDeps): Promise<LendRow> {
  const killed = row.agent && (await d.worker.alive(row.agent)) !== false ? await d.worker.kill(row.agent) : { ok: true };
  if (!killed.ok) d.log(`${row.orderId} ${why}：${row.agent} 没确认退出（${killed.reason ?? "原因不明"}），下轮再停；结论照常重发取回执`);
  return row;
}

/** 已 claim 的单推一步；asked 由 lend-loop 处理（要看声明和 ask） */
export async function driveLeased(row: LendRow, d: LendDeps): Promise<void> {
  const cur = await heartbeat(row, d);
  if (!cur) return;
  const o = orderOf(cur);
  if (cur.state === "claimed") {
    const got = await d.clone({ orderId: cur.orderId, repo: str(o?.repo), pr: typeof o?.pr === "number" ? o.pr : null, head: str(o?.head) });
    if (!got.ok) return release(cur, "claimed", got.reason, d);
    advance(d.db, cur.orderId, "claimed", "cloned", { dir: got.dir }, d.now());
  } else if (cur.state === "cloned") {
    await startWorker(cur, d);
  } else if (cur.state === "started") {
    if (cur.submit === null) return submitOrder(cur, d);
    if ((await d.worker.alive(cur.agent!)) === false) return finish(cur, "stopped", "worker 窗口没了，没交结论", d, true);
    if (d.now() - (cur.startedAt ?? cur.createdAt) > MAX_RUN_MS) return finish(cur, "stopped", `超过 ${MAX_RUN_MS / 3600_000} 小时没交结论`, d, true);
  } else if (cur.state === "result_pending") {
    await forwardResult(cur, d);
  }
}
