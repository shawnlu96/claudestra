/**
 * i28-W3 收单闸（src/lib/lend-inbox.ts admitOrders）：推送与轮询共用的唯一一道。每个核对项一正一反（授权的六种失效、家族、角色、写角色、仓库、
 * 今日单数、空位、Codex 暂停），外加重复推送、跨 peer 撞号、推送与轮询并发不超额、调度服务没在跑（lender_idle）、收单之后由下一个 pass 领。
 * A 与 worker 都是假的（tests/lend-harness.ts），时钟手拨。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultLendFile } from "../src/lib/lend-config.js";
import { admitOrders, LENDER_IDLE_MS, TICK_KEY } from "../src/lib/lend-inbox.js";
import { pauseForQuota } from "../src/lib/lend-health.js";
import { advance, getMeta, getOrder, localDay, openLendJournal, setMeta } from "../src/lib/lend-journal.js";
import { FP, harness, polled } from "./lend-harness.js";

const PEER = { peer: "team-a", fp: FP };

/** 收单入口眼里的调度服务一直在跑（lend 步刚开过一轮） */
function fresh(h: ReturnType<typeof harness>) {
  setMeta(h.db, TICK_KEY, String(h.d.now()));
  return h;
}

const one = async (h: ReturnType<typeof harness>, o: Record<string, unknown> = {}, caller = PEER, source: "push" | "poll" = "push") =>
  admitOrders(h.d, caller, [{ ...polled("o1"), ...o } as ReturnType<typeof polled>], source);

const refusedCode = (r: { refused: { code: string }[] }) => r.refused.map((x) => x.code);

