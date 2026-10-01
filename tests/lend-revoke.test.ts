/**
 * i28-W1 一次授权的门与收回即停（src/lib/lend-grant.ts liveGrant、lend-drive.ts revoke、lend-loop.ts）：
 * 没有有效授权就不 claim、不起 worker；收回后按阶段处理（asked → declined、claimed/cloned → not_started、started → kill 确认后 stopped、
 * result_pending → 停 worker、结论照常转交），包括 claim 与起 worker 之间、开跑通知那一下、首条派单之前的窗口。A 与 worker 都是假的（tests/lend-harness.ts）。
 */
import { describe, expect, test } from "bun:test";
import type { LendRead } from "../src/lib/lend-config.js";
import { workerName } from "../src/lib/lend-drive.js";
import { isRevoked } from "../src/lib/lend-grant.js";
import { advance, getOrder } from "../src/lib/lend-journal.js";
import { ENTRY, harness, sha, toStarted } from "./lend-harness.js";

const W = workerName("o1");
const releases = (h: ReturnType<typeof harness>) => h.calls.filter((c) => c.op === "lease" && c.body.action === "release").map((c) => c.body.reason);
const revoke = (h: ReturnType<typeof harness>) => { h.lend.lend = []; };

describe("P1-1 没有有效授权：一单都不 claim、不起 worker", () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
    ["文件缺失（缺省）", (h) => { h.d.readLend = async () => ({ status: "missing", file: { version: 2, enabled: false, lend: [], borrow: [] } }); }],
    ["文件无效", (h) => { h.d.readLend = async (): Promise<LendRead> => ({ status: "invalid", error: "坏了", file: { version: 2, enabled: false, lend: [], borrow: [] } }); }],
    ["已过期", (h) => { h.advanceTime(7 * 86_400_000); }],
    ["已收回", revoke],
    ["总开关关", (h) => { h.lend.enabled = false; }],
    ["对方换了实例（指纹变了）", (h) => { h.d.context = async () => ({ contacts: [{ name: "team-a", fp: "9999-9999-9999-9999" }], projects: [] }); }],
    ["v1 迁移来的暂停条目", (h) => { h.lend.lend = [{ ...ENTRY, paused: { reason: "旧条目" } }]; }],
    ["期限超过 7 天（手改）", (h) => { h.lend.lend = [{ ...ENTRY, until: new Date(Date.parse(ENTRY.grantedAt!) + 8 * 86_400_000).toISOString() }]; }],
    ["没写到期时间（手改）", (h) => { const { until: _u, ...e } = ENTRY; h.lend.lend = [e]; }],
    ["含 write 角色（W8 之前）", (h) => { h.lend.lend = [{ ...ENTRY, roles: ["review", "write"] }]; }],
  ];
  for (const [name, setup] of cases) {
    test(name, async () => {
      const h = harness();
      setup(h);
      for (let i = 0; i < 6; i++) await h.tick();
      expect(h.ops()).not.toContain("claim");
      expect(h.log.created).toEqual([]);
      expect(h.log.notices).toEqual([]);
    });
  }

  test("已经记下的单（asked）在授权失效后放弃：declined，不 claim", async () => {
    const h = harness();
    h.A.claim = () => ({ status: 503, body: { ok: false, v: 1, code: "transport", error: "x" } });
    await h.tick();
    await h.tick(); // claim 没成，还在 asked
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    h.advanceTime(7 * 86_400_000);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "declined", reason: expect.stringContaining("不再向") });
  });
});

describe("P1-1 收回后的窗口：claim 与起 worker 之间、通知那一下、首条派单之前", () => {
  test("poll 回来的这段工夫里收回：挂单不收（收单入口）", async () => {
    const h = harness();
    const real = h.A.poll;
    h.A.poll = (b) => (revoke(h), real(b));
    await h.tick();
    expect(getOrder(h.db, "o1")).toBeNull();
  });

  test("claim 已发出、A 已给单之后收回：不 clone、不起 worker，按 not_started 退回", async () => {
    const h = harness();
    const real = h.A.claim;
    h.A.claim = (b) => (revoke(h), real(b));
    for (let i = 0; i < 5; i++) await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: expect.stringContaining("收回") });
    expect(releases(h)).toEqual(["not_started"]);
    expect(h.log.created).toEqual([]);
    expect(h.log.notices).toEqual([]);
  });

  test("clone 好了、还没起 worker 时收回：不起，按 not_started 退回", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("cloned");
    revoke(h);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(releases(h)).toEqual(["not_started"]);
    expect(h.log.created).toEqual([]);
  });

  test("开跑通知发出去的那一下收回：通知照发了也不起 worker，随后补一条停止通知", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    h.inform.onSend = () => revoke(h);
    await h.tick();
    expect(h.noticeKinds()).toEqual(["start:o1", "stopped:o1"]);
    expect(h.log.created).toEqual([]);
    expect(getOrder(h.db, "o1")!.state).toBe("released");
  });

  test("worker 起了、首条派单前收回：不派单，停 worker", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "started", submit: null });
    revoke(h);
    await h.tick();
    expect(h.log.sent).toEqual([]);
    expect(h.log.killed).toEqual([W]);
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  });
});

