/** T94 lend 循环（src/lib/lend-loop.ts + lend-drive.ts）：一次授权、重启恢复、心跳自停、前提不满足不 poll。A 与 worker 都是假的（tests/lend-harness.ts）。 */
import { describe, expect, test } from "bun:test";
import { BEAT_MS, detailOf, workerName } from "../src/lib/lend-drive.js";
import { MISS_GAP_MS } from "../src/lib/lend-health.js";
import { advance, getMeta, getOrder, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import { FP, HEAD, harness, polled, sha, TEXT, toStarted, wire } from "./lend-harness.js";

describe("i28-W1 一次授权（取代逐单确认）", () => {
  test("授权内：poll 到单直接 claim → clone → 开跑通知 → 起 worker → 首条派单（订单全文 + 本机尾注），不开确认", async () => {
    const h = harness();
    await toStarted(h);
    expect(h.ops().slice(0, 2)).toEqual(["poll", "claim"]);
    expect(h.noticeKinds()).toEqual(["start:o1"]);
    expect(h.log.created).toEqual([workerName("o1")]);
    expect(h.log.sent).toHaveLength(1);
    expect(h.log.sent[0]).toContain(TEXT);
    expect(getOrder(h.db, "o1")).toMatchObject({ submit: "sent", askId: null });
  });

  test("开跑通知没交出去：工作副本好了也不起 worker，下一轮补发交出去才起", async () => {
    const h = harness();
    h.inform.ok = false;
    for (let i = 0; i < 5; i++) await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "cloned", notices: null });
    expect(h.log.created).toEqual([]);
    h.inform.ok = true;
    await h.tick();
    expect(h.noticeKinds()).toEqual(["start:o1"]);
    expect(h.log.created).toEqual([workerName("o1")]);
    expect(typeof getOrder(h.db, "o1")!.notices!.start).toBe("number");
  });

  test("当天单数用完：第二张单不 claim", async () => {
    const h = harness({ entry: { ordersPerDay: 1 } });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o1"), polled("o2")], pollAfterMs: 30_000 } });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1"]);
  });

  test("出借总开关关了：还没 claim 的单放弃", async () => {
    const h = harness();
    await h.tick();
    h.lend.enabled = false;
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("declined");
    expect(h.ops()).not.toContain("claim");
  });

  test("升级前挂着逐单确认 ask 的单：有授权 → 关掉旧 ask、按授权 claim；没授权 → declined，写明要重新授权", async () => {
    const h = harness();
    recordAsked(h.db, { orderId: "o1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("o1") } });
    patchOrder(h.db, "o1", ["asked"], { askId: "ask_old1" });
    await h.tick();
    expect(h.log.retired).toEqual(["ask_old1"]);
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1"]);
    const g = harness();
    g.lend.lend = [];
    recordAsked(g.db, { orderId: "o9", peer: "team-a", fp: FP, family: "codex", preview: { ...polled("o9") } });
    patchOrder(g.db, "o9", ["asked"], { askId: "ask_old9" });
    await g.tick();
    expect(g.log.retired).toEqual(["ask_old9"]);
    expect(getOrder(g.db, "o9")).toMatchObject({ state: "declined", reason: expect.stringContaining("逐单确认已退役，请重新授权") });
  });
});

describe("T94 poll 状态", () => {
  test("poll 失败的原因在被节流跳过的下一轮仍记在 status 里（doctor 读）", async () => {
    const h = harness();
    h.A.poll = () => ({ status: 401, body: { ok: false, code: "unauthorized", error: "没签名" } });
    await h.tick();
    h.advanceTime(1_000);
    await h.tick();
    expect(h.ops()).toEqual(["poll"]);
    const st = JSON.parse(getMeta(h.db, "status")!);
    expect(st.peers["team-a"]).toMatchObject({ lastPollAt: 1_000_000, lastError: expect.stringContaining("unauthorized") });
  });
});

describe("T94 前提不满足不 poll", () => {
  test("环境里有代理变量：一次 poll 都不发", async () => {
    const h = harness({ env: { HTTPS_PROXY: "http://p:1" } });
    await h.tick();
    expect(h.calls).toEqual([]);
  });

  test("peer 没有 E2E 记录 / 没钉完整公钥：不 poll", async () => {
    for (const peer of [{ e2e: undefined }, { publicKey: undefined }]) {
      const h = harness({ peer });
      await h.tick();
      expect(h.calls).toEqual([]);
    }
  });

  test("30 秒内不重复 poll", async () => {
    const h = harness({ entry: { repos: ["other/repo"] } });
    await h.tick();
    await h.tick();
    expect(h.ops().filter((o) => o === "poll")).toHaveLength(1);
    h.advanceTime(30_000);
    await h.tick();
    expect(h.ops().filter((o) => o === "poll")).toHaveLength(2);
  });

  test("白名单外仓库、未授权家族拒收；旧 review 授权收写单", async () => {
    const h = harness();
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, pollAfterMs: 30_000,
      orders: [{ ...polled("x1"), repo: "evil/repo" }, { ...polled("x2"), family: "claude" }, { ...polled("x3"), step: "write" }] } });
    await h.tick();
    expect(getOrder(h.db, "x1")).toBeNull();
    expect(getOrder(h.db, "x2")).toBeNull();
    expect(getOrder(h.db, "x3")).toMatchObject({ state: "asked", preview: { step: "write" } });
  });
});