describe("逐单核对：每项一正一反", () => {
  test("生效授权：在 → 收；没有 / 总开关关 / 暂停 / 过期 / 指纹变了 / 文件无效 → no_grant，一行不记", async () => {
    expect((await one(fresh(harness()))).accepted).toEqual(["o1"]);
    const cases: [string, (h: ReturnType<typeof harness>) => void][] = [
      ["没有", (h) => void (h.lend.lend = [])],
      ["关了", (h) => void (h.lend.enabled = false)],
      ["暂停", (h) => void (h.lend.lend[0].paused = { reason: "出借方暂停" })],
      ["过期", (h) => void (h.lend.lend[0].until = new Date(h.d.now() - 1).toISOString())],
      ["指纹变了", (h) => void (h.lend.lend[0].fp = "ffff-ffff-ffff-ffff")],
      ["文件无效", (h) => void (h.d.readLend = async () => ({ status: "invalid", error: "坏了", file: defaultLendFile() }))],
    ];
    for (const [why, mut] of cases) {
      const h = fresh(harness());
      mut(h);
      expect([why, refusedCode(await one(h))]).toEqual([why, ["no_grant"]]);
      expect(getOrder(h.db, "o1")).toBeNull();
    }
  });

  test("调用方指纹不是授权里的那把 → no_grant", async () => {
    const h = fresh(harness());
    expect(refusedCode(await one(h, {}, { peer: "team-a", fp: "0000-0000-0000-0000" }))).toEqual(["no_grant"]);
    expect(refusedCode(await one(h, {}, { peer: "team-a", fp: null as unknown as string }))).toEqual(["no_grant"]);
  });

  test("家族：codex 收；claude 一律拒（family）", async () => {
    expect((await one(fresh(harness({ entry: { families: { codex: 2, claude: 2 } } })))).accepted).toEqual(["o1"]);
    expect(refusedCode(await one(fresh(harness({ entry: { families: { codex: 2, claude: 2 } } })), { family: "claude" }))).toEqual(["family"]);
  });

  test("角色：审查收；授权里没写 write 的开工 / 修复单、不认识的阶段 → role；写了 write 才收；写单开关关着：写单 write_closed、含 write 的授权整条不生效", async () => {
    expect(refusedCode(await one(fresh(harness()), { step: "write" }))).toEqual(["role"]); // 生产缺省（开关开着）也要授权里写了 write
    expect(refusedCode(await one(fresh(harness()), { step: "fix" }))).toEqual(["role"]);
    expect(refusedCode(await one(fresh(harness()), { step: "deploy" }))).toEqual(["role"]);
    const w = { entry: { roles: ["review", "write"] as ("review" | "write")[] } };
    expect((await one(fresh(harness(w)), { step: "write" })).accepted).toEqual(["o1"]);
    expect((await one(fresh(harness(w)), { step: "fix" })).accepted).toEqual(["o1"]);
    expect(refusedCode(await one(fresh(harness({ ...w, writeOpen: false })), { step: "write" }))).toEqual(["no_grant"]);
    expect(refusedCode(await one(fresh(harness({ writeOpen: false })), { step: "fix" }))).toEqual(["write_closed"]);
  });

  test("仓库白名单：在 → 收；不在 → repo", async () => {
    expect(refusedCode(await one(fresh(harness()), { repo: "someone/else" }))).toEqual(["repo"]);
    expect((await one(fresh(harness({ entry: { repos: ["shawnlu96/claudestra", "someone/else"] } })), { repo: "someone/else" })).accepted).toEqual(["o1"]);
  });

  test("今日单数：claim 过的和已接下没领的都算；用完 → daily", async () => {
    const h = fresh(harness({ entry: { ordersPerDay: 2, families: { codex: 5 } } }));
    const r = await admitOrders(h.d, PEER, [polled("o1"), polled("o2"), polled("o3")], "push");
    expect(r).toEqual({ accepted: ["o1", "o2"], refused: [{ orderId: "o3", code: "daily" }] });
    advance(h.db, "o1", "asked", "claimed", { day: localDay(h.d.now()), leaseGen: 1 });
    expect(refusedCode(await admitOrders(h.d, PEER, [polled("o4")], "push"))).toEqual(["daily"]);
  });

  test("空位：已接下、还没领的 asked 也占位；满了 → no_slot", async () => {
    const h = fresh(harness({ entry: { families: { codex: 1 } } }));
    expect(await admitOrders(h.d, PEER, [polled("o1"), polled("o2")], "push")).toEqual({ accepted: ["o1"], refused: [{ orderId: "o2", code: "no_slot" }] });
    expect(refusedCode(await admitOrders(h.d, PEER, [polled("o3")], "poll"))).toEqual(["no_slot"]);
  });

  test("本机 Codex 撞额度暂停中 → paused；到点之后照收", async () => {
    const h = fresh(harness());
    pauseForQuota(h.db, "o0", { observedAt: 1, full: true, resetsAt: h.d.now() + 60_000 }, h.d.now(), () => {});
    expect(refusedCode(await one(h))).toEqual(["paused"]);
    h.advanceTime(61_000);
    fresh(h);
    expect((await one(h)).accepted).toEqual(["o1"]);
  });
});

describe("重复与撞号", () => {
  test("同 peer 同号重推：活行 → accepted，不插第二行；已是终态 → closed", async () => {
    const h = fresh(harness());
    await one(h);
    const before = getOrder(h.db, "o1");
    expect(await one(h)).toEqual({ accepted: ["o1"], refused: [] });
    expect(getOrder(h.db, "o1")).toEqual(before);
    expect((h.db.query("SELECT COUNT(*) AS n FROM lend_orders").get() as { n: number }).n).toBe(1);
    advance(h.db, "o1", "asked", "declined", { reason: "x" });
    expect(refusedCode(await one(h))).toEqual(["closed"]);
  });

  test("同号属于别的 peer → id_conflict，那一行一字不动", async () => {
    const h = fresh(harness());
    h.lend.lend.push({ ...h.lend.lend[0], peer: "team-b" });
    h.d.context = async () => ({ contacts: [{ name: "team-a", fp: FP }, { name: "team-b", fp: FP }], projects: [] });
    await one(h);
    const before = getOrder(h.db, "o1");
    expect(await one(h, {}, { peer: "team-b", fp: FP })).toEqual({ accepted: [], refused: [{ orderId: "o1", code: "id_conflict" }] });
    expect(getOrder(h.db, "o1")).toEqual(before);
  });
});

