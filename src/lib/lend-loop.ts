/**
 * 出借方 B 的 lend 循环一轮（docs/design/remote-capacity.md §2.3）：scheduler 服务的 pass 里、维护租约之内跑。
 * 先推进 journal 里已有的单（重启恢复就是这一步：按状态续做，不重新 poll 已 claim 的单），再按 lend.json 对每个出借条目 poll。
 * 开关只看 lend.json 的 enabled（经 effectiveLend：无效文件 = 关、联系人没了 = 这条失效）；关了照样把在跑的单跑完，只是不再领新单、
 * 还没 claim 的单放弃。前提不满足（环境里有代理变量、peer 没钉完整公钥或没有 E2E 记录）就不 poll，原因记进 journal 的 meta 给 doctor 看。
 * 每张单一个 try：某张单出错不挡别的单；服务停止 / 失租（SchedulerStopped）原样往外抛，本轮到此为止。tests/lend-loop.test.ts。
 */
import { effectiveLend, type LendContact } from "./lend-policy.js";
import type { LendEntry, LendRead } from "./lend-config.js";
import { advance, getMeta, liveOrders, openSlots, ordersToday, patchOrder, recordAsked, setMeta, unsettledOrders, LEASED_STATES, type LendRow } from "./lend-journal.js";
import { askParams, claimOrder, claimProblem, driveLeased, settleOrder, type LendDeps } from "./lend-drive.js";
import { roleOfStep } from "./lend-git.js";
import { lendRequest, peerLendProblem, proxyVarsIn, type PolledOrder } from "./lend-remote.js";
import type { HttpPeer } from "./peers.js";
import type { ProjectDef } from "./projects.js";
import { SchedulerStopped } from "./scheduler-maintenance.js";

export const POLL_MS = 30_000;
/** v1 只起 Codex worker（审查与 i28-R6 的写单都是）：声明里的 claude 位不报给 A，A 也就不会派 Claude 单来 */
const FAMILY = "codex";

