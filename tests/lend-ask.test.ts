/** 出借单的台账写入（src/lib/lend-ask.ts、src/manager/ledger-lend-ask-cmd.ts）：参数形状、关升级前遗留的逐单确认 ask、通知 owner、关 worker 的 Codex 卡 */
import { afterEach, describe, expect, test } from "bun:test";
import { getAsk, openAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { lendAskProblem, RETIRED_REASON, type LendAskParams } from "../src/lib/lend-ask.js";
import type { LendNoticeParams } from "../src/lib/lend-notice.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { runLedger } from "../src/manager/ledger.js";

const P: LendAskParams = {
  orderId: "int_abc:1", peer: "team-a", fp: "abcd-ef01-2345-6789", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: "c".repeat(40),
  taskId: "T93", step: "review", quota: "今天第 1/5 单，codex 位 0/2",
};
const N: LendNoticeParams = { ...P, kind: "start", why: null };
const T0 = 1_000_000;

afterEach(() => closeLedger(":memory:"));

const cli = (db: ReturnType<typeof openLedger>, actor: string, args: string[], extra: Record<string, unknown> = {}) => runLedger(args, {
  db, actor, projectIds: [], now: () => T0 + 1, loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, ...extra,
}) as Promise<Record<string, unknown>>;

/** 升级前调度服务开的逐单确认 ask 的样子（bind.action lend_claim） */
const legacyAsk = (db: ReturnType<typeof openLedger>) => openAsk(db, {
  project: "master", source: "system", kind: "authorize", fromAgent: "scheduler", title: "出借确认：team-a 想借一个 Codex 位",
  bind: { action: "lend_claim", params: {}, approve: ["lend_claim_approve"], paramsHash: "x" },
}, T0).id;

describe("参数形状", () => {
  test("多字段、非完整 SHA、带换行的额度文字、坏仓库名都拒；调用方声明的附加字段放行", () => {
    expect(lendAskProblem(P)).toBeNull();
    expect(lendAskProblem({ ...P, x: 1 })).toMatch(/不认识/);
    expect(lendAskProblem({ ...P, kind: "start" })).toMatch(/不认识/);
    expect(lendAskProblem({ ...P, kind: "start" }, ["kind"])).toBeNull();
    expect(lendAskProblem({ ...P, head: "abc" })).toMatch(/head/);
    expect(lendAskProblem({ ...P, quota: "a\nb" })).toMatch(/quota/);
    expect(lendAskProblem({ ...P, repo: "../x" })).toMatch(/repo/);
  });
});

describe("i28-W1 逐单确认退役：ledger lend-ask --retire 关升级前遗留的确认卡", () => {
  test("关掉 lend_claim ask（原因写改为一次授权）；重复调、卡已不在都无害；别的卡拒、不动", async () => {
    const db = openLedger(":memory:");
    const id = legacyAsk(db);
    const other = openAsk(db, { project: "master", source: "system", kind: "decide", fromAgent: "scheduler", title: "别的卡" }, T0).id;
    expect(await cli(db, "scheduler", ["lend-ask", "--retire", id])).toMatchObject({ ok: true });
    expect(getAsk(db, id)).toMatchObject({ state: "cancelled" });
    expect(JSON.stringify(db.query("SELECT data FROM events WHERE kind = 'ask_cancel'").all())).toContain(RETIRED_REASON);
    expect(await cli(db, "scheduler", ["lend-ask", "--retire", id])).toMatchObject({ ok: true });
    expect(await cli(db, "scheduler", ["lend-ask", "--retire", "ask_gone"])).toMatchObject({ ok: true });
    expect(await cli(db, "scheduler", ["lend-ask", "--retire", other])).toMatchObject({ ok: false, code: "invalid" });
    expect(getAsk(db, other)!.state).toBe("open");
  });

  test("不再开新卡：旧的 --params 用法拒；不是调度服务身份拒", async () => {
    const db = openLedger(":memory:");
    const id = legacyAsk(db);
    expect(await cli(db, "scheduler", ["lend-ask", "--params", JSON.stringify(P)])).toMatchObject({ ok: false });
    expect(await cli(db, "owner", ["lend-ask", "--retire", id])).toMatchObject({ ok: false, code: "forbidden" });
    expect((db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n).toBe(1);
    expect(getAsk(db, id)!.state).toBe("open");
  });

  test("拿到写锁后核租约不过（等锁期间失租）：不关，报 lease-lost", async () => {
    const db = openLedger(":memory:");
    const id = legacyAsk(db);
    let calls = 0;
    const r = await cli(db, "scheduler", ["lend-ask", "--retire", id], { assertLease: () => { if (++calls > 1) throw new SchedulerLeaseLost("lost"); } });
    expect(r).toMatchObject({ ok: false, code: "lease-lost" });
    expect(calls).toBe(2);
    expect(getAsk(db, id)!.state).toBe("open");
  });
});

describe("i28-W1 给出借方 owner 的通知（ledger lend-inform）", () => {
  const run = (actor: string, params: unknown, notifyOwner?: (t: string) => Promise<boolean>) =>
    cli(openLedger(":memory:"), actor, ["lend-inform", "--params", JSON.stringify(params)], notifyOwner ? { notifyOwner } : {});

  test("只给调度服务身份；送到 = notified:true，没通道 / bridge 没收下 = notified:false", async () => {
    const sent: string[] = [];
    expect(await run("owner", N, async (t) => { sent.push(t); return true; })).toMatchObject({ ok: false });
    expect(await run("agent-lend-0123456789", N, async (t) => { sent.push(t); return true; })).toMatchObject({ ok: false });
    expect(sent).toEqual([]);
    expect(await run("scheduler", N, async (t) => { sent.push(t); return true; })).toMatchObject({ ok: true, notified: true });
    expect(sent).toHaveLength(1);
    expect(await run("scheduler", N)).toMatchObject({ ok: true, notified: false });
    expect(await run("scheduler", N, async () => false)).toMatchObject({ ok: true, notified: false });
  });

  test("参数：kind 只认 start / acked / stopped，why 是一行字；不认识的字段拒", async () => {
    const ok = async () => true;
    expect(await run("scheduler", { ...N, kind: "paused" }, ok)).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("scheduler", { ...N, kind: "stopped", why: "a\nb" }, ok)).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("scheduler", { ...N, extra: 1 }, ok)).toMatchObject({ ok: false, code: "invalid" });
    expect(await run("scheduler", { ...N, kind: "stopped", why: "出借授权已收回" }, ok)).toMatchObject({ ok: true, notified: true });
  });
});

