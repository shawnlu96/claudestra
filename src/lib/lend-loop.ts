/**
 * 出借方 B 的 lend 循环一轮（docs/design/remote-capacity.md §2.3）：scheduler 服务的 pass 里、维护租约之内跑。
 * 先推进 journal 里已有的单（重启恢复就是这一步：按状态续做，不重新 poll 已 claim 的单），再按 lend.json 对每个出借条目 poll。
 * 只认 lend.json 里此刻有效的一次授权（effectiveLend / lend-grant.ts liveGrant：无效文件、没授权、过期、暂停、指纹变了 = 没有）；
 * 授权没了，还没 claim 的单放弃，已 claim 的按阶段退回或停掉（lend-drive.ts revoke）。前提不满足（环境里有代理变量、peer 没钉完整公钥或没有 E2E 记录）就不 poll，原因记进 journal 的 meta 给 doctor 看。
 * 每张单一个 try：某张单出错不挡别的单；服务停止 / 失租（SchedulerStopped）原样往外抛，本轮到此为止。tests/lend-loop.test.ts。
 */
import { effectiveLend } from "./lend-policy.js";
import type { LendEntry } from "./lend-config.js";
import { advance, getMeta, liveOrders, openSlots, ordersToday, patchOrder, recordAsked, setMeta, unsettledOrders, LEASED_STATES, type LendRow } from "./lend-journal.js";
import { claimOrder, claimProblem, driveLeased, settleOrder, type LendDeps } from "./lend-drive.js";
import { liveGrant } from "./lend-grant.js";
import { roleOfStep } from "./lend-git.js";
import { lendRequest, peerLendProblem, proxyVarsIn, type PolledOrder } from "./lend-remote.js";
import type { HttpPeer } from "./peers.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";
import { refreshPause } from "./lend-health.js";

export const POLL_MS = 30_000;
/** v1 只起 Codex worker（审查与 i28-R6 的写单都是）：声明里的 claude 位不报给 A，A 也就不会派 Claude 单来 */
const FAMILY = "codex";

export interface LoopDeps extends LendDeps {
  peers(): Promise<HttpPeer[]>;
  env: Record<string, string | undefined>;
}

/** doctor 读的本轮摘要（journal meta "status"） */
export interface LendStatus {
  at: number;
  lending: boolean;
  /** 整体不 poll 的原因（代理变量 / 文件无效 / 没开）；null = 在 poll */
  blocked: string | null;
  peers: Record<string, { problem: string | null; lastPollAt: number | null; lastError: string | null }>;
}

export interface TickResult { failed: { orderId: string; error: string }[] }

const busyOf = (d: LoopDeps, peer: string): number => {
  const r = d.db.query(`SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND family = ? AND state IN (${LEASED_STATES.map(() => "?").join(",")})`)
    .get(peer, FAMILY, ...LEASED_STATES) as { n: number };
  return r.n;
};

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

/** 挂单摘要本地先过一遍：家族、角色（审查单要 review，开工 / 修复单要 write）、白名单、今日额度、在跑位（含等 owner 批的） */
function wanted(o: PolledOrder, entry: LendEntry, d: LoopDeps): boolean {
  const role = roleOfStep(o.step);
  if (o.family !== FAMILY || !role || !entry.roles.includes(role) || !entry.repos.includes(o.repo)) return false;
  if (ordersToday(d.db, entry.peer, d.now()) >= entry.ordersPerDay) return false;
  return openSlots(d.db, entry.peer, FAMILY) < (entry.families[FAMILY] ?? 0);
}