describe("并发、时机与来源", () => {
  test("推送与轮询同时到（两个连接同一个 journal 文件）：合计不超过空位", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lend-inbox-"));
    try {
      const path = join(dir, "journal.sqlite");
      const a = fresh(harness({ entry: { families: { codex: 2 } } }));
      const pushDb = openLendJournal(path);
      const pollDb = openLendJournal(path);
      setMeta(pushDb, TICK_KEY, String(a.d.now()));
      const [p, q] = await Promise.all([
        admitOrders({ ...a.d, db: pushDb }, PEER, [polled("p1"), polled("p2")], "push"),
        admitOrders({ ...a.d, db: pollDb }, PEER, [polled("q1"), polled("q2")], "poll"),
      ]);
      expect(p.accepted.length + q.accepted.length).toBe(2);
      expect((pushDb.query("SELECT COUNT(*) AS n FROM lend_orders").get() as { n: number }).n).toBe(2);
      pushDb.close();
      pollDb.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("收回写盘之后才到的推送不收（每次现读 lend.json）", async () => {
    const h = fresh(harness());
    expect((await one(h)).accepted).toEqual(["o1"]);
    h.lend.lend = [];
    expect(refusedCode(await admitOrders(h.d, PEER, [polled("o2")], "push"))).toEqual(["no_grant"]);
  });

  test("调度服务的 lend 步超过 90 秒没开过一轮：推来的全拒 lender_idle；轮询不看这一条", async () => {
    const h = fresh(harness());
    h.advanceTime(LENDER_IDLE_MS + 1);
    expect(refusedCode(await admitOrders(h.d, PEER, [polled("o1"), polled("o2")], "push"))).toEqual(["lender_idle", "lender_idle"]);
    expect((await one(h, {}, PEER, "poll")).accepted).toEqual(["o1"]);
    const g = harness(); // 从没跑过
    expect(refusedCode(await one(g))).toEqual(["lender_idle"]);
  });

  test("来源记进 preview.source；每次推送（拒收的也算）记 pushAt:<peer>", async () => {
    const h = fresh(harness());
    await one(h);
    await admitOrders(h.d, PEER, [polled("o2")], "poll");
    expect(getOrder(h.db, "o1")!.preview.source).toBe("push");
    expect(getOrder(h.db, "o2")!.preview.source).toBe("poll");
    expect(Number(getMeta(h.db, "pushAt:team-a"))).toBe(h.d.now());
    h.lend.lend = [];
    h.advanceTime(1000);
    fresh(h);
    await admitOrders(h.d, PEER, [polled("o3")], "push");
    expect(Number(getMeta(h.db, "pushAt:team-a"))).toBe(h.d.now());
  });
});

describe("收单即领：bridge 不 claim，下一个 pass 领", () => {
  test("推来的 asked 由下一轮 claim；收单和 claim 之间重启（换一套依赖、同一个 journal）照样领", async () => {
    const h = fresh(harness());
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    await one(h);
    expect(h.ops()).toEqual([]);
    const restarted = { ...h.d }; // 进程重启：依赖重建，journal 还是那一份
    const { lendTick } = await import("../src/lib/lend-loop.js");
    await lendTick(restarted);
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1"]);
    expect(getOrder(h.db, "o1")!.state).toBe("claimed");
  });

  test("A 已按推送 TTL 撤回：claim 拿到 cancelled → declined，不起 worker", async () => {
    const h = fresh(harness());
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [], pollAfterMs: 30_000 } });
    h.A.claim = () => ({ status: 409, body: { ok: false, code: "cancelled", error: "推送超时撤回" } });
    await one(h);
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "declined", reason: expect.stringContaining("cancelled") });
    for (let i = 0; i < 3; i++) await h.tick();
    expect(h.log.created).toEqual([]);
  });
});
