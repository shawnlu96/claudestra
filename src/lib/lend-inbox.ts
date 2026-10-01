/**
 * 出借方 B 唯一的收单闸（docs/design/remote-capacity.md §2.3 第 1 步）：A 推来的单（manager lend inbox）和兜底轮询拿到的单（lend-loop.ts）都过这里，
 * 各核对项只写这一份。逐单核：生效授权（含暂停、过期、指纹变了、文件无效）、家族（claude 一律拒，等 clean 启动 + strict MCP）、角色（写单开关关着时一律拒）、
 * 仓库白名单、今日剩余单数、空位（已接下没领的 asked 也占位）、本机 Codex 撞额度暂停。
 * 读完 lend.json（liveGrant 最后读它）之后不再 await：计数和插入在同一个 BEGIN IMMEDIATE 事务里，推送和轮询并发也不会超额，
 * lend.json 收回写盘之后才开始的请求一定看得到收回。收下只记 asked，claim 在调度服务下一个 pass 做（lend-loop.ts driveAsked）。
 * tests/lend-inbox.test.ts。
 */
import type { Database } from "bun:sqlite";
import type { LendEntry } from "./lend-config.js";
import { roleOfStep } from "./lend-git.js";
import { liveGrant } from "./lend-grant.js";
import { WRITE_ROLE_OPEN } from "./lend-grant-rules.js";
import { pausedUntil } from "./lend-health.js";
import { getMeta, getOrder, isTerminal, openSlots, ordersToday, recordAsked, setMeta } from "./lend-journal.js";
import type { PolledOrder } from "./lend-remote.js";
import type { LendDeps } from "./lend-drive.js";

/** 只借 Codex：claude 位要等 worker 用 clean 启动 + strict MCP 之后再开，A 派来的 Claude 单一律拒 */
export const LEND_FAMILY = "codex";
/** 调度服务的 lend 步这么久没开过一轮 = 服务没在跑：推来的单全拒，别让 A 白等推送 TTL（3 分钟） */
export const LENDER_IDLE_MS = 90_000;
/** lend 步每轮开头记的时刻（lend-loop.ts），收单入口据此判 lender_idle */
export const TICK_KEY = "tickAt";
export const pushKey = (peer: string): string => `pushAt:${peer}`;

/** A 侧要求 ^[a-z_]{1,40}$；拒收码就这几个 */
type RefuseCode = "no_grant" | "family" | "role" | "write_closed" | "repo" | "daily" | "no_slot" | "paused" | "closed" | "id_conflict" | "lender_idle";

/** 推送的摘要（lend-wire OfferSummary）和 poll 列出的摘要同形；step / family 按字符串收，认不出的在这里拒 */
type OrderSummary = Omit<PolledOrder, "offeredAt">;

export interface Admitted { accepted: string[]; refused: { orderId: string; code: RefuseCode }[] }

/** 今日已占的单数：claim 过的（ordersToday）加已接下、还没领的（领了就要算进今天） */
export function dailyUsed(db: Database, peer: string, now: number): number {
  const asked = (db.query("SELECT COUNT(*) AS n FROM lend_orders WHERE peer = ? AND state = 'asked'").get(peer) as { n: number }).n;
  return ordersToday(db, peer, now) + asked;
}

/** 这一单在授权里吗（不含计数）；null = 范围内 */
function scopeCode(o: OrderSummary, entry: LendEntry, writeOpen: boolean): RefuseCode | null {
  if (o.family !== LEND_FAMILY) return "family";
  const role = roleOfStep(o.step);
  if (!role) return "role";
  if (role === "write" && !writeOpen) return "write_closed";
  if (!entry.roles.includes(role)) return "role";
  return entry.repos.includes(o.repo) ? null : "repo";
}

const refuseAll = (orders: OrderSummary[], code: RefuseCode): Admitted => ({ accepted: [], refused: orders.map((o) => ({ orderId: o.orderId, code })) });

/**
 * 收一批单。caller.fp = 这次请求方的实例指纹（推送：钉住的公钥算的；轮询：授权里记的），和授权里的对不上 = 没有授权。
 * 重复：同 peer 同号已有活行 → accepted（不插第二行）；已是终态 → closed；同号属于别的 peer → id_conflict，那一行一字不动。
 */
export async function admitOrders(d: Pick<LendDeps, "db" | "now" | "readLend" | "context" | "writeOpen">, caller: { peer: string; fp: string | null },
  orders: OrderSummary[], source: "push" | "poll"): Promise<Admitted> {
  if (source === "push") {
    setMeta(d.db, pushKey(caller.peer), String(d.now())); // 拒收的也记：它说明这个 A 推得过来（轮询节奏），doctor 也靠它认出名字对不上的授权
    if (d.now() - Number(getMeta(d.db, TICK_KEY) ?? 0) > LENDER_IDLE_MS) return refuseAll(orders, "lender_idle");
  }
  const g = await liveGrant({ peer: caller.peer, fp: caller.fp }, d);
  // 以下同步：读完 lend.json 到写完 journal 之间没有 await
  if (!g.ok) return refuseAll(orders, "no_grant");
  if (caller.fp === null || g.entry.fp !== caller.fp) return refuseAll(orders, "no_grant");
  const entry = g.entry;
  const writeOpen = d.writeOpen ?? WRITE_ROLE_OPEN;
  return d.db.transaction((): Admitted => {
    const now = d.now();
    const out: Admitted = { accepted: [], refused: [] };
    const refuse = (orderId: string, code: RefuseCode) => void out.refused.push({ orderId, code });
    const paused = pausedUntil(d.db, now) !== null;
    let used = dailyUsed(d.db, caller.peer, now);
    let busy = openSlots(d.db, caller.peer, LEND_FAMILY);
    const slots = entry.families[LEND_FAMILY] ?? 0;
    for (const o of orders) {
      const cur = getOrder(d.db, o.orderId);
      if (cur && cur.peer !== caller.peer) { refuse(o.orderId, "id_conflict"); continue; }
      if (cur && isTerminal(cur.state)) { refuse(o.orderId, "closed"); continue; }
      if (cur) { out.accepted.push(o.orderId); continue; }
      const code = scopeCode(o, entry, writeOpen) ?? (paused ? "paused" : used >= entry.ordersPerDay ? "daily" : busy >= slots ? "no_slot" : null);
      if (code) { refuse(o.orderId, code); continue; }
      const preview = { taskId: o.taskId, step: o.step, repo: o.repo, pr: o.pr, head: o.head, round: o.round, specRev: o.specRev, source };
      recordAsked(d.db, { orderId: o.orderId, peer: caller.peer, fp: entry.fp ?? null, family: o.family, preview }, now);
      used++;
      busy++;
      out.accepted.push(o.orderId);
    }
    return out;
  }).immediate();
}
