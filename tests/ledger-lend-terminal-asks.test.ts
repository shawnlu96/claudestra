/**
 * followup-reliability-ASKT：出借单结清（done / cancelled / released）后，这一单 worker 经 lend/ask 开的旧提问在同一事务里关闭；
 * claimed / unknown、别的单 / 别的 peer / owner 审批 / 本机提问不动；结清后新问被拒；事务回滚只关一次；历史回收 lend-terminal-asks 先预览后 apply。
 * 全部跑临时文件 SQLite，出借状态经 `ledger lend-*` CLI（runLedger），提问经 openOrderAsk（远端 lend/ask 同一入口）开。
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { closeAsk, getAsk, openAsk, openAskFull, type Ask } from "../src/lib/ledger-asks.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { SettledAskClosure } from "../src/lib/order-ask-terminal.js";
import { SchedulerLeaseLost } from "../src/lib/scheduler-lease-env.js";
import { openOrderAsk } from "../src/lib/order-ask.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const H = "a".repeat(40);
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const MIN = 60_000;
const SECRET_Q = "这条问句原文不该出现在回收预览里-QX9";
let db: Database;
let path: string;
let now: number;
let borrow: BorrowEntry[];
let remote: Record<string, RemoteHead>;
const dir = mkdtempSync(join(tmpdir(), "lend-askt-test-"));
const key = instanceKeySync(dir);

const deps = (actor: string, extra: { now?: () => number; assertLease?: () => void } = {}) => ({
  db, actor, assertLease: extra.assertLease, projectIds: [P, "other-proj"], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {},
  now: extra.now ?? (() => now),
  lend: {
    borrow: async () => borrow,
    notifyPm: async () => {},
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
      remoteHead: async (_r: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown, peer = "mate") => run([`lend-${ep}`, "--", peer, JSON.stringify(body)], "owner");
/** build 阶段的卡挂出去是开工单（远端 worker 只在写单上提问；审查单上的提问当场回规则，不开 ask） */
const offer = (task = "T9") => run(["lend-offer", task, "--peer", "mate", "--repo", REPO]);
const W = (n: number) => `agent-lend-000000000${n}`;
const claim = (orderId: string, worker = W(1)) => call("claim", { v: 1, orderId, worker });
const lease = (orderId: string, gen: number, action = "renew", reason: string | null = null) => call("lease", { v: 1, orderId, gen, action, reason, detail: null });
const verdict = (orderId: string) => ({
  v: 1, orderId, gen: 1, report: "## 结论\n没问题", session: { id: "sess-1", family: "codex" },
  verdict: { v: 1, orderId, head: H, verdict: "pass", p0: 0, p1: 0, p2: 0, findings: [], reportPath: "report.md" },
});
const delivery = (orderId: string, task = "T9") => ({ v: 1, orderId, gen: 1, branch: `lend/${task}-abcd`, pr: 7, session: { id: "sess-1", family: "codex" },
  deliver: { v: 1, orderId, head: H2, evidence: `lend/${task}-abcd`, summary: "做完", selfCheck: "逐条对了" } });

