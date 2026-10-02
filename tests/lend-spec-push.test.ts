/**
 * i28-RS1：借出去的开工 / 修复单持单期间，规格追加和复述答复自动转给持单的出借 worker（只推新增、每段一次、过外发闸）；
 * 开工单挂出去时本机复述会话收到固定说明，之后它 take_order 拿到说明而不是空单 / 别人的写单。
 * 全部经 `ledger lend-*` CLI（runLedger）跑内存库；发送（send_to_agent 通道）、远端 head、对方指纹是注入的假依赖。
 */
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { RESTATE_PENDING_LINE } from "../src/lib/ledger-lend-lease.js";
import { lentAwayText, listRelays, SENDING_STALE_MS } from "../src/lib/ledger-lend-relay.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import { takeOrderResult } from "../src/lib/order-take.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const H2 = "c".repeat(40);
const REPO = "shawnlu96/claudestra";
const FP = "abcd-ef01-2345-6789";
const BR = "lend/T9-abcd";
const WORKER = "agent-lend-0123456789";
const PEER_ADDR = "lend-0123456789@mate";
let db: Database;
let now: number;
let notices: string[];
let sent: { target: string; text: string }[];
let sendResult: () => { ok: true } | { ok: false; error: string; maybeSent?: boolean };
let remote: Record<string, RemoteHead>;
let borrow: BorrowEntry[];
const dir = mkdtempSync(join(tmpdir(), "lend-spec-push-test-"));
const spec = join(dir, "T9.md");

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow,
    notifyPm: async (_p: string, text: string) => { notices.push(text); },
    relay: async (target: string, text: string) => {
      const r = sendResult();
      if (r.ok) sent.push({ target, text });
      return r;
    },
    result: {
      reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: () => ({ key: "k", sig: "s" }),
      remoteHead: async (_repo: string, branch: string): Promise<RemoteHead> => remote[branch] ?? { ok: false, error: "没有这个分支" },
      peerFp: async (peer: string) => (peer === "mate" ? FP : null),
    },
  },
});
const run = (args: string[], actor = "agent-pm") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
const call = (ep: string, body: unknown) => run([`lend-${ep}`, "--", "mate", JSON.stringify(body)], "owner");
const relay = () => run(["lend-relay"], "owner");
const offer = () => run(["lend-offer", "T9", "--peer", "mate", "--repo", REPO]);
const claim = (orderId: string) => call("claim", { v: 1, orderId, worker: WORKER });
const toWorker = () => sent.filter((s) => s.target === PEER_ADDR);
const localCall = (agent = "agent-dev") => ({ agent, sessionId: null, family: null, channelId: "c1" }) as never;

async function claimed(): Promise<string> {
  const { orderId } = await offer();
  expect(await claim(orderId)).toMatchObject({ ok: true });
  return orderId;
}

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  notices = [];
  sent = [];
  sendResult = () => ({ ok: true });
  remote = { main: { ok: true, head: BASE } };
  borrow = [{ peer: "mate", projects: [P], roles: ["review", "write"], maxOpen: 2 }];
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
});
afterEach(() => closeLedger(":memory:"));

