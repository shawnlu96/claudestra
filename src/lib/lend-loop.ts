/**
 * 出借方 B 的 lend 循环一轮（docs/design/remote-capacity.md §2.3）：scheduler 服务的 pass 里、维护租约之内跑。
 * 顺序固定：① 不联网的收回——授权已失效的在跑单先按收回表停掉（该 kill 的 kill 并确认退出），这之前任何出站都不发，挂死的传输挡不住停止；
 * ② 协议 v2（LoopDeps.v2，没设 = 只讲 v1）：hello（lend-hello.ts）、按 peer 批量 beat（lend-beat.ts）；③ 推进 journal 里已有的单（重启恢复就是这一步）；
 * ④ 按 lend.json 对每个出借条目 poll（proto 1 / 未协商 / hello 不新鲜每 30 秒；proto 2 且 10 分钟内收到过这个 A 的推送才降到 5 分钟兜底）。
 * 只认此刻有效的一次授权（lend-grant.ts liveGrant）；收单闸只有 lend-inbox.ts admitOrders 一处（推送与轮询共用）。前提不满足（代理变量、peer 没钉钥 / 没 E2E）不发。
 * 某个 peer 本轮出站失败一次（没拿到应答）就跳过它本轮其余出站，跳过不算发过。每张单、每个 peer 一个 try：除了服务停止 / 失租（SchedulerStopped）
 * 什么错都不抛出 lendTick。tests/lend-loop.test.ts、tests/lend-hello.test.ts、tests/lend-beat.test.ts、tests/lend-compat.test.ts。
 */
import { effectiveLend } from "./lend-policy.js";
import type { LendEntry } from "./lend-config.js";
import { advance, getMeta, liveOrders, ordersToday, patchOrder, setMeta, unsettledOrders, LEASED_STATES, type LendRow } from "./lend-journal.js";
import { claimOrder, claimProblem, driveLeased, revoke, settleOrder, type LendDeps } from "./lend-drive.js";
import { liveGrant, isRevoked } from "./lend-grant.js";
import { admitOrders, LEND_FAMILY, pushKey, TICK_KEY } from "./lend-inbox.js";
import { helloPeer, helloTargets, helloView, metaJson, protoKey, speaksV2, v2Live, type LendRound, type V2Port } from "./lend-hello.js";
import { beatPeer, beatView, type Renewal } from "./lend-beat.js";
import { lendRequest, peerLendProblem, proxyVarsIn, type LendCall } from "./lend-remote.js";
import type { HttpPeer } from "./peers.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { refreshPause } from "./lend-health.js";

export const POLL_MS = 30_000;
/** proto 2、hello 新鲜、而且 PUSH_SEEN_MS 内真收到过这个 A 的推送：轮询只剩兜底 */
const FALLBACK_POLL_MS = 5 * 60_000;
const PUSH_SEEN_MS = 10 * 60_000;
const BOOT_KEY = "loopBoot";

export interface LoopDeps extends LendDeps {
  peers(): Promise<HttpPeer[]>;
  env: Record<string, string | undefined>;
  /** 协议 v2 的出站（hello / beat）与摘要端口；不设 = 只讲 v1（逐单续租、30 秒轮询），行为和 W3 之前逐字一样 */
  v2?: V2Port;
}

/** doctor 读的本轮摘要（journal meta "status"） */
export interface LendStatus {
  at: number;
  lending: boolean;
  /** 整体不 poll 的原因（代理变量 / 文件无效 / 没开）；null = 在 poll */
  blocked: string | null;
  peers: Record<string, {
    problem: string | null; lastPollAt: number | null; lastError: string | null;
    /** v2 视图（有 v2 才有）：协议、最近 hello / beat、最近收到推送的时刻、当前轮询间隔 */
    proto?: string; hello?: string | null; selfCheck?: string | null; beat?: string | null; pushAt?: number | null; pollMs?: number;
  }>;
}

