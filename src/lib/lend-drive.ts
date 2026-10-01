/**
 * 出借单逐状态推进（docs/design/remote-capacity.md §2.3、§6）：lend 循环每轮对 journal 里每张活着的单调一次 driveOrder，按状态做下一步。
 * 规矩：先写 journal 再做外部效果；同一件外部效果重启后只会重做幂等的那几种（claim 同 orderId、result 同原始字节、续租），
 * 建 worker 前先把 agent 名记进 journal，重启后先按名字在 registry 里认领、不建第二个；首条派单「发出前」落 sending，重启后不重发。
 * 租约以本机时钟算截止（claim / 续租成功时的 now + ms）：过了还没续上就自停 worker（心跳过期），保留工作副本和 journal。
 * 写单（i28-R6）：领单要出借声明开了 write、订单分支正是按本机指纹算的那个；clone 后先试推，没权限就退回（not_started）；
 * worker 交了 head 之后由这里推送、开 PR（lend-push.ts），再把交付原字节转给 A——推送失败可重试的留到下一轮，别的停下交 PM。
 * 依赖全部注入（LendDeps，生产接线在 lend-deps.ts），tests/lend-loop.test.ts 用假依赖逐条走。
 */
import type { Database } from "bun:sqlite";
import { advance, localDay, orderOf, ordersToday, patchOrder, LEASED_STATES, type LendRow, type LendState } from "./lend-journal.js";
import { claudeLendSlots } from "./lend-claude-worker-capacity.js";
import type { LendEntry, LendRead } from "./lend-config.js";
import type { LendContact } from "./lend-policy.js";
import type { ProjectDef } from "./projects.js";
import { liveGrant, REVOKED } from "./lend-grant.js";
import { endNotice, ensureStartNotice, flushEndNotice, type LendNoticeParams } from "./lend-notice.js";
import { lendRequest, type LendCall, type Lease, type LendRes, type Receipt } from "./lend-remote.js";
import type { CloneResult, CloneWrite } from "./lend-clone.js";
import { isWriteStep, lendBranch, roleOfStep } from "./lend-git.js";
import type { PrInput, PrResult, PushResult, PushTarget } from "./lend-push.js";
import type { SendResult } from "./worker-ports.js";
import { payloadSha } from "./lend-submit.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { DOWN_REASON, failureReason, noteLiveness, pausedUntil, pauseForQuota, type CodexFailureSeen, type QuotaView } from "./lend-health.js";
import type { WorkerLiveness } from "./worker-liveness.js";
import { createHash } from "node:crypto";
import { clearPublishFail, notePublishFail, PUBLISH_GIVE_UP_MS } from "./lend-pr-takeover-retry.js";

export const BEAT_MS = 60_000;
/** 首条派单后一直没交结论的上限：外来任务不能无限期占着 B 的一个 shell（写代码比审查给得长些） */
const MAX_RUN_MS = 3 * 3600_000;
const MAX_WRITE_RUN_MS = 6 * 3600_000;
/** 交付正文（lend wire 的请求体）上限，同 T93 */
const BODY_MAX_BYTES = 96 * 1024;

interface WorkerPort {
  /** registry 里这个名字的 agent（会话 id、工作目录）；没有 = undefined */
  find(name: string): { sessionId?: string; cwd?: string } | undefined;
  /**
   * gate：准备工作做完、调 manager create 之前再核一次（提前拦）；返回原因 = 授权没了，不起。order 带给 manager create，
   * 它在登记占位之后、起窗口之前按这张单现核（lend-grant-spawn.ts），收回一侧由 lend revoke 当场停掉已登记的
   */
  create(name: string, dir: string, purpose: string, gate: () => Promise<string | null>, order: string): Promise<{ ok: true } | { ok: false; error: string }>;
  send(name: string, sessionId: string, text: string, key: string): Promise<SendResult>;
  /** 结束 worker 并确认窗口已不在；ok:false = 没确认退出（调用方保留现场） */
  kill(name: string): Promise<{ ok: boolean; reason?: string }>;
  /** worker 还在不在跑（以 ACP 宿主进程为准，worker-liveness.ts）；unknown = 读不到，不能当成不在 */
  alive(name: string): Promise<WorkerLiveness>;
}