describe("验收 1：持单期间规格追加，出借执行者收到且只收到一次新增部分", () => {
  test("追加一段 → 推一次、只含新增；再跑不重推；再追加只推第二段", async () => {
    const orderId = await claimed();
    await relay();
    expect(toWorker()).toEqual([]); // 没追加不推
    appendFileSync(spec, "\n## PM 定（10-02）\n- 例外文件：src/lib/y.ts 也可以改\n");
    const r1 = await relay();
    expect(r1).toMatchObject({ ok: true });
    expect(toWorker()).toHaveLength(1);
    const first = toWorker()[0]!.text;
    expect(first).toContain(`单号 ${orderId}`);
    expect(first).toContain("例外文件：src/lib/y.ts 也可以改");
    expect(first).not.toContain("只改 src/lib/x.ts"); // 原文不重发
    await relay();
    await relay();
    expect(toWorker()).toHaveLength(1);
    appendFileSync(spec, "- 做法：用方案 B\n");
    await relay();
    expect(toWorker()).toHaveLength(2);
    expect(toWorker()[1]!.text).toContain("做法：用方案 B");
    expect(toWorker()[1]!.text).not.toContain("例外文件");
    expect(listRelays(db, orderId).filter((r) => r.kind === "spec").map((r) => r.state)).toEqual(["sent", "sent"]);
  });

  test("挂单后、领单前的追加：领单之后推（领到的单是挂单时的原文）", async () => {
    const { orderId } = await offer();
    appendFileSync(spec, "- PM 补：领单前追加的一条\n");
    await relay();
    expect(toWorker()).toEqual([]);
    await claim(orderId);
    await relay();
    expect(toWorker()).toHaveLength(1);
    expect(toWorker()[0]!.text).toContain("领单前追加的一条");
  });

  test("bridge 没收下的段下一轮重发；可能已送到的不重发、交 PM；发送中途断了的不重发、交 PM", async () => {
    const orderId = await claimed();
    appendFileSync(spec, "- 追加 A\n");
    sendResult = () => ({ ok: false, error: "bridge 不在" });
    await relay();
    expect(toWorker()).toEqual([]);
    sendResult = () => ({ ok: true });
    await relay();
    expect(toWorker()).toHaveLength(1);
    appendFileSync(spec, "- 追加 B\n");
    sendResult = () => ({ ok: false, error: "超时", maybeSent: true });
    await relay();
    sendResult = () => ({ ok: true });
    await relay();
    expect(toWorker()).toHaveLength(1);
    expect(listRelays(db, orderId).at(-1)).toMatchObject({ state: "unknown" });
    expect(notices.some((n) => n.includes("可能已送到"))).toBe(true);
    // 发送进程半路没了（标成 sending 之后进程退出）：停太久 → unknown + PM，不重发
    appendFileSync(spec, "- 追加 C\n");
    sendResult = () => ({ ok: false, error: "bridge 不在" });
    await relay();
    db.run("UPDATE lend_relays SET state = 'sending' WHERE state = 'pending'");
    sendResult = () => ({ ok: true });
    await relay();
    expect(toWorker().filter((s) => s.text.includes("追加 C"))).toEqual([]); // 还没过期：不动它
    now += SENDING_STALE_MS + 1;
    await relay();
    expect(listRelays(db, orderId).at(-1)).toMatchObject({ state: "unknown" });
    expect(toWorker().filter((s) => s.text.includes("追加 C"))).toEqual([]);
    expect(notices.some((n) => n.includes("发送中途断了"))).toBe(true);
  });

  test("复述的 PM 答复：每条推一次，带单号", async () => {
    const orderId = await claimed();
    const specRev = getTask(db, "T9")!.specRev;
    insertEvent(db, { actor: "agent-pm", now }, { project: P, target: "T9", kind: "decision", text: "待定点 1 按默认，待定点 2 用 B", data: { op: "restate_approved", specRev } }, true);
    await relay();
    await relay();
    expect(toWorker()).toHaveLength(1);
    expect(toWorker()[0]!.text).toContain("待定点 2 用 B");
    expect(toWorker()[0]!.text).toContain(`单号 ${orderId}`);
  });
});

describe("验收 2：推送内容带密钥 / 内网地址：不推，PM 收到通知", () => {
  test.each([
    ["密钥", `- token：ghp_${"A1b2C3d4".repeat(4)}\n`],
    ["内网地址", "- 测试机在 192.168.1.23:8080\n"],
    ["内部域名", "- 接口在 build.corp.internal\n"],
  ])("%s", async (_n, line) => {
    const orderId = await claimed();
    appendFileSync(spec, line);
    await relay();
    await relay();
    expect(toWorker()).toEqual([]);
    expect(listRelays(db, orderId).filter((r) => r.kind === "spec").map((r) => r.state)).toEqual(["refused"]);
    expect(notices.filter((n) => n.includes(orderId) && n.includes("没推给对方"))).toHaveLength(1);
    // 拒过的这段不再推；之后干净的追加照常推
    appendFileSync(spec, "- 干净的一条\n");
    await relay();
    expect(toWorker()).toHaveLength(1);
    expect(toWorker()[0]!.text).toContain("干净的一条");
    expect(toWorker()[0]!.text).not.toMatch(/ghp_|192\.168|corp\.internal/);
  });

  test("复述答复里带密钥也一样拒", async () => {
    await claimed();
    const specRev = getTask(db, "T9")!.specRev;
    insertEvent(db, { actor: "agent-pm", now }, { project: P, target: "T9", kind: "decision", text: `用这个 key sk-${"x".repeat(24)}`, data: { op: "restate_approved", specRev } }, true);
    await relay();
    expect(toWorker()).toEqual([]);
    expect(notices.some((n) => n.includes("复述答复没推给对方"))).toBe(true);
  });
});

