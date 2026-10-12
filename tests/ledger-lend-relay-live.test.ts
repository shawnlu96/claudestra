/**
 * dispatch-recovery-LRELAY2：本机作者说明领取（scan / take）时核对任务还在进行中、出借关系仍是这一单，失效的标 dropped、零发送。
 * 合成台账（内存库）经 `ledger lend-*` CLI 跑；发送、远端 head、对方指纹是注入的假依赖。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { lentAwayText, listRelays, takeRelays } from "../src/lib/ledger-lend-relay.js";
import { relayLive, type LiveLease, type LiveOrder, type LiveTask } from "../src/lib/ledger-lend-relay-live.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const REPO = "shawnlu96/claudestra";
const WORKER = "agent-lend-0123456789";
let db: Database;
let now: number;
let sent: { target: string; text: string }[];
const dir = mkdtempSync(join(tmpdir(), "lend-relay-live-test-"));
const spec = join(dir, "T9.md");

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async (): Promise<BorrowEntry[]> => ["mate", "other"].map((peer) => ({ peer, projects: [P], roles: ["review", "write"], maxOpen: 2 })),
    notifyPm: async () => {},
    relay: async (target: string, text: string) => (sent.push({ target, text }), { ok: true as const }),
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "k", sig: "s" }),
      remoteHead: async () => ({ ok: true as const, head: BASE }), peerFp: async () => "abcd-ef01-2345-6789",
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const relay = () => run(["lend-relay"], "owner");
const offer = async (): Promise<string> => {
  const r = await run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
  expect(r).toMatchObject({ ok: true });
  return r.orderId as string;
};
const claim = (orderId: string) => run(["lend-claim", "--", "mate", JSON.stringify({ v: 1, orderId, worker: WORKER })], "owner");
const notes = () => sent.filter((s) => s.target === "agent-dev");
const note = (orderId: string) => listRelays(db, orderId).find((r) => r.kind === "note")!;
const setExtra = (extra: Record<string, unknown>) => db.run("UPDATE tasks SET extra = ? WHERE id = 'T9'", [JSON.stringify(extra)]);

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  sent = [];
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
});
afterEach(() => closeLedger(":memory:"));

describe("[验收线 1] 订单仍 pooled、任务已作废：说明领不出，记 dropped 和原因", () => {
  test("scan + take（lend-relay）零发送", async () => {
    const orderId = await offer();
    db.run("UPDATE tasks SET stage = 'cancelled' WHERE id = 'T9'");
    expect(db.query("SELECT status FROM lend_orders WHERE orderId = ?").get(orderId)).toEqual({ status: "pooled" });
    await relay();
    await relay();
    expect(notes()).toEqual([]);
    expect(note(orderId)).toMatchObject({ state: "dropped", reason: "卡已 cancelled" });
  });

  test("直接 take 也不领出", async () => {
    const orderId = await offer();
    db.run("UPDATE tasks SET stage = 'cancelled' WHERE id = 'T9'");
    expect(takeRelays(db, now)).toEqual([]);
    expect(note(orderId)).toMatchObject({ state: "dropped", reason: "卡已 cancelled" });
  });
});

describe("[验收线 2] 任务 verified / done、出借关系换了：旧说明不发", () => {
  test.each(["verified", "done"])("卡已 %s", async (stage) => {
    const orderId = await offer();
    db.run("UPDATE tasks SET stage = ? WHERE id = 'T9'", [stage]);
    await relay();
    expect(notes()).toEqual([]);
    expect(note(orderId)).toMatchObject({ state: "dropped", reason: `卡已 ${stage}` });
  });

  const swaps: [string, () => void, string][] = [
    ["写租约换到另一个出借方", () => db.run("UPDATE lend_write_leases SET peer = 'other' WHERE taskId = 'T9'"), "写租约已换到 other"],
    ["写租约换代（实例指纹变了）", () => db.run("UPDATE lend_write_leases SET fp = 'ffff-0000', branch = 'lend/T9-ffff' WHERE taskId = 'T9'"), "写租约已换代"],
    ["指派换到别的实例", () => db.run("UPDATE tasks SET assigneeKind = 'peer_agent', assignee = 'ffff-0000/agent-x' WHERE id = 'T9'"), "卡上的指派已换到别的实例"],
    ["钉到别的出借方", () => setExtra({ placement: "peer:other" }), "卡已钉到 other"],
    ["钉回本机", () => setExtra({ placement: "local" }), "卡已钉在本机"],
  ];
  test.each(swaps)("%s：pooled 单的说明不发", async (_n, swap, reason) => {
    const orderId = await offer();
    swap();
    await relay();
    expect(notes()).toEqual([]);
    expect(note(orderId).state).toBe("dropped");
    expect(note(orderId).reason).toContain(reason);
  });

  test("claimed 单同样核对：写租约换到另一个出借方后不发", async () => {
    const orderId = await offer();
    expect(await claim(orderId)).toMatchObject({ ok: true });
    db.run("UPDATE lend_write_leases SET peer = 'other' WHERE taskId = 'T9'");
    expect(takeRelays(db, now)).toEqual([]);
    expect(note(orderId)).toMatchObject({ state: "dropped", reason: "写租约已换到 other" });
  });
});

describe("[验收线 3] 关系一致的 pooled / claimed 单照常只发一次", () => {
  test("pooled：发一次，再扫不重发", async () => {
    const orderId = await offer();
    setExtra({ placement: "peer:mate" });
    await relay();
    await relay();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.text).toContain(lentAwayText("mate", orderId, "T9"));
    expect(note(orderId).state).toBe("sent");
  });

  test("claimed、指派在同一实例：发一次，随后的规格追加照常按段序发", async () => {
    const orderId = await offer();
    expect(await claim(orderId)).toMatchObject({ ok: true });
    db.run("UPDATE tasks SET assigneeKind = 'peer_agent', assignee = 'abcd-ef01-2345-6789/agent-x' WHERE id = 'T9'");
    await relay();
    writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n补充：顺手加一条单测\n");
    await relay();
    await relay();
    expect(notes()).toHaveLength(1);
    expect(sent.map((s) => s.target)).toEqual(["agent-dev", "lend-0123456789@mate"]);
    expect(listRelays(db, orderId).map((r) => [r.kind, r.state])).toEqual([["note", "sent"], ["spec", "sent"]]);
  });
});

describe("relayLive 纯函数", () => {
  const order: LiveOrder = { orderId: "o1", peer: "mate", status: "pooled", branch: "lend/T9-abcd" };
  const task: LiveTask = { stage: "build", assigneeKind: "agent", assignee: "agent-dev", extra: {} };
  const lease: LiveLease = { peer: "mate", fp: "abcd-ef01", branch: "lend/T9-abcd", state: "held" };

  test("有效：note 要 pooled / claimed；其他段只要 claimed", () => {
    expect(relayLive("note", order, task, lease)).toEqual({ live: true });
    expect(relayLive("note", { ...order, status: "claimed" }, task, null)).toEqual({ live: true });
    expect(relayLive("spec", { ...order, status: "claimed" }, null, null)).toEqual({ live: true });
    expect(relayLive("spec", order, task, lease).live).toBe(false);
  });

  test("失效：单状态 / 查无此单 / 卡没了 / 卡结束", () => {
    for (const status of ["done", "unknown", "released", "cancelled"]) expect(relayLive("note", { ...order, status }, task, lease).live).toBe(false);
    expect(relayLive("note", null, task, lease)).toMatchObject({ live: false, reason: expect.stringContaining("查无此单") });
    expect(relayLive("note", order, null, lease)).toEqual({ live: false, reason: "卡已不在台账里" });
    expect(relayLive("note", order, { ...task, stage: "merge" }, lease)).toEqual({ live: true });
  });

  test("已结束的写租约不参与比对；没有分支的单不比代次", () => {
    expect(relayLive("note", order, task, { ...lease, peer: "other", state: "ended" })).toEqual({ live: true });
    expect(relayLive("note", { ...order, branch: null }, task, { ...lease, branch: "lend/T9-ffff" })).toEqual({ live: true });
  });
});
