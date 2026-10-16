/** XMACH1 [验收线 1]：now-machines-model 的在线数、借出 / 借入在跑与停住、403 时整段为空（数据同 tests/helpers/machines-shots.ts） */
import { expect, test } from "bun:test";
import type { BorrowView } from "../web/features/borrow/borrow-api";
import type { LendData } from "../web/features/lend/lend-model";
import { borrowedLine, lendStopping, machinesView, remoteRunning, remoteStuck } from "../web/features/now/now-machines-model";
import { busyLine } from "../web/features/now/now-model";
import { machinesBorrow, machinesContacts, machinesLend } from "./helpers/machines-shots";
import { TODAY_NOW } from "./helpers/today-shots";

const NOW = TODAY_NOW;
const contacts = machinesContacts();
const peers = { online: contacts.filter((c) => c.online === true).length, total: contacts.length };
const lendData = machinesLend(NOW) as LendData;
/** orders 跟着 data 走（useLendState 落地时也是同一份） */
const lend = (over: Partial<{ data: LendData | null | undefined; stopping: Map<string, number> }> = {}) => {
  const data = "data" in over ? over.data : lendData;
  return { data, orders: data?.orders ?? [], stopping: new Map<string, number>(), now: NOW, ...over };
};
const borrow = (view: BorrowView | null = machinesBorrow(NOW) as BorrowView, hidden = false) => ({ view, hidden });

test("[验收线 1] 伙伴机器 1/2；借出在跑 2 单其中停住 1（已收回的机器 C 那单）；借入在跑 3 单其中停住 1（B1 租约过期）", () => {
  const v = machinesView(peers, lend(), borrow())!;
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

test("停止起点：本页记下的优先；授权还在的单不算收回；刚收回不到 70 秒还是停止中、不算停住", () => {
  const s = lendStopping(lend({ stopping: new Map([["lend-1", NOW - 1000]]) }));
  expect([...s]).toEqual([["lend-1", NOW - 1000], ["lend-2", NOW - 5 * 60_000]]);
  const fresh = { ...lendData, orders: lendData.orders.map((o) => (o.orderId === "lend-2" ? { ...o, updatedAt: NOW - 10_000 } : o)) };
  expect(machinesView(peers, lend({ data: fresh }), borrow())!.lent).toMatchObject({ stuck: 0 });
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