describe("T94 失败与释放", () => {
  test("clone / 核 head 失败：没起 worker，记 released 并向 A 报 not_started", async () => {
    const h = harness();
    h.d.clone = async () => ({ ok: false, reason: "HEAD 与订单 head 不一致" });
    for (let i = 0; i < 3; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(h.calls.find((c) => c.op === "lease" && c.body.action === "release")?.body).toMatchObject({ reason: "not_started" });
    expect(h.log.created).toEqual([]);
  });

  test("完整订单的 head 和挂单摘要对不上：领了也立刻按 not_started 退回", async () => {
    const h = harness();
    h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(), head: "f".repeat(40) }, text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released" });
    expect(h.log.created).toEqual([]);
  });

  test("派单全文的 sha256 对不上：当作没领成（结果不明），不 clone", async () => {
    const h = harness();
    h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: wire(), text: TEXT, sha256: sha("别的"), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
  });
});

describe("T94 重启恢复", () => {
  test("cloned 且 journal 记了 agent 名、registry 里已有它：认领，不建第二个 worker", async () => {
    const h = harness();
    recordAsked(h.db, { orderId: "o1", peer: "team-a", fp: FP, family: "codex", preview: { ...polled(), askQuota: "q" } }, 0);
    advance(h.db, "o1", "asked", "claimed", { wire: { order: wire(), text: TEXT }, leaseGen: 1, leaseUntil: 9e15, lastBeatAt: 1e6 });
    advance(h.db, "o1", "claimed", "cloned", { dir: "/lend/work/o1" });
    patchOrder(h.db, "o1", ["cloned"], { agent: workerName("o1") });
    h.registry.set(workerName("o1"), { sessionId: "thr-old", cwd: "/lend/work/o1" });
    await h.tick();
    expect(h.log.created).toEqual([]);
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "started", sessionId: "thr-old" });
  });

  test("首条派单停在 sending（发没发出去不明）：重启后不重发", async () => {
    const h = harness();
    await toStarted(h);
    patchOrder(h.db, "o1", ["started"], { submit: "sending" });
    await h.tick();
    await h.tick();
    expect(h.log.sent).toHaveLength(1);
  });

  test("result_pending：原样重发同一份请求体（逐字节相同），拿到回执才 acked", async () => {
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    let first = true;
    const real = h.A.result;
    h.A.result = (b) => (first ? ((first = false), "throw") : real(b));
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
    await h.tick();
    const sent = h.calls.filter((c) => c.op === "result").map((c) => JSON.stringify(c.body));
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(sent[1]).toBe(JSON.stringify(body));
    expect(getOrder(h.db, "o1")!.state).toBe("acked");
    expect(h.log.killed).toEqual([workerName("o1")]);
    expect(h.log.removed).toEqual(["o1"]);
    expect(h.log.receipts.map((r) => r.state)).toEqual(["acked"]);
  });

  test("A 已入账、回执丢了，重启时本机租约已过（r1 P2-1）：worker 照停，结论原样重发取回回执，记 acked", async () => {
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    const real = h.A.result;
    h.A.result = () => "throw"; // A 已入账，回包丢在路上
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("result_pending");
    h.A.result = real; // A 对同一 sha256 回旧回执，不看租约
    h.A.lease = () => ({ status: 409, body: { ok: false, v: 1, code: "conflict", error: "done" } });
    h.advanceTime(11 * 60_000);
    await h.tick();
    const row = getOrder(h.db, "o1")!;
    expect(row.state).toBe("acked");
    expect(row.receipt).toMatchObject({ orderId: "o1", eventSeq: 9 });
    expect(h.log.killed).toContain(workerName("o1"));
    expect(h.registry.has(workerName("o1"))).toBe(false);
  });

  test("result_pending 失了租约、A 明确拒收：按码收尾（不因为回执恢复而一直挂着）", async () => {
    const h = harness();
    await toStarted(h);
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    h.A.result = () => ({ status: 409, body: { ok: false, v: 1, code: "lease_expired", error: "过期" } });
    h.advanceTime(11 * 60_000);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
    expect(h.registry.has(workerName("o1"))).toBe(false);
  });

  test("终态之后收据写盘失败（r1 P2-2）：下一轮补写，只写一次", async () => {
    const h = harness();
    await toStarted(h);
    let fail = true;
    h.d.writeReceipt = async (row) => { if (fail) { fail = false; throw new Error("disk temporarily unavailable"); } h.log.receipts.push(row); };
    h.registry.delete(workerName("o1")); // worker 没了：两轮探测都否定才判死（i28-R5a）
    await h.tick();
    h.advanceTime(MISS_GAP_MS);
    const r = await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
    expect(r.failed.map((f) => f.error)).toEqual(["disk temporarily unavailable"]);
    await h.tick();
    await h.tick();
    expect(h.log.receipts.map((x) => [x.orderId, x.state])).toEqual([["o1", "stopped"]]);
    expect(getOrder(h.db, "o1")!.settle).toBeNull();
    expect(h.calls.filter((c) => c.op === "lease" && c.body.action === "release")).toHaveLength(1); // 已停的通知不因补写收据重发
  });

  test("进程在终态落库之后、通知 A 之前退出：重启后补发 stopped 通知、补写收据", async () => {
    const h = harness();
    await toStarted(h);
    advance(h.db, "o1", "started", "stopped", { reason: "worker 窗口没了", settle: { notify: "stopped", removeDir: false } });
    await h.tick();
    const rel = h.calls.filter((c) => c.op === "lease" && c.body.action === "release");
    expect(rel.map((c) => c.body.reason)).toEqual(["stopped"]);
    expect(h.log.receipts.map((x) => x.state)).toEqual(["stopped"]);
    expect(h.log.removed).toEqual([]); // stopped 保留现场
    expect(getOrder(h.db, "o1")!.settle).toBeNull();
  });

  test("回执验签不过：不算入账（stopped），保留工作副本", async () => {
    const h = harness();
    await toStarted(h);
    h.d.verifyReceipt = async () => false;
    const body = { v: 1, orderId: "o1", gen: 1, verdict: { v: 1 }, report: "r", session: { id: "thr-1", family: "codex" } };
    advance(h.db, "o1", "started", "result_pending", { payload: body, payloadSha: sha(JSON.stringify(body)) });
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
    expect(h.log.removed).toEqual([]);
  });
});