describe("验收 3：开工单去了出借方，本机复述会话收到固定说明；take_order 返回说明不返回空 / 写单", () => {
  test("挂单后本机复述会话收到一次固定说明；take_order 拿到同一句", async () => {
    const before = takeOrderResult(db, localCall());
    expect(before).toMatchObject({ ok: true, order: { orderId: "T9:write:r0" } }); // 没借出去时照旧是本机的单
    const { orderId } = await offer();
    await relay();
    await relay();
    const note = sent.filter((s) => s.target === "agent-dev");
    expect(note).toHaveLength(1);
    expect(note[0]!.text).toContain(lentAwayText("mate", orderId, "T9"));
    expect(note[0]!.text).toContain("不写代码、不 push、不 deliver");
    const r = takeOrderResult(db, localCall());
    expect(r).toEqual({ ok: true, order: null, note: lentAwayText("mate", orderId, "T9") });
  });

  test("PM 追加：意图挂给 peer（还没出单）、本机复述会话 take_order → 拿不到写单、拿到说明", () => {
    const t = getTask(db, "T9")!;
    const seq = (db.query("SELECT MAX(seq) AS s FROM events").get() as { s: number }).s + 1000;
    db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, eventSeq, taskRev, specRev, templateVersion,
      status, reason, createdAt, updatedAt) VALUES ('t68:s8716:r0:write:a0', 'T9', ?, 'write', 'dispatch', 'peer:Sekai', 0, ?, ?, ?, 3, 'pending', '挂池', ?, ?)`)
      .run(P, seq, t.rev, t.specRev, now, now);
    const r = takeOrderResult(db, localCall());
    expect(r).toMatchObject({ ok: true, order: null });
    expect((r as { note: string }).note).toContain("本卡代码由 Sekai 写（单号 t68:s8716:r0:write:a0）");
    // 被 peer 领走（意图 submitted）也一样
    db.run("UPDATE scheduler_intents SET status = 'submitted'");
    expect(takeOrderResult(db, localCall())).toMatchObject({ ok: true, order: null, note: expect.stringContaining("Sekai") });
    // 退回本机（意图取消、没有未结的出借单）：照旧拿到本机的单
    db.run("UPDATE scheduler_intents SET status = 'cancelled'");
    expect(takeOrderResult(db, localCall())).toMatchObject({ ok: true, order: { orderId: "T9:write:r0" } });
  });

  test("复述交了、PM 还没答就派出的开工单：单里带复述原文和『答复随后推送』那一句；答过了就不带", async () => {
    const specRev = getTask(db, "T9")!.specRev;
    insertEvent(db, { actor: "agent-dev", now }, { project: P, target: "T9", kind: "stage", text: "复述：待定点 1 默认用 A", data: { from: "spec", to: "restate", specRev } }, true);
    const { orderId } = await offer();
    const [o] = listLendOrders(db, "T9");
    expect(o!.text).toContain(RESTATE_PENDING_LINE.normalize("NFKC")); // 外发渲染按 NFKC 折叠全角标点
    expect(o!.text).toContain("待定点 1 默认用 A");
    // PM 之后的答复推给持单人
    await claim(orderId);
    insertEvent(db, { actor: "agent-pm", now }, { project: P, target: "T9", kind: "decision", text: "待定点 1 改用 B", data: { op: "restate_approved", specRev } }, true);
    await relay();
    expect(toWorker().map((s) => s.text).join("\n")).toContain("待定点 1 改用 B");
    // 答过之后再派的开工单不带那一句
    await run(["lend-cancel", "T9", "--reason", "重来"]);
    await offer();
    expect(listLendOrders(db, "T9").at(-1)!.text).not.toContain(RESTATE_PENDING_LINE.normalize("NFKC"));
  });
});

describe("验收 4：单已交付 / 已取消后的追加不推", () => {
  test("交付之后追加不推", async () => {
    const orderId = await claimed();
    remote[BR] = { ok: true, head: H2 };
    const d = await call("write", { v: 1, orderId, gen: 1, branch: BR, pr: 7, session: { id: "sess-1", family: "codex" },
      deliver: { v: 1, orderId, head: H2, evidence: BR, summary: "实现了", selfCheck: "逐条对了" } });
    expect(d).toMatchObject({ ok: true });
    appendFileSync(spec, "- 交付后追加\n");
    await relay();
    expect(toWorker()).toEqual([]);
  });

  test("撤单之后追加不推；撤单前排上没发出的段记 dropped", async () => {
    const orderId = await claimed();
    appendFileSync(spec, "- 撤单前追加\n");
    sendResult = () => ({ ok: false, error: "bridge 不在" });
    await relay();
    await run(["lend-cancel", "T9", "--reason", "收回"]);
    sendResult = () => ({ ok: true });
    appendFileSync(spec, "- 撤单后追加\n");
    await relay();
    expect(toWorker()).toEqual([]);
    expect(listRelays(db, orderId).filter((r) => r.kind === "spec").map((r) => r.state)).toEqual(["dropped"]);
  });
});

test("lend-relay 只给 bridge（owner）调", async () => {
  expect(await run(["lend-relay"], "agent-pm")).toMatchObject({ ok: false, code: "forbidden" });
});