/** 远端 worker 的提问：和 bridge 的 remoteAsk 同一入口（openOrderAsk），beforeWrite 透传给 openAskFull */
async function workerAsk(orderId: string, worker = W(1), peer = "mate", q = SECRET_Q): Promise<Record<string, any>> {
  const taskId = orderId.split(":")[1] as string;
  return openOrderAsk(db, {
    open: (input, beforeWrite) => openAskFull(db, input, now, { beforeWrite }), notify: async () => ({ handed: true, note: "ok" }),
    markHanded: () => {}, record: () => {},
  }, { task: getTask(db, taskId)!, orderId, from: `${worker}@${peer}`, keyPrefix: "lend-ask:g1" }, { question: q, options: [] }) as Promise<Record<string, any>>;
}
async function askId(orderId: string, worker = W(1), q = SECRET_Q): Promise<string> {
  const r = await workerAsk(orderId, worker, "mate", q);
  expect(r.askId).toEqual(expect.any(String));
  return r.askId;
}
const state = (id: string) => getAsk(db, id)!.state;
const cancels = () => (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'ask_cancel'").get() as { n: number }).n;
const openAsks = () => (db.query("SELECT COUNT(*) AS n FROM asks WHERE state = 'open'").get() as { n: number }).n;
const status = (task = "T9") => listLendOrders(db, task).at(-1)!.status;

function card(id: string, stage = "build"): void {
  const spec = join(dir, `${id}.md`);
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  createTask(db, { actor: "owner", now }, { project: P, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
  db.run(stage === "review" ? `UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = '${id}'` : `UPDATE tasks SET stage = '${stage}', round = 0 WHERE id = '${id}'`);
}

/** 不该动的几类：同 orderId 但别的 peer 开的、owner 审批、同卡本机 agent 的提问 */
function bystanders(orderId: string): Record<string, string> {
  const base = { project: P, taskId: "T9", source: "reply" as const, kind: "decide" as const, title: "x" };
  return {
    otherPeer: openAsk(db, { ...base, fromAgent: `${W(1)}@stranger`, extra: { via: "mcp_ask", orderId } }, now).id,
    owner: openAsk(db, { ...base, source: "human", kind: "authorize", createdBy: "local:owner", extra: { orderId } }, now).id,
    local: openAsk(db, { ...base, fromAgent: "agent-dev", extra: { via: "mcp_ask", orderId: "int_local:1" } }, now).id,
  };
}

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "lend-askt-db-")), "ledger.sqlite");
  db = openLedger(path);
  now = 1_000_000;
  remote = { main: { ok: true, head: BASE } };
  borrow = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 5 }];
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  card("T9");
});
afterEach(() => closeLedger(path));