async function pollPeer(entry: LendEntry, d: LoopDeps, status: LendStatus["peers"][string]): Promise<void> {
  const slots = entry.families[FAMILY] ?? 0;
  const left = Math.max(0, entry.ordersPerDay - ordersToday(d.db, entry.peer, d.now()));
  const r = await lendRequest(d.call, entry.peer, "poll", {
    capacity: { families: { [FAMILY]: slots }, busy: { [FAMILY]: busyOf(d, entry.peer) }, roles: entry.roles, repos: entry.repos, ordersLeftToday: left },
  });
  status.lastPollAt = d.now();
  status.lastError = r.ok ? null : `${r.code} ${r.error}`.slice(0, 200);
  setMeta(d.db, `lastPoll:${entry.peer}`, JSON.stringify({ at: status.lastPollAt, error: status.lastError }));
  setMeta(d.db, `nextPoll:${entry.peer}`, String(d.now() + (r.ok ? Math.max(POLL_MS, Math.min(r.value.pollAfterMs, 10 * 60_000)) : POLL_MS)));
  if (!r.ok) return;
  const g = await liveGrant({ peer: entry.peer, fp: entry.fp ?? null }, d); // 收单入口：poll 回来的这段工夫里可能已收回
  if (!g.ok) return d.log(`${entry.peer} 的挂单这轮不收：${g.problem}`);
  for (const o of r.value.orders) {
    if (!wanted(o, g.entry, d)) continue;
    const preview = { taskId: o.taskId, step: o.step, repo: o.repo, pr: o.pr, head: o.head, round: o.round, specRev: o.specRev };
    recordAsked(d.db, { orderId: o.orderId, peer: entry.peer, fp: entry.fp ?? null, family: o.family, preview }, d.now());
  }
}

export async function lendTick(d: LoopDeps): Promise<TickResult> {
  const now = d.now();
  const read = await d.readLend();
  const ctx = await d.context();
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, now, d.writeOpen);
  const entryOf = (peer: string) => eff.lend.find((e) => e.peer === peer);
  const failed: TickResult["failed"] = [];
  for (const row of [...unsettledOrders(d.db), ...liveOrders(d.db)]) {
    try {
      if (row.settle) await settleOrder(row, d); // 上次终态之后没做完的收尾（通知 A、删目录、收据）
      else if (row.state === "asked") await driveAsked(row, entryOf(row.peer), d);
      else await driveLeased(row, d);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      failed.push({ orderId: row.orderId, error: (e as Error).message.slice(0, 300) });
    }
  }
  const proxies = proxyVarsIn(d.env);
  const paused = await refreshPause(d.db, d.codexQuota, d.now(), d.log); // 本机 worker 撞了 Codex 额度：到重置时刻前不领新单（lend-health.ts）
  const blocked = eff.invalid ? `lend.json 无效：${eff.invalid}` : !eff.lending ? "没有生效的出借条目" : proxies.length ? `环境里有代理变量 ${proxies.join(", ")}，不 poll`
    : paused !== null ? `本机 Codex 撞了额度，暂停借单到 ${new Date(paused).toISOString()}` : null;
  const status: LendStatus = { at: now, lending: eff.lending, blocked, peers: {} };
  const peers = blocked ? [] : await d.peers();
  for (const entry of blocked ? [] : eff.lend) {
    // 被节流跳过的轮次沿用上一次 poll 的时间与错误（meta lastPoll:<peer>），doctor 才看得到「最近一次 poll 失败在哪」
    const last = JSON.parse(getMeta(d.db, `lastPoll:${entry.peer}`) ?? "{}") as { at?: number; error?: string | null };
    const s = { problem: peerLendProblem(peers.find((p) => p.name === entry.peer), entry.peer), lastPollAt: last.at ?? null, lastError: last.error ?? null };
    status.peers[entry.peer] = s;
    if (s.problem || now < Number(getMeta(d.db, `nextPoll:${entry.peer}`) ?? 0)) continue;
    try {
      await pollPeer(entry, d, s);
    } catch (e) {
      if (e instanceof SchedulerStopped) throw e;
      s.lastError = (e as Error).message.slice(0, 200);
    }
  }
  setMeta(d.db, "status", JSON.stringify(status));
  return { failed };
}