export interface LoopDeps extends LendDeps {
  readLend(): Promise<LendRead>;
  context(): Promise<{ contacts: LendContact[]; projects: ProjectDef[] }>;
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

async function driveAsked(row: LendRow, entry: LendEntry | undefined, d: LoopDeps): Promise<void> {
  const now = d.now();
  const stale = entry && entry.fp && row.fp !== entry.fp ? `${row.peer} 的实例指纹变了` : null;
  const problem = stale ?? claimProblem(row, entry, d.db, now);
  if (problem && problem !== "wait") return void advance(d.db, row.orderId, "asked", "declined", { reason: problem }, now);
  if (entry!.confirm === "per-order") {
    if (!row.askId) {
      // 额度的人话进了授权哈希：先定下来记进 journal，开卡与核对用的是同一句
      if (typeof row.preview.askQuota !== "string") row = patchOrder(d.db, row.orderId, ["asked"], { preview: { ...row.preview, askQuota: askParams(row, entry!, d).quota } }, now);
      const opened = await d.ask.open(askParams(row, entry!, d));
      if (!opened.ok) return d.log(`${row.orderId} 开确认 ask 失败：${opened.error}`);
      row = patchOrder(d.db, row.orderId, ["asked"], { askId: opened.askId }, d.now());
    }
    const v = d.ask.verdict(row.askId!, askParams(row, entry!, d));
    if (v.state === "waiting") return;
    if (v.state === "declined") return void advance(d.db, row.orderId, "asked", "declined", { reason: `owner 没批：${v.reason}` }, d.now());
  }
  if (problem === "wait") return; // 批了但此刻额度 / 位满了：留着，等空出来再领
  if (entry!.confirm === "auto" && typeof row.preview.informedAt !== "number") {
    // 预先授权（effectiveLend 已核过 until）：不开 ask，但 owner 必须先收到这一单的通知；送不到就不领，下轮再发
    const told = await d.ask.inform(askParams(row, entry!, d));
    if (!told.ok) return d.log(`${row.orderId} 预先授权通知没送到，暂不领单：${told.error}`);
    row = patchOrder(d.db, row.orderId, ["asked"], { preview: { ...row.preview, informedAt: d.now() } }, d.now());
  }
  await claimIfStill(row, entry!.confirm, d);
}

/**
 * claim 前最后一道：重读 lend.json、按此刻重算生效策略，与发出 claim 之间不再有 await。本轮开头的快照不能用：
 * inform / ask / 前面几张单的网络调用都要时间，预先授权可能在这期间到期（到期后免确认起 worker = 规格 P1），owner 也可能刚关掉出借。
 * 模式和这轮判定时用的不一样（auto 到期退回逐单确认）就先不领，下一轮按新模式走（逐单确认会开 ask）。
 */
async function claimIfStill(row: LendRow, mode: LendEntry["confirm"], d: LoopDeps): Promise<void> {
  const read = await d.readLend();
  const ctx = await d.context();
  const now = d.now();
  const entry = effectiveLend(read, ctx.contacts, ctx.projects, now).lend.find((e) => e.peer === row.peer);
  const problem = !entry ? "出借条目已失效" : entry.confirm !== mode ? "预先授权已到期或改了，下一轮按逐单确认走" : claimProblem(row, entry, d.db, now);
  if (problem) return d.log(`${row.orderId} 这轮不领：${problem}`);
  await claimOrder(row, d);
}

/** 挂单摘要本地先过一遍：家族、角色（审查单要 review，开工 / 修复单要 write）、白名单、今日额度、在跑位（含等 owner 批的） */
function wanted(o: PolledOrder, entry: LendEntry, d: LoopDeps): boolean {
  const role = roleOfStep(o.step);
  if (o.family !== FAMILY || !role || !entry.roles.includes(role) || !entry.repos.includes(o.repo)) return false;
  if (ordersToday(d.db, entry.peer, d.now()) >= entry.quota.ordersPerDay) return false;
  return openSlots(d.db, entry.peer, FAMILY) < (entry.families[FAMILY] ?? 0);
}

async function pollPeer(entry: LendEntry, d: LoopDeps, status: LendStatus["peers"][string]): Promise<void> {
  const slots = entry.families[FAMILY] ?? 0;
  const left = Math.max(0, entry.quota.ordersPerDay - ordersToday(d.db, entry.peer, d.now()));
  const r = await lendRequest(d.call, entry.peer, "poll", {
    capacity: { families: { [FAMILY]: slots }, busy: { [FAMILY]: busyOf(d, entry.peer) }, roles: entry.roles, repos: entry.repos, ordersLeftToday: left },
  });
  status.lastPollAt = d.now();
  status.lastError = r.ok ? null : `${r.code} ${r.error}`.slice(0, 200);
  setMeta(d.db, `lastPoll:${entry.peer}`, JSON.stringify({ at: status.lastPollAt, error: status.lastError }));
  setMeta(d.db, `nextPoll:${entry.peer}`, String(d.now() + (r.ok ? Math.max(POLL_MS, Math.min(r.value.pollAfterMs, 10 * 60_000)) : POLL_MS)));
  if (!r.ok) return;
  for (const o of r.value.orders) {
    if (!wanted(o, entry, d)) continue;
    const preview = { taskId: o.taskId, step: o.step, repo: o.repo, pr: o.pr, head: o.head, round: o.round, specRev: o.specRev };
    recordAsked(d.db, { orderId: o.orderId, peer: entry.peer, fp: entry.fp ?? null, family: o.family, preview }, d.now());
  }
}

export async function lendTick(d: LoopDeps): Promise<TickResult> {
  const now = d.now();
  const read = await d.readLend();
  const ctx = await d.context();
  const eff = effectiveLend(read, ctx.contacts, ctx.projects, now);
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
  const blocked = eff.invalid ? `lend.json 无效：${eff.invalid}` : !eff.lending ? "没有生效的出借条目" : proxies.length ? `环境里有代理变量 ${proxies.join(", ")}，不 poll` : null;
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
