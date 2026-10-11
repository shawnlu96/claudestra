/**
 * dispatch-recovery-LRELAY1（审计 A05-03 / A05-07）：出借 relay 只发有效单的本机作者说明，同一时刻排上的分段按数字序发。
 * 全部经 `ledger lend-*` CLI（runLedger）跑内存库；发送、远端 head、对方指纹是注入的假依赖。
 */
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import { lentAwayText, listRelays, relayOrder, takeRelays } from "../src/lib/ledger-lend-relay.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { chunkInput } from "../src/lib/order-wire-chunks.js";
import { WIRE_LIMITS } from "../src/lib/order-wire.js";
import { runLedger } from "../src/manager/ledger.js";

const P = "claude-orchestrator";
const BASE = "b".repeat(40);
const REPO = "shawnlu96/claudestra";
const WORKER = "agent-lend-0123456789";
let db: Database;
let now: number;
let sent: { target: string; text: string }[];
let borrow: BorrowEntry[];
const dir = mkdtempSync(join(tmpdir(), "lend-relay-order-test-"));
const spec = join(dir, "T9.md");

const deps = (actor: string) => ({
  db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => now,
  lend: {
    borrow: async () => borrow,
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
const offer = (peer = "mate") => run(["lend-offer", "T9", "--peer", peer, "--repo", REPO]);
const claim = (orderId: string, peer = "mate") => run([`lend-claim`, "--", peer, JSON.stringify({ v: 1, orderId, worker: WORKER })], "owner");
const notes = () => sent.filter((s) => s.target === "agent-dev");
const noteRows = (orderId: string) => listRelays(db, orderId).filter((r) => r.kind === "note");

beforeEach(() => {
  db = openLedger(":memory:");
  now = 1_000_000;
  sent = [];
  borrow = ["mate", "other"].map((peer) => ({ peer, projects: [P], roles: ["review", "write"], maxOpen: 2 }));
  setMeta(db, { actor: "owner", now }, { project: P, key: "pms", value: ["agent-pm"] });
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿\n");
  createTask(db, { actor: "owner", now }, { project: P, id: "T9", title: "T9", kind: "code", spec, agent: "agent-dev" } as never);
  db.run("UPDATE tasks SET stage = 'build', round = 0 WHERE id = 'T9'");
});
afterEach(() => closeLedger(":memory:"));

describe("[验收线 1] 失效单的本机作者说明零发送，换 peer 后新单只发一次", () => {
  // 撤单不结束写租约，只能再挂回原 peer（新单号）；收回 / 派不回之后换 peer
  const retire: [string, string, (orderId: string) => Promise<unknown>][] = [
    ["withdraw", "mate", async () => expect(await run(["lend-cancel", "T9", "--reason", "撤回"])).toMatchObject({ ok: true })],
    ["reclaim", "other", async () => expect(await run(["lend-reclaim", "T9", "--reason", "收回"])).toMatchObject({ ok: true })],
    ["sendBack", "other", async (orderId) => {
      expect(await claim(orderId)).toMatchObject({ ok: true });
      const r = await run(["lend-lease", "--", "mate", JSON.stringify({ v: 1, orderId, gen: 1, action: "release", reason: "not_started", detail: "clone 失败" })], "owner");
      expect(r).toMatchObject({ ok: true });
    }],
  ];
  test.each(retire)("offer → %s → scan → take：旧说明不发、记 dropped；再挂给 %s 后旧说明不复活", async (_n, peer, end) => {
    const { orderId } = await offer();
    expect(noteRows(orderId).map((r) => r.state)).toEqual(["pending"]);
    await end(orderId);
    expect(listRelays(db, orderId).find((r) => r.kind === "note")!.state).not.toBe("sending");
    await relay();
    await relay();
    expect(notes()).toEqual([]);
    expect(noteRows(orderId).map((r) => r.state)).toEqual(["dropped"]);
    const next = await offer(peer);
    expect(next).toMatchObject({ ok: true });
    await relay();
    await relay();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.text).toContain(lentAwayText(peer, next.orderId, "T9"));
    expect(notes()[0]!.text).not.toContain(orderId);
    expect(noteRows(orderId).map((r) => r.state)).toEqual(["dropped"]);
  });

  test("领取事务内核单：scan 之后才撤销、直接 take 也不领出旧说明", async () => {
    const { orderId } = await offer();
    db.run("UPDATE lend_orders SET status = 'cancelled' WHERE orderId = ?", [orderId]);
    expect(takeRelays(db, now)).toEqual([]);
    expect(noteRows(orderId).map((r) => r.state)).toEqual(["dropped"]);
  });

  test.each(["done", "unknown", "released"])("单是 %s：说明不领出", async (status) => {
    const { orderId } = await offer();
    db.run("UPDATE lend_orders SET status = ? WHERE orderId = ?", [status, orderId]);
    expect(takeRelays(db, now)).toEqual([]);
    expect(noteRows(orderId).map((r) => r.state)).toEqual(["dropped"]);
  });

  test("查无此单的旧说明不领出；pooled / claimed 的照发", async () => {
    db.run(`INSERT INTO lend_relays (key, orderId, taskId, project, kind, target, text, state, tries, createdAt, updatedAt)
      VALUES ('ghost:note', 'ghost', 'T9', ?, 'note', 'agent-dev', '旧说明', 'pending', 0, 1, 1)`, [P]);
    const { orderId } = await offer();
    expect(takeRelays(db, now).map((r) => r.key)).toEqual([`${orderId}:note`]);
    expect(listRelays(db, "ghost").map((r) => r.state)).toEqual(["dropped"]);
  });
});

/** 段正文：去掉段头一行、提示一行和末尾一行，每行剥掉缩进和「」 */
const bodyOf = (text: string): string => text.split("\n").slice(2, -1).map((l) => l.replace(/^ {2}「|」$/g, "")).join("\n");
/** 一份恰好分成 13 段的追加：纯 ASCII，不触发外发闸 */
function thirteen(): string {
  const lines: string[] = [];
  for (let i = 0; chunkInput("规格追加", lines.join("\n"), WIRE_LIMITS.input).length < 13; i++) lines.push(`- 第 ${i} 条 ${"plain words ".repeat(8).trim()}`);
  return lines.join("\n");
}

describe("[验收线 2] 长规格分段按 1 至 13 发出并可拼回正文", () => {
  test("13 段：段头带 i/13，顺序 1..13，拼回追加正文", async () => {
    const { orderId } = await offer();
    expect(await claim(orderId)).toMatchObject({ ok: true });
    await relay();
    sent = [];
    const added = thirteen();
    appendFileSync(spec, `\n${added}\n`);
    await relay();
    const segs = sent.filter((s) => s.target !== "agent-dev");
    expect(segs).toHaveLength(13);
    segs.forEach((s, i) => expect(s.text.split("\n")[0]).toContain(`规格追加 · 第 ${i + 1}/13 段】`));
    expect(segs.map((s) => bodyOf(s.text)).join("")).toBe(added);
    expect(listRelays(db, orderId).filter((r) => r.kind === "spec").map((r) => r.key.split("#")[1])).toEqual(Array.from({ length: 13 }, (_, i) => `${i + 1}`));
  });

  test("升级前排上的旧队列：按数字序领出；sending / unknown 不重发；refused 不放行；key 不改", async () => {
    const { orderId } = await offer();
    expect(await claim(orderId)).toMatchObject({ ok: true });
    await relay();
    const put = db.prepare(`INSERT INTO lend_relays (key, orderId, taskId, project, kind, target, text, state, tries, createdAt, updatedAt)
      VALUES (?, ?, 'T9', ?, 'spec', 'lend-0123456789@mate', ?, ?, 0, 500, 500)`);
    const base = `${orderId}:spec:40-9000`;
    const states: Record<number, string> = { 3: "sending", 7: "unknown", 11: "refused", 12: "sent" };
    // 旧代码按字符串序插入 / 取：1、10、11、12、13、2、…
    for (const i of [1, 10, 11, 12, 13, 2, 3, 4, 5, 6, 7, 8, 9]) put.run(`${base}#${i}`, orderId, P, `段 ${i}`, states[i] ?? "pending");
    const taken = takeRelays(db, now);
    expect(taken.map((r) => r.text)).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 13].map((i) => `段 ${i}`));
    expect(taken.every((r) => r.key.startsWith(`${base}#`))).toBe(true);
    const by = Object.fromEntries(listRelays(db, orderId).filter((r) => r.kind === "spec").map((r) => [r.key.split("#")[1], r.state]));
    expect([by["3"], by["7"], by["11"], by["12"]]).toEqual(["sending", "unknown", "refused", "sent"]);
    expect(takeRelays(db, now)).toEqual([]);
  });

  test("relayOrder：先 createdAt，再按 key 里的数字", () => {
    const k = (key: string, createdAt = 1) => ({ key, createdAt });
    const rows = [k("o:spec:9-10#10"), k("o:spec:9-10#2"), k("o:answer:10"), k("o:answer:9"), k("o:spec:10-12"), k("o:spec:9-10#1"), k("a", 0)];
    expect(rows.sort(relayOrder).map((r) => r.key)).toEqual(["a", "o:answer:9", "o:answer:10", "o:spec:9-10#1", "o:spec:9-10#2", "o:spec:9-10#10", "o:spec:10-12"]);
  });
});