describe("P1-2 收回即停：在跑的 worker 两个 pass 内全停（kill 并确认退出）", () => {
  test("started：下一个 pass 就 kill、确认退出、记 stopped，告诉 A stopped、告诉出借方已停；留了 W3 的口", async () => {
    const h = harness();
    await toStarted(h);
    revoke(h);
    await h.tick();
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("stopped");
    expect(isRevoked(row)).toBe(true);
    expect(h.log.killed).toEqual([W]);
    expect(h.registry.has(W)).toBe(false);
    expect(releases(h)).toEqual(["stopped"]);
    expect(h.noticeKinds()).toEqual(["start:o1", "stopped:o1"]);
    expect(h.log.notices.at(-1)!.why).toContain("收回");
  });

  test("kill 没确认退出：不记终态，下一个 pass 再停，确认后才 stopped", async () => {
    const h = harness();
    await toStarted(h);
    const real = h.d.worker.kill;
    let n = 0;
    h.d.worker.kill = async (name) => (++n === 1 ? { ok: false, reason: "窗口还在" } : real(name));
    revoke(h);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
    expect(n).toBe(2);
  });

  test("多张在跑的单一起收回：一个 pass 全停", async () => {
    const h = harness({ entry: { families: { codex: 3 } } });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: ["o1", "o2", "o3"].map((id) => ({ orderId: id, taskId: "T93", step: "review", family: "codex",
      repo: "shawnlu96/claudestra", pr: 270, head: "e".repeat(40), round: 1, specRev: 1, offeredAt: 1 })), pollAfterMs: 30_000 } });
    for (let i = 0; i < 5; i++) await h.tick();
    expect(["o1", "o2", "o3"].map((id) => getOrder(h.db, id)!.state)).toEqual(["started", "started", "started"]);
    revoke(h);
    await h.tick();
    expect(["o1", "o2", "o3"].map((id) => getOrder(h.db, id)!.state)).toEqual(["stopped", "stopped", "stopped"]);
    expect(h.registry.size).toBe(0);
  });

  test("result_pending（结论已落成交付正文）：停 worker，结论照常转交，拿到回执记 acked", async () => {
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    revoke(h);
    await h.tick();
    expect(h.log.killed).toContain(W);
    expect(h.calls.filter((c) => c.op === "result")).toHaveLength(1);
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    expect(h.noticeKinds()).toEqual(["start:o1", "acked:o1"]);
  });

  test("授权到期和收回一样处理", async () => {
    const h = harness();
    await toStarted(h);
    h.advanceTime(6 * 86_400_000);
    h.A.lease = (b) => ({ status: 200, body: { ok: true, v: 1, lease: b.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } });
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("到期") });
  });
});

describe("r1 审查：核对与效果之间的空档、建出 worker 后中断、授权范围收窄", () => {
  test("liveGrant 读联系人那一下收回：最后读的 lend.json 看得见，不 claim", async () => {
    const h = harness();
    await h.tick();
    let n = 0;
    const ctx = h.d.context;
    h.d.context = async () => { if (++n === 2) revoke(h); return ctx(); }; // 第 2 次是 claim 前的 liveGrant
    await h.tick();
    expect(h.ops()).not.toContain("claim");
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("declined");
  });

  test("起 worker 的准备工作（建项目、拿写锁）期间收回：真正起进程前的闸门拦下，不起，退回并补停止通知", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    const create = h.d.worker.create;
    h.d.worker.create = async (n, dir, p, gate) => { revoke(h); return create(n, dir, p, gate); };
    await h.tick();
    expect(h.log.created).toEqual([]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: expect.stringContaining("授权") });
    expect(releases(h)).toEqual(["not_started"]);
    expect(h.noticeKinds()).toEqual(["start:o1", "stopped:o1"]);
  });

  test("worker 已建出、还没记 started 时调度中断，之后收回：下一个 pass 就 kill 确认退出，记 stopped 并通知", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    const create = h.d.worker.create;
    h.d.worker.create = async (...a) => { await create(...a); throw new Error("scheduler interrupted after create"); };
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("cloned");
    expect(h.registry.has(W)).toBe(true);
    revoke(h);
    await h.tick();
    expect(h.log.killed).toEqual([W]);
    expect(h.registry.size).toBe(0);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("收回") });
    expect(releases(h)).toEqual(["stopped"]);
    expect(h.noticeKinds()).toEqual(["start:o1", "stopped:o1"]);
  });

  test("重授时拿掉了这张单的仓库 / 家族：cloned 不起 worker、退回；started 的停掉", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    h.lend.lend[0].repos = ["other/repo"];
    await h.tick();
    expect(h.log.created).toEqual([]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released", reason: expect.stringContaining("仓库") });
    const s = harness();
    await toStarted(s);
    s.lend.lend[0].families = { claude: 1 };
    await s.tick();
    expect(s.log.killed).toEqual([W]);
    expect(getOrder(s.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("codex 位") });
  });
});

describe("r2 审查：调度这边的闸门过了之后才收回", () => {
  test("闸门之后、宿主起来之前收回：调度这边已记 started，下一个 pass 就 kill 确认退出、记 stopped（外来任务不起，见 lend-watchdog「效果边界」）", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) await h.tick();
    const create = h.d.worker.create;
    h.d.worker.create = async (n, dir, p, gate) => create(n, dir, p, async () => { const no = await gate(); revoke(h); return no; });
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    await h.tick();
    expect(h.log.killed).toEqual([W]);
    expect(h.log.sent).toEqual([]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped", reason: expect.stringContaining("收回") });
  });
});