export interface LendDeps {
  db: Database;
  now: () => number;
  call: LendCall;
  /** lend.json 与联系人：每个核对点现读（lend-grant.ts liveGrant） */
  readLend(): Promise<LendRead>;
  context(): Promise<{ contacts: LendContact[]; projects: ProjectDef[] }>;
  /** 给出借方 owner 的开跑 / 交付 / 停止通知（`ledger lend-inform`，lend-notice.ts）；ok = bridge 收下了 */
  notify(p: LendNoticeParams): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 关一张升级前的逐单确认 ask（`ledger lend-ask --retire`） */
  retireAsk(askId: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 只给测试切换写单开关；生产不设 = lend-grant-rules.ts WRITE_ROLE_OPEN */
  writeOpen?: boolean;
  clone(input: { orderId: string; repo: string; pr: number | null; head: string; write?: CloneWrite }): Promise<CloneResult>;
  /** 本机实例公钥的指纹：写单的订单分支按它核；读不到钥匙 = null（不领写单） */
  selfFp(): string | null;
  /** 写单副本里提交用的署名（出借人自己的 git 全局身份）；没配 = null，写单不起 worker */
  identity(): { name: string; email: string } | null;
  /** 写单的试推 / 推送 / 开 PR（lend-push.ts） */
  push: {
    probe(t: PushTarget): Promise<PushResult>;
    work(t: PushTarget & { head: string }): Promise<PushResult>;
    pr(p: PrInput): Promise<PrResult>;
  };
  removeDir(orderId: string): void;
  worker: WorkerPort;
  /** 回执验签：A 钉在 peers.json 的完整公钥；验不过 = false */
  verifyReceipt(peer: string, r: Receipt): Promise<boolean>;
  writeReceipt(row: LendRow): Promise<void>;
  /** worker 的首条派单尾注（怎么交结论） */
  footer(row: LendRow): string;
  /** bridge 为这个 worker 开着的 Codex 额度 / 登录卡（lend-health.ts）；没有 = undefined */
  failure(agent: string): CodexFailureSeen | undefined;
  /** 关掉这个 worker 开出的 Codex 运行时卡（`ledger lend-close-asks`）；单结束收尾时调 */
  closeAsks(agent: string): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 本机 Codex 额度（撞额度暂停借单用）；读不到 = null */
  codexQuota(): Promise<QuotaView | null>;
  log(msg: string): void;
  /** proto 2 只认这轮 beat 的应答（lend-beat.ts，at = 收到的时刻）：null = 这轮没续上，截止不动；不设 / undefined = proto 1 逐单 lease renew */
  renewal?(row: LendRow): { res: LendRes<Lease | null>; at: number } | null | undefined;
  /** true = 这轮先不发这张单的结束通知（不联网阶段、这个 peer 本轮出站已失败、proto 2 的收回停单改在 beat 里带 ended）：不算发过，标记留着 */
  settleHold?(row: LendRow): boolean;
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
const GONE: Record<string, "cancelled" | "stopped"> = { cancelled: "cancelled", lease_expired: "stopped", stale_gen: "stopped", not_found: "stopped", conflict: "cancelled",
  done: "stopped" };

/** 这张还没 claim 的单现在还能不能领：声明仍在、仓库仍在白名单、今日额度与在跑位都还有 */
export function claimProblem(row: LendRow, entry: LendEntry | undefined, db: Database, now: number): string | null {
  if (!entry) return `已不再向 ${row.peer} 出借（lend.json 关了或删了这条）`;
  if (!entry.repos.includes(str(row.preview.repo))) return `仓库 ${str(row.preview.repo)} 已不在白名单`;
  const role = roleOfStep(str(row.preview.step));
  if (!role || !entry.roles.includes(role)) return `出借声明没开 ${role ?? str(row.preview.step)} 角色，不领这一单`;
  const slots = row.family === "claude" ? claudeLendSlots(entry) : row.family === "codex" ? entry.families.codex ?? 0 : 0;
  const busy = db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND state IN (${LEASED_STATES.map(() => "?").join(",")})`)
    .get(row.peer, row.family, ...LEASED_STATES) as { n: number };
  if (busy.n >= slots) return "wait";
  if (ordersToday(db, row.peer, now) >= entry.ordersPerDay) return "wait";
  if (row.family === "codex" && pausedUntil(db, now) !== null) return "wait"; // 本机 Codex 撞额度暂停中：批了也先不领
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
  const w = r.value.write;
  const mismatch = o.orderId !== row.orderId ? "orderId" : (o.head ?? "").toLowerCase() !== str(p.head) ? "head" : o.repo !== p.repo ? "repo"
    : o.pr !== (p.pr ?? null) ? "pr" : o.step !== p.step ? "step" : o.taskId !== p.taskId ? "taskId" : writeMismatch(o.step, o.taskId, w, d);
  const claimed = advance(d.db, row.orderId, "asked", "claimed",
    { wire: { order: o as unknown as Record<string, unknown>, text: r.value.text, ...(w ? { write: w } : {}) }, day: localDay(now), ...leaseFields(r.value.lease, now) }, now);
  if (mismatch) await release(claimed, "claimed", `完整订单的 ${mismatch} 与挂单摘要不一致`, d);
}

/** 写单必须带订单分支，且它正是 lend/<任务>-<本机指纹前 4 位>：A 给别的分支名（比如 main）一律不领；审查单不许带 */
function writeMismatch(step: string, taskId: string, w: { branch: string } | null, d: LendDeps): string | null {
  if (!isWriteStep(step)) return w ? "write" : null;
  const fp = d.selfFp();
  return !w ? "write" : !fp || lendBranch(taskId, fp) !== w.branch ? "branch" : null;
}

/** 没起过 worker 就退回：记 released（连同要补做的收尾），再告诉 A（not_started）、删目录、写收据 */
async function release(row: LendRow, from: LendState, why: string, d: LendDeps): Promise<void> {
  await settleOrder(advance(d.db, row.orderId, from, "released", { reason: why, settle: { notify: "not_started", removeDir: true }, ...endNotice(row, "released", why) }, d.now()), d);
}

/**
 * 终态之后的外部效果，按 journal 里的 settle 逐项做、做一项清一项；lend 循环每轮对还没清完的单再调一次（进程在中间退出、收据写盘失败都能补上）。
 * 告诉 A 只试一次：发了就清标记，送没送到都不再发（A 那边租约到期会停给 PM）；进程在清标记之前退出会重发一次，A 对已释放的单回错，无害。
 */
export async function settleOrder(row: LendRow, d: LendDeps): Promise<void> {
  const s = row.settle;
  if (!s || (s.notify && d.settleHold?.(row))) return;
  clearPublishFail(d.db, row.orderId); // 单结束了，发布失败的记账一并清掉（幂等）
  if (s.notify) {
    const r = await lendRequest(d.call, row.peer, "lease", { orderId: row.orderId, gen: row.leaseGen, action: "release", reason: s.notify, detail: detailOf(row.reason) });
    if (!r.ok) d.log(`告诉 A ${row.orderId} 已${s.notify === "stopped" ? "停" : "退回（not_started）"}没送到：${r.code}`);
    row = patchOrder(d.db, row.orderId, [row.state], { settle: { ...s, notify: null } }, d.now());
  }
  if (row.settle!.removeDir) {
    try { d.removeDir(row.orderId); } catch (e) {
      if (e instanceof SchedulerStopped) throw e; // 失租 / 停止不是删失败：不往下清标记、写收据
      d.log(`删 ${row.orderId} 的工作目录失败：${(e as Error).message}`);
    }
    row = patchOrder(d.db, row.orderId, [row.state], { settle: { notify: null, removeDir: false } }, d.now());
  }
  if (row.agent) {
    const closed = await d.closeAsks(row.agent); // 这个 worker 开出的额度 / 登录卡：单结束了，卡也结掉
    if (!closed.ok) throw new Error(`关 ${row.agent} 的 Codex 卡失败：${closed.error}`); // 留着 settle，下一轮再关
  }
  const told = await flushEndNotice(row, d);
  if (!told) return; // 交付 / 停止通知没交出去：留着 settle，下一轮补发
  await d.writeReceipt(told); // 抛了就留着 settle，下一轮再写（appendReceipt 同 orderId 只写一行）
  patchOrder(d.db, row.orderId, [row.state], { settle: null }, d.now());
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
  const settle = { notify: notify && to === "stopped" ? ("stopped" as const) : null, removeDir: to === "acked" || to === "cancelled" };
  await settleOrder(advance(d.db, row.orderId, row.state, to, { reason: why, ...extra, settle, ...endNotice(row, to, why) }, d.now()), d);
}

async function startWorker(row: LendRow, entry: LendEntry, d: LendDeps): Promise<void> {
  const name = row.agent ?? workerName(row.orderId);
  if (!row.agent) row = patchOrder(d.db, row.orderId, ["cloned"], { agent: name }, d.now()); // 先记名字：重启后按名字认领，不建第二个
  let found = d.worker.find(name);
  if (!found) {
    const told = await ensureStartNotice(row, entry, d);
    if (!told || !(await stillGranted(told, d))) return; // 通知要先交出去；通知那一下的工夫里收回了也不起
    const o = orderOf(row);
    let denied: string | null = null;
    const gate = async () => { const g = await liveGrant(told, d); return (denied = g.ok ? null : g.problem); };
    const made = await d.worker.create(name, row.dir!, `出借：${row.peer} 的 ${str(o?.taskId)} ${str(o?.step)}（${row.orderId}）`, gate, row.orderId);
    found = d.worker.find(name);
    if (!made.ok && (denied ?? (await gate()))) return void (await revoke(told, denied!, d)); // 子进程那道核对拦下的也按收回收尾
    if (!found && !made.ok) return release(row, "cloned", `起 worker 失败：${made.error}`.slice(0, 400), d);
  }
  if (!found?.sessionId) return d.log(`${name} 已在 registry，还没有会话 id，下轮再看`);
  if (found.cwd && found.cwd !== row.dir) return finish(row, "stopped", `${name} 的工作目录 ${found.cwd} 不是这张单的工作副本`, d, true);
  advance(d.db, row.orderId, "cloned", "started", { sessionId: found.sessionId, startedAt: d.now() }, d.now());
}

async function submitOrder(row: LendRow, d: LendDeps): Promise<void> {
  if (!(await stillGranted(row, d))) return;
  const text = `${row.wire!.text}\n\n${d.footer(row)}`;
  row = patchOrder(d.db, row.orderId, ["started"], { submit: "sending" }, d.now());
  const r = await d.worker.send(row.agent!, row.sessionId!, text, row.orderId);
  if (r.ok) patchOrder(d.db, row.orderId, ["started"], { submit: "sent" }, d.now());
  else if (r.delivered === false) patchOrder(d.db, row.orderId, ["started"], { submit: null, reason: `首条派单没送到：${r.reason}`.slice(0, 300) }, d.now());
  else d.log(`${row.orderId} 首条派单是否送到不明（${r.reason}），不重发`);
}

/** 写单的推送目标：订单分支、基线、工作副本、起点——全部来自 claim 时落的 journal，不看 worker 说什么 */
function pushTarget(row: LendRow): PushTarget {
  const o = orderOf(row);
  const w = row.wire!.write!;
  return { orderId: row.orderId, repo: str(o?.repo), branch: w.branch, base: w.base, cloneDir: row.dir ?? "", orderHead: str(o?.head) };
}

/**
 * 写单交活之后：推送 → 开 / 沿用 PR → 拼好交付正文落 journal（之后原字节重发）。推送 / PR 可重试的失败留到下一轮（都幂等：
 * 同一 head 再推是空操作，PR 先查同分支再开），原因进心跳摘要，连续 30 分钟不成就停（lend-pr-takeover-retry.ts）；
 * 不可重试的（没权限、远端被别人推过、head 不对）停下、告诉 A，交 PM。
 */
async function publishWork(row: LendRow, d: LendDeps): Promise<LendRow | null> {
  const o = orderOf(row);
  const t = pushTarget(row);
  const work = row.work!;
  const stop = async (r: { reason: string; retry: boolean }) => {
    const f = r.retry ? notePublishFail(d.db, row.orderId, r.reason, d.now()) : null; // 原因进心跳摘要；连续失败超时按不可重试停
    if (f && d.now() - f.since < PUBLISH_GIVE_UP_MS) return void d.log(`${row.orderId} 推送 / 开 PR 暂未成功（${r.reason}），下轮再试`);
    await finish(row, "stopped", f ? `推送 / 开 PR 连续 ${PUBLISH_GIVE_UP_MS / 60_000} 分钟没成功，停单：${r.reason}` : r.reason, d, true);
  };
  const pushed = await d.push.work({ ...t, head: work.head });
  if (!pushed.ok) return (await stop(pushed), null);
  const round = typeof o?.round === "number" ? o.round : 0;
  const body = [`出借 worker（出借方的一次性 agent）提交，台账 ${str(o?.taskId)} 第 ${round} 轮，单号 ${row.orderId}。`, "", "## 摘要", "", work.summary, "",
    "## 自查", "", work.selfCheck, ""].join("\n");
  const pr = await d.push.pr({ orderId: row.orderId, repo: t.repo, branch: t.branch, base: t.base, pr: typeof o?.pr === "number" ? o.pr : null,
    title: `${str(o?.taskId)}：出借${o?.step === "fix" ? "修复" : "实现"}（第 ${round} 轮）`, body });
  if (!pr.ok) return (await stop(pr), null);
  const payload = { v: 1, orderId: row.orderId, gen: row.leaseGen,
    deliver: { v: 1, orderId: row.orderId, head: work.head, evidence: pr.pr ? `https://github.com/${t.repo}/pull/${pr.pr}` : t.branch, summary: work.summary,
      selfCheck: work.selfCheck },
    branch: t.branch, pr: pr.pr, session: { id: row.sessionId, family: row.family } };
  const raw = JSON.stringify(payload);
  if (Buffer.byteLength(raw) > BODY_MAX_BYTES) return (await stop({ reason: `交付正文超过 ${BODY_MAX_BYTES} 字节`, retry: false }), null);
  clearPublishFail(d.db, row.orderId);
  return patchOrder(d.db, row.orderId, ["result_pending"], { payload, payloadSha: payloadSha(raw) }, d.now());
}