describe("T94 心跳", () => {
  test("每 60 秒续一次租", async () => {
    const h = harness();
    await toStarted(h);
    const renews = () => h.calls.filter((c) => c.op === "lease" && c.body.action === "renew").length;
    const before = renews();
    await h.tick();
    expect(renews()).toBe(before);
    h.advanceTime(BEAT_MS);
    await h.tick();
    expect(renews()).toBe(before + 1);
  });

  test("续租一直失败、过了租约截止：自停 worker（stopped），保留工作副本与 journal", async () => {
    const h = harness();
    await toStarted(h);
    h.A.lease = () => "throw";
    h.advanceTime(11 * 60_000);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "stopped" });
    expect(getOrder(h.db, "o1")!.reason).toContain("心跳过期");
    expect(h.log.killed).toEqual([workerName("o1")]);
    expect(h.log.removed).toEqual([]);
  });

  test("worker 没确认退出：不记终态，下一轮接着停，直到确认退出", async () => {
    const h = harness();
    await toStarted(h);
    h.A.lease = () => "throw";
    const realKill = h.d.worker.kill;
    h.d.worker.kill = async () => ({ ok: false, reason: "窗口还在" });
    h.advanceTime(11 * 60_000);
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("started");
    expect(h.log.receipts).toEqual([]);
    h.d.worker.kill = realKill;
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("stopped");
  });

  test("A 说租约已过期 / 撤单：停 worker；撤单记 cancelled", async () => {
    for (const [code, state] of [["lease_expired", "stopped"], ["cancelled", "cancelled"]] as const) {
      const h = harness();
      await toStarted(h);
      h.A.lease = () => ({ status: 409, body: { ok: false, code, error: code } });
      h.advanceTime(BEAT_MS);
      await h.tick();
      expect(getOrder(h.db, "o1")!.state).toBe(state);
      expect(h.log.killed).toEqual([workerName("o1")]);
    }
  });
});

describe("T94 release 的 detail（T93 wire：单行、≤ 500 字节）", () => {
  test("换行压成空格，按字节截、不切断汉字，空 = null", () => {
    expect(detailOf("a\nb\r\n c")).toBe("a b c");
    const long = detailOf("汉".repeat(400))!;
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(500);
    expect(long).toBe("汉".repeat(166));
    expect(detailOf("  ")).toBeNull();
    expect(detailOf(null)).toBeNull();
  });
});