describe("i28-R5a 出借单结束后关 worker 的 Codex 卡（ledger lend-close-asks）", () => {
  const W = "agent-lend-0123456789";
  function seeded() {
    const db = openLedger(":memory:");
    const card = (fromAgent: string, source: "codex" | "permission", title: string) =>
      openAsk(db, { project: "lend", fromAgent, fromChannelId: "local-x", source, kind: "decide", title, extra: source === "codex" ? { quota: true } : {} }, T0).id;
    return { db, mine: card(W, "codex", "Codex 额度用完了"), perm: card(W, "permission", "要跑 rm 吗"), other: card("agent-lend-9999999999", "codex", "Codex 额度用完了") };
  }
  const run = (db: ReturnType<typeof openLedger>, actor: string, assertLease?: () => void) => runLedger(["lend-close-asks", "--agent", W], {
    db, actor, projectIds: [], now: () => T0 + 1, loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {},
    ...(assertLease ? { assertLease } : {}),
  }) as Promise<Record<string, unknown>>;

  test("只关这个 worker 开的 Codex 卡；权限卡、别的 worker 的卡不动", async () => {
    const { db, mine, perm, other } = seeded();
    expect(await run(db, "scheduler")).toMatchObject({ ok: true, closed: [mine] });
    expect([getAsk(db, mine)!.state, getAsk(db, perm)!.state, getAsk(db, other)!.state]).toEqual(["cancelled", "open", "open"]);
    expect(await run(db, "scheduler")).toMatchObject({ ok: true, closed: [] }); // 重复调无害
  });

  test("不是调度服务身份：拒绝", async () => {
    const { db, mine } = seeded();
    expect(await run(db, "owner")).toMatchObject({ ok: false, code: "forbidden" });
    expect(getAsk(db, mine)!.state).toBe("open");
  });

  test("拿到写锁后核租约不过（等锁期间失租）：一张都不关，报 lease-lost", async () => {
    const { db, mine } = seeded();
    let calls = 0;
    const r = await run(db, "scheduler", () => { if (++calls > 1) throw new SchedulerLeaseLost("lost"); }); // 第 1 次是 runLedger 入口，第 2 次在事务里
    expect(r).toMatchObject({ ok: false, code: "lease-lost" });
    expect(calls).toBe(2);
    expect(getAsk(db, mine)!.state).toBe("open");
  });
});