async function forwardResult(row: LendRow, d: LendDeps): Promise<void> {
  if (row.work && !row.payload) {
    const published = await publishWork(row, d);
    if (!published) return;
    row = published;
  }
  const raw = JSON.stringify(row.payload);
  if (payloadSha(raw) !== row.payloadSha) return finish(row, "stopped", "journal 里的结论和记下的 sha256 对不上，不发", d, true);
  const { v: _v, ...body } = row.payload as Record<string, unknown>;
  const r = await lendRequest(d.call, row.peer, "result", body);
  if (!r.ok) {
    if (r.code === "transport" || r.code === "bad_response" || r.code === "unavailable") return d.log(`转发 ${row.orderId} 的结论暂未成功（${r.code}），下轮原样重发`);
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
 * result_pending 且交付正文已生成的例外：A 可能已经入账、只是回执丢了（A 的 result 按同一 sha256 回旧回执，不看租约）。
 * 这时只停 worker，单留给 forwardResult 原字节重发取回执；A 明确拒收才按码收尾。写单的提交还没推送（没有正文）不算例外：
 * 失了租约就收尾，不再推送、开 PR（撤单 / 收回之后远端不能再多出副作用）。tests/lend-write.test.ts。
 */
async function heartbeat(row: LendRow, d: LendDeps): Promise<LendRow | null> {
  const now = d.now();
  const awaitingReceipt = row.state === "result_pending" && row.payload !== null;
  const beat = d.renewal?.(row);
  if (beat !== undefined ? beat !== null : row.lastBeatAt === null || now - row.lastBeatAt >= BEAT_MS) {
    const r = beat ? beat.res : await lendRequest(d.call, row.peer, "lease", { orderId: row.orderId, gen: row.leaseGen, action: "renew", reason: null, detail: null });
    const at = beat ? beat.at : d.now();
    if (r.ok && r.value) return patchOrder(d.db, row.orderId, [row.state], leaseFields(r.value, at), at);
    if (!r.ok && GONE[r.code] && awaitingReceipt) return stopForResult(row, `续租被拒：${r.code}`, d);
    if (!r.ok && GONE[r.code] && r.code !== "conflict") {
      await finish(row, GONE[r.code], `续租被拒：${r.code}（${r.error}）`, d, false);
      return null;
    }
    if (!r.ok) d.log(`${row.orderId} 续租失败（${r.code}）`);
  }
  if (row.leaseUntil !== null && d.now() >= row.leaseUntil) {
    if (awaitingReceipt) return stopForResult(row, "心跳过期", d);
    await finish(row, "stopped", "心跳过期：租约截止前没续上，自停 worker（保留工作副本与 journal）", d, false);
    return null;
  }
  return row;
}

/** result_pending 失了租约：worker 一定停（没确认退出就记日志，下一轮再停；已不在跑就不再每轮调 kill），单照常往下转发结论 */
async function stopForResult(row: LendRow, why: string, d: LendDeps): Promise<LendRow> {
  const killed = row.agent && (await d.worker.alive(row.agent)) !== "no_window" ? await d.worker.kill(row.agent) : { ok: true };
  if (!killed.ok) d.log(`${row.orderId} ${why}：${row.agent} 没确认退出（${killed.reason ?? "原因不明"}），下轮再停；结论照常重发取回执`);
  return row;
}

/**
 * 授权没了（收回 / 过期 / 失效 / 范围收窄，§2.5 的表）：没起 worker 的退回 not_started；在跑的 kill 并确认退出记 stopped（没确认就下一轮再停）；
 * 结论已落成交付正文的只停 worker，返回行让调用方照常转交。写单的提交还没推送也按停处理：收回之后远端不能再多出副作用。
 */
export async function revoke(row: LendRow, problem: string, d: LendDeps): Promise<LendRow | null> {
  const why = `${REVOKED}：${problem}`;
  // cloned 已记了 agent：上次可能建出了 worker 才中断（还没记 started），按在跑的停，确认退出才收尾
  const made = row.state === "cloned" && row.agent && (d.worker.find(row.agent) || (await d.worker.alive(row.agent)) !== "no_window");
  if (made) return (await finish(row, "stopped", why, d, true), null);
  if (row.state === "claimed" || row.state === "cloned") return (await release(row, row.state, why, d), null);
  if (row.state === "started" || !row.payload) return (await finish(row, "stopped", why, d, true), null);
  return stopForResult(row, why, d);
}

/** 起 worker / 首条派单之前贴着再核一次；没了就按 revoke 收尾，返回 false */
async function stillGranted(row: LendRow, d: LendDeps): Promise<boolean> {
  const g = await liveGrant(row, d);
  return g.ok || (await revoke(row, g.problem, d), false);
}

/** 已 claim 的单推一步；asked 由 lend-loop 处理。先核授权（每次续租之前都核），没了按 revoke 收尾 */
export async function driveLeased(row: LendRow, d: LendDeps): Promise<void> {
  const g = await liveGrant(row, d);
  const kept = g.ok ? row : await revoke(row, g.problem, d);
  const cur = kept && (await heartbeat(kept, d));
  if (!cur) return;
  const o = orderOf(cur);
  if (cur.state === "claimed") {
    const w = cur.wire?.write;
    const who = w ? d.identity() : null;
    if (w && !who) return release(cur, "claimed", "出借人机器没配 git 全局 user.name / user.email：写单的提交要署出借人自己的名字，配好再借", d);
    const got = await d.clone({ orderId: cur.orderId, repo: str(o?.repo), pr: typeof o?.pr === "number" ? o.pr : null, head: str(o?.head),
      ...(w && who ? { write: { branch: w.branch, ...who } } : {}) });
    if (!got.ok) return release(cur, "claimed", got.reason, d);
    if (w) {
      // 起 worker 之前先用同一套凭据试推：没权限（fork 路径 v1 只检测）就退回，A 那边写租约结束、卡回本机
      const probe = await d.push.probe({ ...pushTarget({ ...cur, dir: got.dir }), cloneDir: got.dir });
      if (!probe.ok && probe.retry) return d.log(`${cur.orderId} 试推暂未成功（${probe.reason}），下轮重来`);
      if (!probe.ok) return release(cur, "claimed", probe.reason, d);
    }
    advance(d.db, cur.orderId, "claimed", "cloned", { dir: got.dir }, d.now());
  } else if (cur.state === "cloned" && g.ok) {
    await startWorker(cur, g.entry, d);
  } else if (cur.state === "started") {
    // 失败 / 存活 / 运行上限对 started 的每种 submit 都先查：首条派单一直被拒送时 submit 停在 null，
    // 放在派单后面就一轮都查不到，worker 登录失败也照样续租占位（i28-R5a r1 P1-3）
    const failed = cur.family === "codex" ? d.failure(cur.agent!) : undefined;
    if (failed) {
      if (failed.kind === "quota") pauseForQuota(d.db, cur.orderId, await d.codexQuota(), d.now(), d.log);
      d.log(`${cur.orderId} ${failureReason(failed)}（agent ${cur.agent}，session ${cur.sessionId}，gen ${cur.leaseGen}，卡 ${failed.askId}）`);
      return finish(cur, "stopped", failureReason(failed), d, true);
    }
    const down = noteLiveness(d.db, cur, await d.worker.alive(cur.agent!), d.now(), d.log);
    if (down) return finish(cur, "stopped", DOWN_REASON[down], d, true);
    const cap = isWriteStep(str(o?.step)) ? MAX_WRITE_RUN_MS : MAX_RUN_MS;
    if (d.now() - (cur.startedAt ?? cur.createdAt) > cap) return finish(cur, "stopped", `超过 ${cap / 3600_000} 小时没交结论`, d, true);
    if (cur.submit === null) await submitOrder(cur, d);
  } else if (cur.state === "result_pending") {
    await forwardResult(cur, d);
  }
}