describe("结清点自动关旧提问", () => {
  test("开工单交付 done：只关这一单 worker 的 open 提问，正文 / 历史保留、不算作答；claimed 时不关；别的单 / peer / owner / 本机不动；重发回原回执", async () => {
    const { orderId } = await offer();
    await claim(orderId);
    card("T10");
    const other = await offer("T10");
    await claim(other.orderId, W(2));
    const mine = await askId(orderId);
    const otherOrder = await askId(other.orderId, W(2));
    const by = bystanders(orderId);
    await lease(orderId, 1); // 还在 claimed：续租不关
    expect(state(mine)).toBe("open");

    remote[BR] = { ok: true, head: H2 };
    const r = await call("write", delivery(orderId));
    expect(r).toMatchObject({ ok: true });
    expect(status()).toBe("done");
    expect(getAsk(db, mine)).toMatchObject({ state: "cancelled", answer: null, body: SECRET_Q, extra: expect.objectContaining({ via: "mcp_ask", orderId,
      settledOrder: { orderId, status: "done", by: "lend" } }) });
    expect(JSON.stringify(db.query("SELECT text FROM events WHERE kind = 'ask_cancel'").all())).toContain(`出借单 ${orderId} 已结清（done）`);
    expect(db.query("SELECT 1 FROM events WHERE kind = 'ask' AND json_extract(data, '$.askId') = ?").get(mine)).toBeTruthy(); // 开提问的事件还在
    expect([state(otherOrder), state(by.otherPeer), state(by.owner), state(by.local)]).toEqual(["open", "open", "open", "open"]);
    const n = cancels();
    expect((await call("write", delivery(orderId))).receipt).toEqual(r.receipt);
    expect(cancels()).toBe(n);
  });

  test("审查单结论 done 也走同一收尾（精确绑定的 mcp_ask 行；审查单本身的提问不开 ask）", async () => {
    card("T20", "review");
    const { orderId } = await run(["lend-offer", "T20", "--peer", "mate", "--repo", REPO, "--pr", "12"]);
    await claim(orderId, "w1");
    expect(await workerAsk(orderId, "w1")).toMatchObject({ answered: expect.any(String) });
    const bound = openAsk(db, { project: P, taskId: "T20", source: "reply", kind: "decide", title: "x", fromAgent: "w1@mate", extra: { via: "mcp_ask", orderId } }, now).id;
    const r = await call("write", verdict(orderId));
    expect(r.ok).toBe(true);
    expect(getAsk(db, bound)!.extra.settledOrder).toEqual({ orderId, status: "done", by: "lend" });
    const n = cancels();
    expect((await call("write", verdict(orderId))).receipt).toEqual(r.receipt);
    expect(cancels()).toBe(n);
  });

  test("撤单、重挂（unknown → cancelled）、没起 worker 释放都关；报停（stopped）与租约过期的 unknown 不关", async () => {
    const a = await offer();
    await claim(a.orderId);
    const q1 = await askId(a.orderId);
    expect(await run(["lend-cancel", "T9", "--reason", "换人做"])).toMatchObject({ ok: true, status: "cancelled" });
    expect(getAsk(db, q1)!.extra.settledOrder).toEqual({ orderId: a.orderId, status: "cancelled", by: "lend" });

    const b = await offer();
    expect(b.ok).toBe(true);
    await claim(b.orderId, W(2));
    const q2 = await askId(b.orderId, W(2));
    await lease(b.orderId, 1, "release", "stopped");
    expect(status()).toBe("unknown");
    expect(state(q2)).toBe("open"); // 结果不明：不靠猜关
    expect((await run(["lend-reoffer", "T9", "--peer", "mate", "--repo", REPO, "--reason", "核对过对方已停"])).ok).toBe(true);
    expect(getAsk(db, q2)!.extra.settledOrder).toMatchObject({ orderId: b.orderId, status: "cancelled" });

    const c = listLendOrders(db, "T9").at(-1)!;
    await claim(c.orderId, W(3));
    const q3 = await askId(c.orderId, W(3));
    now += 11 * MIN;
    await run(["lend-sweep"], "owner");
    expect(status()).toBe("unknown");
    expect(state(q3)).toBe("open");
    await run(["lend-cancel", "T9", "--reason", "PM 核对"]);
    expect(state(q3)).toBe("cancelled");

    const d = await offer();
    await claim(d.orderId, W(4));
    const q4 = await askId(d.orderId, W(4));
    expect((await lease(d.orderId, 1, "release", "not_started")).ok).toBe(true);
    expect(status()).toBe("released");
    expect(getAsk(db, q4)!.extra.settledOrder).toMatchObject({ orderId: d.orderId, status: "released" });
  });

  test("结清后的新问（含同一问题重试）被拒、不留 open 行；claimed 时照常开、重试只一条", async () => {
    const { orderId } = await offer();
    await claim(orderId);
    expect(await workerAsk(orderId, W(1), "mate", "第一问")).toMatchObject({ duplicate: false });
    const events0 = (db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'ask'").get() as { n: number }).n;
    expect(await workerAsk(orderId, W(1), "mate", "第一问")).toMatchObject({ duplicate: true });
    expect((db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'ask'").get() as { n: number }).n).toBe(events0);
    await run(["lend-cancel", "T9", "--reason", "不要了"]);
    const before = (db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n;
    expect(await workerAsk(orderId, W(1), "mate", "第一问")).toMatchObject({ code: "not_held", refused: expect.stringContaining("已结清（cancelled）") });
    expect(await workerAsk(orderId, W(1), "mate", "新问")).toMatchObject({ code: "not_held", refused: expect.stringContaining("不再收提问") });
    expect((db.query("SELECT COUNT(*) AS n FROM asks").get() as { n: number }).n).toBe(before);
    expect(openAsks()).toBe(0);
  });

  test("关闭写失败整笔回滚（交付不入账、提问仍开）；签不出回执也不关；修好后重发只关一次；重开库再收一次也不重复", async () => {
    const { orderId } = await offer();
    await claim(orderId);
    const q = await askId(orderId);
    remote[BR] = { ok: true, head: H2 };
    db.run("CREATE TRIGGER fail_cancel BEFORE INSERT ON events WHEN NEW.kind = 'ask_cancel' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const bad = await call("write", delivery(orderId));
    expect(bad.ok).toBe(false);
    expect(listLendOrders(db, "T9")[0]).toMatchObject({ status: "claimed", resultSha: null });
    expect(state(q)).toBe("open");
    db.run("DROP TRIGGER fail_cancel");
    const noKey = { ...deps("owner"), lend: { ...deps("owner").lend, result: { ...deps("owner").lend.result, sign: () => null } } };
    expect(await runLedger(["lend-write", "--", "mate", JSON.stringify(delivery(orderId))], noKey)).toMatchObject({ ok: false });
    expect(state(q)).toBe("open");
    const good = await call("write", delivery(orderId));
    expect(good.ok).toBe(true);
    expect(cancels()).toBe(1);
    closeLedger(path);
    db = openLedger(path);
    expect((await call("write", delivery(orderId))).receipt).toEqual(good.receipt);
    expect((await run(["lend-terminal-asks", "--project", P, "--apply"])).closed).toEqual([]);
    expect(cancels()).toBe(1);
  });
});

describe("历史回收 ledger lend-terminal-asks", () => {
  /** 修复前留下的样子：单子已结清，提问还开着（直接写状态，模拟旧代码的结清） */
  async function legacy() {
    const settle = (orderId: string, to: string) => db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [to, orderId]);
    const a = await offer(); await claim(a.orderId);
    const done = await askId(a.orderId);
    const peerMismatch = openAsk(db, { project: P, taskId: "T9", source: "reply", kind: "decide", title: "x", fromAgent: `${W(1)}@stranger`, extra: { via: "mcp_ask", orderId: a.orderId } }, now).id;
    settle(a.orderId, "done");
    card("T10"); const b = await offer("T10"); await claim(b.orderId, W(2));
    const cancelled = await askId(b.orderId, W(2));
    settle(b.orderId, "cancelled");
    card("T11"); const c = await offer("T11"); await claim(c.orderId, W(3));
    const unknown = await askId(c.orderId, W(3));
    settle(c.orderId, "unknown");
    card("T12"); const d = await offer("T12"); await claim(d.orderId, W(4));
    const claimed = await askId(d.orderId, W(4));
    const local = openAsk(db, { project: P, taskId: "T9", source: "reply", kind: "decide", title: "x", fromAgent: "agent-dev", extra: { via: "mcp_ask", orderId: "int_x:1" } }, now).id;
    const owner = openAsk(db, { project: P, taskId: "T9", source: "human", kind: "authorize", title: "x", createdBy: "local:owner", extra: { orderId: a.orderId } }, now).id;
    const foreign = openAsk(db, { project: "other-proj", taskId: "T9", source: "reply", kind: "decide", title: "x", fromAgent: `${W(1)}@mate`, extra: { via: "mcp_ask", orderId: a.orderId } }, now).id;
    return { done, cancelled, unknown, claimed, peerMismatch, local, owner, foreign, doneOrder: a.orderId };
  }

  test("dry-run 只列 askId / 单号 / 状态 / 原因，不带问句；不写库", async () => {
    const ids = await legacy();
    const n = cancels();
    const r = await run(["lend-terminal-asks", "--project", P]);
    expect(r).toMatchObject({ ok: true, apply: false, project: P });
    expect(r.closable.map((x: { askId: string }) => x.askId).sort()).toEqual([ids.done, ids.cancelled].sort());
    expect(r.closable.find((x: { askId: string }) => x.askId === ids.done)).toMatchObject({ orderId: ids.doneOrder, status: "done", reason: expect.stringContaining("已结清（done）") });
    const kept = Object.fromEntries(r.kept.map((x: { askId: string; reason: string }) => [x.askId, x.reason]));
    expect(kept[ids.unknown]).toContain("unknown");
    expect(kept[ids.claimed]).toContain("claimed");
    expect(kept[ids.peerMismatch]).toContain("worker@peer");
    for (const id of [ids.local, ids.owner, ids.foreign]) expect(kept[id]).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(SECRET_Q);
    expect(cancels()).toBe(n);
    for (const id of [ids.done, ids.cancelled, ids.unknown, ids.claimed, ids.peerMismatch, ids.local, ids.owner, ids.foreign]) expect(state(id)).toBe("open");
  });

  test("--apply 在写锁内重核后关闭；预览后变了的以此刻为准；再 apply 无事；不是 PM 拒", async () => {
    const ids = await legacy();
    expect(await run(["lend-terminal-asks", "--project", P, "--apply"], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(["lend-terminal-asks", "--project", P], "agent-x")).toMatchObject({ ok: false, code: "forbidden" });
    db.run("UPDATE lend_orders SET status = 'claimed' WHERE taskId = 'T10'"); // 预览之后单子变了：apply 以此刻为准
    const r = await run(["lend-terminal-asks", "--project", P, "--apply"]);
    expect(r).toMatchObject({ ok: true, apply: true, closed: [ids.done] });
    expect(getAsk(db, ids.done)!.extra.settledOrder).toEqual({ orderId: ids.doneOrder, status: "done", by: "agent-pm" });
    for (const id of [ids.cancelled, ids.unknown, ids.claimed, ids.peerMismatch, ids.local, ids.owner, ids.foreign]) expect(state(id)).toBe("open");
    expect((await run(["lend-terminal-asks", "--project", P, "--apply"])).closed).toEqual([]);
  });

  test("已答 / 已撤的历史提问不重复写", async () => {
    const ids = await legacy();
    db.run("UPDATE asks SET state = 'answered' WHERE id = ?", [ids.done]);
    db.run("UPDATE asks SET state = 'cancelled' WHERE id = ?", [ids.cancelled]);
    const n = cancels();
    expect((await run(["lend-terminal-asks", "--project", P, "--apply"])).closed).toEqual([]);
    expect(cancels()).toBe(n);
    expect((getAsk(db, ids.done) as Ask).state).toBe("answered");
  });
});

describe("历史回收的身份：调度服务入口、写锁内重核 PM", () => {
  test("调度服务能预览 / apply（入口与写锁内都核租约）；锁内失租一条不关", async () => {
    const { orderId } = await offer();
    await claim(orderId);
    const q = await askId(orderId);
    db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [orderId]);
    let leaseCalls = 0;
    const sched = (args: string[], lostAfter = Infinity) => runLedger(args, deps("scheduler", {
      assertLease: () => { if (++leaseCalls > lostAfter) throw new SchedulerLeaseLost("lost"); },
    })) as Promise<Record<string, any>>;
    const dry = await sched(["lend-terminal-asks", "--project", P]);
    expect(dry).toMatchObject({ ok: true, apply: false, closable: [{ askId: q, orderId, status: "done" }] });
    leaseCalls = 0;
    expect(await sched(["lend-terminal-asks", "--project", P, "--apply"], 2)).toMatchObject({ ok: false, code: "lease-lost" }); // 入口 + 命令内两次通过，写锁内第三次失租
    expect(leaseCalls).toBe(3);
    expect(state(q)).toBe("open");
    expect(cancels()).toBe(0);
    leaseCalls = 0;
    const r = await sched(["lend-terminal-asks", "--project", P, "--apply"]);
    expect(r).toMatchObject({ ok: true, apply: true, closed: [q] });
    expect(getAsk(db, q)!.extra.settledOrder).toEqual({ orderId, status: "done", by: "scheduler" });
    // 调度服务身份照旧只能跑调度专用命令
    expect(await sched(["lend-cancel", "T9", "--reason", "x"])).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("PM 在核过权限之后、拿写锁之前被撤（另一条连接提交）：apply 在锁内重核拒掉，一条不关", async () => {
    const { orderId } = await offer();
    await claim(orderId);
    const q = await askId(orderId);
    db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [orderId]);
    const other = new Database(path);
    other.exec("PRAGMA busy_timeout = 5000");
    let revoked = false;
    // deps.now 在命令里核完 isManager 之后、applySettledAskSweep 申请 BEGIN IMMEDIATE 之前调（与审查复现同一个时点）
    const revokeOnce = () => {
      if (!revoked) {
        revoked = true;
        setMeta(other, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm2"] });
      }
      return now;
    };
    try {
      const r = await runLedger(["lend-terminal-asks", "--project", P, "--apply"], deps("agent-pm", { now: revokeOnce })) as Record<string, any>;
      expect(revoked).toBe(true);
      expect(r).toMatchObject({ ok: false, code: "forbidden" });
      expect(state(q)).toBe("open");
      expect(cancels()).toBe(0);
      expect((await run(["lend-terminal-asks", "--project", P, "--apply"], "agent-pm2")).closed).toEqual([q]);
    } finally {
      other.close();
    }
  });
});

describe("结清关问提交后发 ask SSE（bridge ledger feed 读已提交事件）", () => {
  test("自动结清与历史 apply 都发 ask cancelled；回滚不发；别的关闭不发；首轮只取基线", async () => {
    const got: SettledAskClosure[] = [];
    const tick = setLedgerFeedForTest({ path, emit: () => {}, emitAsk: (c) => got.push(c) })!;
    try {
      const { orderId } = await offer();
      await claim(orderId);
      const q = await askId(orderId);
      const old = openAsk(db, { project: P, taskId: "T9", source: "reply", kind: "decide", title: "x", fromAgent: `${W(1)}@mate`, extra: { via: "mcp_ask", orderId: "lend:T9:old" } }, now).id;
      closeAsk(db, old, "cancelled", "别的原因"); // 不是随单结清的关闭
      tick(); // 基线：之前的事件不补发
      expect(got).toEqual([]);

      remote[BR] = { ok: true, head: H2 };
      db.run("CREATE TRIGGER fail_cancel BEFORE INSERT ON events WHEN NEW.kind = 'ask_cancel' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
      expect((await call("write", delivery(orderId))).ok).toBe(false);
      db.run("DROP TRIGGER fail_cancel");
      tick();
      expect(got).toEqual([]); // 回滚：没有已提交的关闭，不发

      const by = bystanders(orderId);
      closeAsk(db, by.local, "cancelled", "本机问别的原因关");
      expect((await call("write", delivery(orderId))).ok).toBe(true);
      tick();
      expect(got).toEqual([{ seq: expect.any(Number), project: P, askId: q, state: "cancelled", fromAgent: `${W(1)}@mate`, assignee: "agent-pm", chatId: "" }]); // worker 的问指给 PM
      tick();
      expect(got).toHaveLength(1); // 同一条只发一次
      expect((await call("write", delivery(orderId))).ok).toBe(true); // 幂等重发：不再关、不再发
      tick();
      expect(got).toHaveLength(1);

      card("T10"); const b = await offer("T10"); await claim(b.orderId, W(2));
      const q2 = await askId(b.orderId, W(2));
      db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [b.orderId]);
      tick();
      expect(got).toHaveLength(1);
      expect((await run(["lend-terminal-asks", "--project", P, "--apply"])).closed).toEqual([q2]);
      tick();
      expect(got.map((c) => c.askId)).toEqual([q, q2]);
      expect(JSON.stringify(got)).not.toContain(SECRET_Q);
    } finally {
      setLedgerFeedForTest(undefined);
    }
  });

  test("换库：替换库里先取时间、后提交的历史 apply（事件 ts 早于 feed 上次读成功）换上来后照发一次（复现 ask-sse r2）", async () => {
    const live = join(mkdtempSync(join(tmpdir(), "lend-askt-live-")), "ledger.sqlite");
    openLedger(live); // 先有一份在用的库（空台账）
    closeLedger(live);
    const got: SettledAskClosure[] = [];
    const tick = setLedgerFeedForTest({ path: live, emit: () => {}, emitAsk: (c) => got.push(c) })!;
    try {
      tick(); // 在用库的基线
      // 待替换库（本测试的 db）：精确绑定的 done 单 + 还开着的 worker 提问；apply 的 now 早于上面那次读
      const { orderId } = await offer();
      await claim(orderId);
      const q = await askId(orderId);
      db.run("UPDATE lend_orders SET status = 'done' WHERE orderId = ?", [orderId]);
      tick();
      expect(now).toBeLessThan(Date.now());
      expect((await run(["lend-terminal-asks", "--project", P, "--apply"])).closed).toEqual([q]);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      closeLedger(path);
      renameSync(path, live);
      tick();
      tick();
      expect(got.map((c) => c.askId)).toEqual([q]);
      expect(got[0]).toMatchObject({ project: P, state: "cancelled" });
    } finally {
      setLedgerFeedForTest(undefined);
      db = openLedger(path = live);
    }
  });
});
