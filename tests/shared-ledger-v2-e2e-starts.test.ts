/** X15 验收线 2 的启动观测：peer B 的真实借方循环经本机真实出借接口领中心写单，假 worker 在 peer B 演练目录留启动记录。
 * 正例：peer B 重启后 journal 只记到 cloned（起了 worker、没来得及记 started），按 journal 里的名字在 registry 认领，不建第二个。
 * 反例（演练断言的灵敏度）：执行方把自己的记录都丢了（journal 退回 cloned、registry 里也没有这个 worker）再跑一轮，就会起第二个
 * worker；启动记录照实记下两次，各演练用的 expectStartedOnce 随即失败——中心 lend.claim 仍只有 1 条，只看领单次数发现不了。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { getOrder } from "../src/lib/lend-journal.js";
import { claimedWrite, cleanupLendApi, expectStartedOnce, startsOf } from "./shared-ledger-v2-e2e-executor.test.js";
import { cleanupWorlds, mergeReady, world, type World } from "./shared-ledger-v2-e2e-world.test.js";

afterEach(() => { cleanupLendApi(); cleanupWorlds(); });

async function started(w: World) {
  const T = await mergeReady(w, "task-starts"), c = await claimedWrite(w, T);
  expect(await c.b.until(c.orderId, "started")).toBe("started");
  expectStartedOnce(w.peerB.dir, c.orderId);
  /** Puts peer B's journal row back to cloned, as a crash between creating the worker and recording started would leave it. */
  const rewind = () => c.b.h.db.run("UPDATE lend_orders SET state = 'cloned', sessionId = NULL, submit = NULL WHERE orderId = ?", [c.orderId]);
  const claims = () => w.k.center.log.filter(e => e.command === "lend.claim").length;
  return { ...c, rewind, claims };
}

describe("X15 演练 · 执行方启动观测", () => {
  test("peer B 重启时 journal 停在 cloned：按记下的 worker 名在 registry 认领，回到 started，不起第二个", async () => {
    const w = await world(), s = await started(w);
    s.rewind();
    await s.b.restart();
    expect(getOrder(s.b.h.db, s.orderId)).toMatchObject({ state: "started" });
    expect(s.b.h.log.created).toHaveLength(1);
    expectStartedOnce(w.peerB.dir, s.orderId);
    expect(s.claims()).toBe(1);
  });

  test("反例：执行方丢了 journal 进度与 registry 里的 worker 再跑一轮，起了第二个 worker；启动记录抓到，只看领单次数抓不到", async () => {
    const w = await world(), s = await started(w);
    s.rewind();
    s.b.h.registry.clear();
    await s.b.restart();
    expect(startsOf(w.peerB.dir, s.orderId)).toHaveLength(2);
    expect(() => expectStartedOnce(w.peerB.dir, s.orderId)).toThrow();
    expect(s.claims()).toBe(1);
  });
});
