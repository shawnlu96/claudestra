/** X15 演练补用例（i28-CLAIME2E1）：领单回包丢失。中心 lend.claim 已提交、回包在路上丢了，本机出借接口回 503 unavailable；
 * peer B 的借方循环（LENDCLAIM1 起）把它当「下轮再试」：单子不记 declined，下一轮重新领单时本机先查回执 committed、只读订单视图
 * 对账，不再发 lend.claim、不开第二个租约；worker 只按启动记录起一次。故障注入沿用丢回执演练的 commands / drop。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getOrder } from "../src/lib/lend-journal.js";
import { claimedWrite, cleanupLendApi, expectStartedOnce } from "./shared-ledger-v2-e2e-executor.test.js";
import { cleanupWorlds, evidence, mergeReady, world, type World } from "./shared-ledger-v2-e2e-world.test.js";

afterEach(() => { cleanupLendApi(); cleanupWorlds(); });

/** Every center request since `from`, routes included (receipt lookups and order views carry no command). */
const requests = (w: World, from: number) => w.k.center.log.slice(from).map(e => `${e.command ?? e.route} ${e.status}`);

describe("X15 演练 · 领单回包丢失", () => {
  test("中心已 claimed、回包丢了：首轮不记 declined；下一轮重新领单只对账、不重复领、不重开租约；worker 只启动一次", async () => {
    const w = await world(), T = await mergeReady(w, "task-claim-drop"), { orderId, b } = await claimedWrite(w, T);
    const state = () => getOrder(b.h.db, orderId)?.state, center = () => w.k.center.rows().orders.get(orderId)!;
    w.k.center.inject({ kind: "drop", route: "commands", command: "lend.claim" });
    const from = w.k.center.log.length;
    // 第一轮：peer B 先拉挂单（asked），再领单——中心记下 claim（租约 gen 1）但回包丢了，本机出借接口回 503 unavailable
    expect(await b.until(orderId, "asked")).toBe("asked");
    await b.restart();
    expect(requests(w, from)).toEqual(["receipts 200", "lend 200", "lend.claim dropped"]);
    expect(state()).toBe("asked");
    expect(b.h.log.lines).toContain(`claim ${orderId} 暂未成功（unavailable），下轮再试`);
    expect(center()).toMatchObject({ status: "claimed", leaseGen: 1, worker: { instanceId: "peer-b" } });
    const lease = { leaseGen: center().leaseGen, leaseUntil: center().leaseUntil };

    // 第二轮：重新领单只对账（回执 committed + 订单视图），中心不再收 lend.claim，租约不动
    const again = w.k.center.log.length;
    await b.restart();
    expect(state()).toBe("claimed");
    expect(requests(w, again)).toEqual(["receipts 200", "lend 200"]);
    expect({ leaseGen: center().leaseGen, leaseUntil: center().leaseUntil }).toEqual(lease);
    expect(getOrder(b.h.db, orderId)).toMatchObject({ leaseGen: 1 });

    // 往下照常起 worker 并重启两次：启动记录只有一条，中心 lend.claim 全程只那一条（dropped）
    expect(await b.until(orderId, "started")).toBe("started");
    await b.restart();
    await b.restart();
    expect(state()).toBe("started");
    const start = expectStartedOnce(w.peerB.dir, orderId);
    expect(b.h.log.created).toEqual([start.worker]);
    expect(w.k.center.log.filter(e => e.command === "lend.claim").map(e => e.status)).toEqual(["dropped"]);
    expect(center()).toMatchObject({ status: "claimed", leaseGen: 1 });

    const ev = evidence(w, "lost-claim-receipt", [{ item: `peer-b:order:${orderId}`, instance: "peer-b",
      local: { firstRound: "asked", reclaim: requests(w, again).slice(0, 2), state: state(), starts: 1 },
      center: { status: center().status, leaseGen: center().leaseGen, claims: ["dropped"] } }]);
    expect(ev.items[0]).toMatchObject({ local: { firstRound: "asked", state: "started", starts: 1 }, center: { status: "claimed", leaseGen: 1 } });
  });
});