export interface TickResult { failed: { orderId: string; error: string }[] }

type Round = LendRound & { renewals: Map<string, Renewal> };

/**
 * 授权内等 claim 的单。升级前挂着逐单确认 ask 的单先把 ask 关掉（改为一次授权）；没有授权就 declined，原因写清要重新授权。
 * 额度 / 位满了留着（wait），空出来再领。
 */
async function driveAsked(row: LendRow, entry: LendEntry | undefined, d: LoopDeps): Promise<void> {
  if (row.askId && row.preview.askRetired !== true) {
    const r = await d.retireAsk(row.askId);
    if (r.ok) row = patchOrder(d.db, row.orderId, ["asked"], { preview: { ...row.preview, askRetired: true } }, d.now());
    else d.log(`${row.orderId} 关旧的逐单确认 ask ${row.askId} 失败（下轮再关，不挡按授权走）：${r.error}`);
  }
  const now = d.now();
  const stale = entry && entry.fp && row.fp !== entry.fp ? `${row.peer} 的实例指纹变了` : null;
  const problem = stale ?? claimProblem(row, entry, d.db, now);
  const legacy = !entry && row.askId ? "逐单确认已退役，请重新授权；" : "";
  if (problem && problem !== "wait") return void advance(d.db, row.orderId, "asked", "declined", { reason: `${legacy}${problem}` }, now);
  if (problem === "wait") return;
  await claimIfStill(row, d);
}

/**
 * claim 前最后一道：现读 lend.json 按此刻重算（liveGrant），与发出 claim 之间不再有 await。本轮开头的快照不能用：
 * 前面几张单的网络调用都要时间，授权可能在这期间到期或被收回。
 */
async function claimIfStill(row: LendRow, d: LoopDeps): Promise<void> {
  const g = await liveGrant(row, d);
  const problem = g.ok ? claimProblem(row, g.entry, d.db, d.now()) : g.problem;
  if (problem) return d.log(`${row.orderId} 这轮不领：${problem}`);
  await claimOrder(row, d);
}

