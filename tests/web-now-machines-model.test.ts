/** XMACH1 [验收线 1]：now-machines-model 的在线数、借出 / 借入在跑与停住、403 时整段为空（数据同 tests/helpers/machines-shots.ts） */
import { expect, test } from "bun:test";
import type { BorrowView } from "../web/features/borrow/borrow-api";
import type { LendData } from "../web/features/lend/lend-model";
import { borrowedLine, lendStopping, machinesView, observeStopping, remoteRunning, remoteStuck } from "../web/features/now/now-machines-model";
import { busyLine } from "../web/features/now/now-model";
import { machinesBorrow, machinesContacts, machinesLend } from "./helpers/machines-shots";
import { TODAY_NOW } from "./helpers/today-shots";

const NOW = TODAY_NOW;
const contacts = machinesContacts();
const peers = { online: contacts.filter((c) => c.online === true).length, total: contacts.length };
const lendData = machinesLend(NOW) as LendData;
/** orders 跟着 data 走（useLendState 落地时也是同一份） */
const lend = (over: Partial<{ data: LendData | null | undefined; stopping: Map<string, number>; now: number }> = {}) => {
  const data = "data" in over ? over.data : lendData;
  return { data, orders: data?.orders ?? [], stopping: new Map<string, number>(), now: NOW, ...over };
};
/** 今天页 5 分钟前就看到机器 C 那单已收回（observeStopping 记下的起点） */
const seen5m = new Map([["lend-2", NOW - 5 * 60_000]]);
const borrow = (view: BorrowView | null = machinesBorrow(NOW) as BorrowView, hidden = false) => ({ view, hidden });

test("[验收线 1] 伙伴机器 1/2；借出在跑 2 单其中停住 1（已收回的机器 C 那单）；借入在跑 3 单其中停住 1（B1 租约过期）", () => {
  const v = machinesView(peers, lend(), borrow(), seen5m)!;
  expect(v.peers).toEqual({ online: 1, total: 2 });
  expect(v.lent!.orders.map((o) => o.orderId)).toEqual(["lend-1", "lend-2"]);
  expect(v.lent!.stuck).toBe(1);
  expect(v.borrowed!.rows).toHaveLength(3);
  expect(v.borrowed!.stuck).toBe(1);
  expect(new Set(v.borrowed!.rows.map((r) => r.project))).toEqual(new Set(["proj-a", "proj-b"]));
});

test("[验收线 1] 403：借出、借入两头都拿不到 → 整段为空；没有伙伴机器也为空", () => {
  expect(machinesView(peers, lend({ data: null }), borrow(null, true))).toBeNull();
  expect(machinesView(null, lend(), borrow())).toBeNull();
  expect(machinesView({ online: 0, total: 0 }, lend(), borrow())).toBeNull();
});

test("某一类 0 单 / 还没拉到 / 单边 403：那一行为 null，其余照出", () => {
  const noLive = { ...lendData, orders: lendData.orders.filter((o) => !o.live) };
  const v = machinesView(peers, lend({ data: noLive }), borrow())!;
  expect(v.lent).toBeNull();
  expect(v.borrowed!.rows).toHaveLength(3);
  expect(machinesView(peers, lend({ data: undefined }), borrow())!.lent).toBeNull();
  expect(machinesView(peers, lend({ data: null }), borrow())!.borrowed).not.toBeNull();
  expect(borrowedLine(borrow({ ...(machinesBorrow(NOW) as BorrowView), remote: [] }))).toBeNull();
  expect(borrowedLine(borrow(null))).toBeNull();
});

test("停止起点：本页记下的优先；其余按今天页头一次看到已收回的时刻；授权还在的单不算收回", () => {
  const s = lendStopping(lend({ stopping: new Map([["lend-1", NOW - 1000]]) }), new Map([["lend-1", NOW - 9e5], ["lend-2", NOW - 5 * 60_000]]));
  expect([...s]).toEqual([["lend-1", NOW - 1000], ["lend-2", NOW - 5 * 60_000]]);
  const first = observeStopping(new Map(), lend(), NOW);
  expect([...first]).toEqual([["lend-2", NOW]]);
  // 已记的保留原起点；没变化原样返回；单停了 / 授权回来了就清掉
  expect(observeStopping(first, lend(), NOW + 60_000)).toBe(first);
  const ended = { ...lendData, orders: lendData.orders.map((o) => (o.orderId === "lend-2" ? { ...o, live: false } : o)) };
  expect([...observeStopping(first, lend({ data: ended }), NOW + 60_000)]).toEqual([]);
  const regranted = { ...lendData, grants: [...lendData.grants, { ...lendData.grants[0]!, peer: "机器 C" }] };
  expect([...observeStopping(first, lend({ data: regranted }), NOW + 60_000)]).toEqual([]);
  expect(observeStopping(first, lend({ data: undefined }), NOW + 60_000)).toBe(first);
});

test("[验收线 2] 收回时刻不拿 updatedAt 倒推：T-60 秒续租过、T 收回、T+10 秒还 live 是停止中，不算停住；看到 70 秒后才算", () => {
  const T = NOW;
  const data = { ...lendData, orders: lendData.orders.map((o) => (o.orderId === "lend-2" ? { ...o, updatedAt: T - 60_000 } : o)) };
  const seen = observeStopping(new Map(), lend({ data }), T + 10_000);
  expect(machinesView(peers, lend({ data, now: T + 10_000 }), borrow(), seen)!.lent).toMatchObject({ stuck: 0 });
  expect(machinesView(peers, lend({ data, now: T + 79_000 }), borrow(), seen)!.lent).toMatchObject({ stuck: 0 });
  expect(machinesView(peers, lend({ data, now: T + 80_000 }), borrow(), seen)!.lent).toMatchObject({ stuck: 1 });
  // 没看到过（不给 seen）：一律还不算停住
  expect(machinesView(peers, lend(), borrow())!.lent).toMatchObject({ stuck: 0 });
});

test("远端停住：待 PM 或租约已过；在别的机器上真在跑的只数 claimed", () => {
  expect(remoteStuck({ status: "unknown", leaseUntil: null }, NOW)).toBe(true);
  expect(remoteStuck({ status: "claimed", leaseUntil: NOW }, NOW)).toBe(true);
  expect(remoteStuck({ status: "claimed", leaseUntil: NOW + 1 }, NOW)).toBe(false);
  expect(remoteStuck({ status: "pooled", leaseUntil: null }, NOW)).toBe(false);
  expect(remoteRunning(machinesBorrow(NOW) as BorrowView)).toBe(2);
  expect(remoteRunning(null)).toBe(0);
});

test("『在干活』一句：有借入在跑时带『其中 M 个在别的机器』，没有时同原来", () => {
  const tr = (s: string, p?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(p?.[k]));
  expect(busyLine({ busy: 4, remote: 4 }, tr)).toBe("4 个 agent 在干活 · 其中 4 个在别的机器");
  expect(busyLine({ busy: 3, remote: 0 }, tr)).toBe("3 个 agent 在干活");
});