const busyOf = (d: LoopDeps, peer: string): number => {
  const r = d.db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND state IN (${LEASED_STATES.map(() => "?").join(",")})`)
    .get(peer, LEND_FAMILY, ...LEASED_STATES) as { n: number };
  return r.n;
};

/** poll 的 capacity 正文（v1 冻结的形状，tests/lend-wire-v1-golden.test.ts）：busy 只算占着租约的单 */
function capacityOf(entry: LendEntry, d: LoopDeps) {
  const left = Math.max(0, entry.ordersPerDay - ordersToday(d.db, entry.peer, d.now()));
  return { families: { [LEND_FAMILY]: entry.families[LEND_FAMILY] ?? 0 }, busy: { [LEND_FAMILY]: busyOf(d, entry.peer) }, roles: entry.roles, repos: entry.repos,
    ordersLeftToday: left };
}

async function pollPeer(entry: LendEntry, d: LoopDeps, status: LendStatus["peers"][string]): Promise<void> {
  const r = await lendRequest(d.call, entry.peer, "poll", { capacity: capacityOf(entry, d) });
  status.lastPollAt = d.now();
  status.lastError = r.ok ? null : `${r.code} ${r.error}`.slice(0, 200);
  setMeta(d.db, `lastPoll:${entry.peer}`, JSON.stringify({ at: status.lastPollAt, error: status.lastError }));
  setMeta(d.db, `nextPoll:${entry.peer}`, String(d.now() + (r.ok ? Math.max(POLL_MS, Math.min(r.value.pollAfterMs, 10 * 60_000)) : POLL_MS)));
  if (!r.ok) return;
  // 收单入口：poll 回来的这段工夫里可能已收回，admitOrders 现读授权
  const got = await admitOrders(d, { peer: entry.peer, fp: entry.fp ?? null }, r.value.orders, "poll");
  if (got.refused.length) d.log(`${entry.peer} 的挂单这轮不收 ${got.refused.length} 张：${got.refused.map((x) => `${x.orderId}=${x.code}`).join(", ").slice(0, 300)}`);
}

/**
 * 这一轮的依赖：出站经闸（不联网阶段一律不发；某个 peer 没拿到应答一次，本轮对它的其余出站都跳过），结束通知在该等的时候留着，
 * proto 2 的续租结果从这轮的 beat 应答里取。
 */
function roundDeps(d: LoopDeps, r: Round): LoopDeps {
  const gate = <O extends string>(call: LendCall<O>): LendCall<O> => async (peer, op, body) => {
    if (r.offline) throw new Error("收回阶段不出站");
    if (r.failed.has(peer)) throw new Error(`本轮对 ${peer} 的出站已失败过一次，跳过`);
    try {
      return await call(peer, op, body);
    } catch (e) {
      if (!(e instanceof SchedulerStopped)) r.failed.add(peer);
      throw e;
    }
  };
  const live = (peer: string) => !!d.v2 && speaksV2(d.db, peer);
  return {
    ...d, call: gate(d.call), ...(d.v2 ? { v2: { ...d.v2, call: gate(d.v2.call) } } : {}),
    settleHold: (row) => r.offline || r.failed.has(row.peer) || (row.settle?.notify === "stopped" && isRevoked(row) && live(row.peer)),
    renewal: (row) => (live(row.peer) ? r.renewals.get(row.orderId) ?? null : undefined),
  };
}

/** 一个 peer 一个 try：服务停止 / 失租原样往外抛，别的错只记日志，不挡别的 peer */
async function perPeer(d: LoopDeps, peer: string, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof SchedulerStopped) throw e;
    d.log(`${what} ${peer} 出错：${(e as Error).message.slice(0, 200)}`);
  }
}

/** ① 不联网：授权已失效的占租约单按收回表收尾（kill 并确认退出），通知 A 留到出站阶段。返回已收尾的单号（本轮不再推进） */
async function revokeOffline(d: LoopDeps, failed: TickResult["failed"]): Promise<Set<string>> {
  const done = new Set<string>();
  for (const row of liveOrders(d.db).filter((r) => r.state !== "asked")) {
    try {
      const g = await liveGrant(row, d);
      if (!g.ok && !(await revoke(row, g.problem, d))) done.add(row.orderId);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ orderId: row.orderId, error: (e as Error).message.slice(0, 300) });
    }
  }
  return done;
}

/** ② hello 每个该说的 peer，再给 v2 的 peer 发 beat；beat 回 404 = 对方降级，当轮切回 v1（逐单续租、立刻 poll） */
async function v2Step(d: LoopDeps & { v2: V2Port }, entries: LendEntry[], problemOf: (peer: string) => string | null, r: Round): Promise<void> {
  if (getMeta(d.db, BOOT_KEY) !== d.v2.boot) {
    setMeta(d.db, BOOT_KEY, d.v2.boot); // 调度服务刚启动：每个 peer 当轮立刻 poll 一次
    for (const e of entries) r.pollNow.add(e.peer);
  }
  for (const t of helloTargets(d.db, entries, d.now())) {
    if (!problemOf(t.peer)) await perPeer(d, t.peer, "hello", () => helloPeer(d, t.peer, t.entry, r));
  }
  const holders = new Set([...liveOrders(d.db), ...unsettledOrders(d.db)].map((x) => x.peer));
  for (const peer of holders) {
    if (!speaksV2(d.db, peer)) continue;
    await perPeer(d, peer, "beat", async () => {
      if ((await beatPeer(d, peer, r.renewals)) !== "old_peer") return;
      setMeta(d.db, protoKey(peer), "1");
      r.pollNow.add(peer);
    });
  }
}

/** 这个 peer 现在该不该 poll；doctor 也看这一刻的间隔 */
function pollDue(d: LoopDeps, peer: string, now: number, r: Round): { due: boolean; every: number } {
  const fallback = !!d.v2 && v2Live(d.db, peer, now) && now - Number(getMeta(d.db, pushKey(peer)) ?? 0) <= PUSH_SEEN_MS;
  if (r.pollNow.has(peer)) return { due: true, every: fallback ? FALLBACK_POLL_MS : POLL_MS };
  if (!fallback) return { due: now >= Number(getMeta(d.db, `nextPoll:${peer}`) ?? 0), every: POLL_MS };
  return { due: now >= (metaJson<{ at?: number }>(d.db, `lastPoll:${peer}`)?.at ?? 0) + FALLBACK_POLL_MS, every: FALLBACK_POLL_MS };
}

export async function lendTick(d: LoopDeps): Promise<TickResult> {
  const now = d.now();
  setMeta(d.db, TICK_KEY, String(now));
  const r: Round = { offline: true, failed: new Set(), pollNow: new Set(), renewals: new Map() };
  const rd = roundDeps(d, r);
  const failed: TickResult["failed"] = [];
  const done = await revokeOffline(rd, failed);
  r.offline = false;
  const read = await d.readLend();
  const ctx = await d.context();
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, d.now(), d.writeOpen);
  const entryOf = (peer: string) => eff.lend.find((e) => e.peer === peer);
  const proxies = proxyVarsIn(d.env);
  const peers = await d.peers();
  const problemOf = (peer: string) => peerLendProblem(peers.find((p) => p.name === peer), peer);
  if (rd.v2 && !proxies.length) await v2Step(rd as LoopDeps & { v2: V2Port }, eff.lend, problemOf, r);
  for (const row of [...unsettledOrders(d.db), ...liveOrders(d.db).filter((x) => !done.has(x.orderId))]) {
    try {
      if (row.settle) await settleOrder(row, rd); // 上次终态之后没做完的收尾（通知 A、删目录、收据）
      else if (row.state === "asked") await driveAsked(row, entryOf(row.peer), rd);
      else await driveLeased(row, rd);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ orderId: row.orderId, error: (e as Error).message.slice(0, 300) });
    }
  }
  const paused = await refreshPause(d.db, d.codexQuota, d.now(), d.log); // 本机 worker 撞了 Codex 额度：到重置时刻前不领新单（lend-health.ts）
  const blocked = eff.invalid ? `lend.json 无效：${eff.invalid}` : !eff.lending ? "没有生效的出借条目" : proxies.length ? `环境里有代理变量 ${proxies.join(", ")}，不 poll`
    : paused !== null ? `本机 Codex 撞了额度，暂停借单到 ${new Date(paused).toISOString()}` : null;
  const status: LendStatus = { at: now, lending: eff.lending, blocked, peers: {} };
  for (const entry of blocked ? [] : eff.lend) {
    // 被节流跳过的轮次沿用上一次 poll 的时间与错误（meta lastPoll:<peer>），doctor 才看得到「最近一次 poll 失败在哪」
    const last = metaJson<{ at?: number; error?: string | null }>(d.db, `lastPoll:${entry.peer}`) ?? {};
    const s: LendStatus["peers"][string] = { problem: problemOf(entry.peer), lastPollAt: last.at ?? null, lastError: last.error ?? null };
    status.peers[entry.peer] = s;
    const due = pollDue(d, entry.peer, now, r);
    if (d.v2) {
      const h = helloView(d.db, entry.peer);
      Object.assign(s, { proto: h.proto, hello: h.hello, selfCheck: h.selfCheck, beat: beatView(d, entry.peer), pushAt: Number(getMeta(d.db, pushKey(entry.peer))) || null,
        pollMs: due.every });
    }
    if (s.problem || !due.due || r.failed.has(entry.peer)) continue;
    try {
      await pollPeer(entry, rd, s);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      s.lastError = (e as Error).message.slice(0, 200);
    }
  }
  setMeta(d.db, "status", JSON.stringify(status));
  return { failed };
}
