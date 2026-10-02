/**
 * i28-CLP：推送收单是 bridge 每次新起的 `manager lend inbox` 子进程，进程里的 Claude 就绪缓存是空的，以前 Claude 单恒 no_slot。
 * 常驻出借循环每轮把结论写进 journal meta（lend-claude-ready.ts syncClaudeReadiness），收单进程先读它（60 秒内新鲜直接用），
 * 没有 / 过期就当场探一次（8 秒封顶，超时 = 不可用）并写回；
 * 只有 Codex 单不探。每个用例开头 noteClaudeReadiness(null) = 一个新进程；探测都注入计数桩，测试进程不跑真 claude auth status。
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import type { LendFile } from "../src/lib/lend-config.js";
import { claudeReadiness, claudeReadinessOneShot, noteClaudeReadiness, CLAUDE_READY_FRESH_MS, type ClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { INBOX_PROBE_MS, probeWithin, READY_KEY, sharedClaudeReadiness, syncClaudeReadiness } from "../src/lib/lend-claude-ready.js";
import { helloBody } from "../src/lib/lend-hello.js";
import { TICK_KEY } from "../src/lib/lend-inbox.js";
import { getMeta, openLendJournal, setMeta } from "../src/lib/lend-journal.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { lendInbox, type InboxDeps } from "../src/manager/lend-inbox.js";
import { harness } from "./lend-harness.js";

const dir = mkdtempSync(join(tmpdir(), "lend-claude-ready-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const key = instanceKeySync(join(dir, "key"))!;
const FP = keyFingerprint(key.publicKey);
const OTHER_FP = keyFingerprint(instanceKeySync(join(dir, "key2"))!.publicKey);
const HEAD = "e".repeat(40);
const NOW = Date.now();
const order = (orderId: string, family: "claude" | "codex" = "claude") =>
  ({ orderId, taskId: "T93", step: "review", family, repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
const offer = (...orders: ReturnType<typeof order>[]) => JSON.stringify({ v: 1, proto: 2, orders });
const lendFile = (families: Record<string, number>): LendFile => ({ version: 2, enabled: true, borrow: [], lend: [{ peer: "team-a", fp: FP, families, roles: ["review"],
  repos: ["shawnlu96/claudestra"], ordersPerDay: 50, grantedAt: new Date(NOW - 1000).toISOString(), until: new Date(NOW + 86_400_000).toISOString() }] });
const peerRec = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://x", outToken: "t", publicKey: key.publicKey, e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const NOT_LOGGED_IN = "本机 Claude Code 没登录：在出借方机器上运行 claude 完成 /login";

let probes = 0;
const probeSays = (reason: string | null) => async () => { probes++; return reason; };
let n = 0;
/** 一份独立 journal：调度服务刚开过一轮（不 lender_idle），meta 里可以预先放常驻循环写的结论 */
function deps(o: { meta?: ClaudeReadiness | string; families?: Record<string, number>; probe?: string | null; tickAt?: number } = {}): InboxDeps & { journalPath: string } {
  const journalPath = join(dir, `j${++n}.sqlite`);
  const db = openLendJournal(journalPath);
  setMeta(db, TICK_KEY, String(o.tickAt ?? Date.now()));
  if (o.meta) setMeta(db, READY_KEY, typeof o.meta === "string" ? o.meta : JSON.stringify(o.meta));
  db.close();
  return { env: {}, findPeer: async () => peerRec, journalPath, readLend: async () => ({ status: "ok", file: lendFile(o.families ?? { codex: 2, claude: 2 }) }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }), claude: { probe: probeSays(o.probe === undefined ? null : o.probe) } };
}
const metaOf = (path: string) => {
  const db = openLendJournal(path);
  try { return sharedClaudeReadiness(db); } finally { db.close(); }
};
const inbox = (d: InboxDeps, ...orders: ReturnType<typeof order>[]) => lendInbox(["--", "team-a", FP, offer(...orders)], d);
const accepted = (out: Awaited<ReturnType<typeof lendInbox>>) => (out.ok ? out.accepted : null);

let stderr: ReturnType<typeof spyOn>;
beforeEach(() => {
  noteClaudeReadiness(null); // 新进程：缓存是空的
  probes = 0;
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
  noteClaudeReadiness(null);
  claudeReadinessOneShot(false);
});
const stderrLines = () => stderr.mock.calls.map((c: unknown[]) => String(c[0]));

describe("验收 1：meta 里有新鲜结论", () => {
  test("30 秒前写的 ready=true：Claude 单直接收，不跑 auth status", async () => {
    const d = deps({ meta: { ready: true, reason: null, at: Date.now() - 30_000 } });
    expect(await inbox(d, order("c1"), order("c2"))).toEqual({ ok: true, accepted: ["c1", "c2"], refused: [] });
    expect(probes).toBe(0);
  });

  test("30 秒前写的不可用：不探，no_slot，stderr 一行带同一原因", async () => {
    const reason = `${NOT_LOGGED_IN}（新鲜）`;
    const d = deps({ meta: { ready: false, reason, at: Date.now() - 30_000 } });
    expect(await inbox(d, order("c1"))).toEqual({ ok: true, accepted: [], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(probes).toBe(0);
    expect(stderrLines()).toEqual([`[lend] Claude 位暂不可用（报 0 位）：${reason}`]);
  });
});

describe("验收 2：meta 没有或过期，当场探一次", () => {
  test("没有：探出 ready → 收下，结论写回 meta 给下一个进程用", async () => {
    const d = deps({ probe: null });
    expect(await inbox(d, order("c1"))).toEqual({ ok: true, accepted: ["c1"], refused: [] });
    expect(probes).toBe(1);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: true, reason: null });
    noteClaudeReadiness(null); // 下一个新进程：meta 新鲜，不再探
    expect(await inbox(d, order("c2"))).toMatchObject({ accepted: ["c2"] });
    expect(probes).toBe(1);
  });

  test("过期的 ready：重探，探出不可用 → no_slot，stderr 带原因，meta 改成新结论", async () => {
    const reason = `${NOT_LOGGED_IN}（过期后重探）`;
    const d = deps({ meta: { ready: true, reason: null, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }, probe: reason });
    expect(await inbox(d, order("c1"), order("x1", "codex"))).toEqual({ ok: true, accepted: ["x1"], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(probes).toBe(1);
    expect(stderrLines()).toEqual([`[lend] Claude 位暂不可用（报 0 位）：${reason}`]);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: false, reason });
  });

  test("过期的不可用：重探，探出 ready → 收下", async () => {
    const d = deps({ meta: { ready: false, reason: NOT_LOGGED_IN, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }, probe: null });
    expect(await inbox(d, order("c1"))).toMatchObject({ accepted: ["c1"], refused: [] });
    expect(probes).toBe(1);
  });

  test("探测卡住：时限内回 no_slot，stderr 带「超时」原因（时限 ≤ 8 秒，短于 bridge 给收单子进程的 15 秒）", async () => {
    expect(INBOX_PROBE_MS).toBeLessThanOrEqual(8_000);
    const d = { ...deps(), claude: { probe: () => new Promise<string | null>(() => {}), budgetMs: 200 } };
    const t0 = Date.now();
    expect(await inbox(d, order("c1"), order("x1", "codex"))).toEqual({ ok: true, accepted: ["x1"], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(stderrLines()).toEqual(["[lend] Claude 位暂不可用（报 0 位）：核对本机 Claude 登录超时（0.2 秒）"]);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: false, reason: "核对本机 Claude 登录超时（0.2 秒）" });
  });

  test("限时探测：按时答完就用它的结论；探测抛错落成不可用", async () => {
    expect(await probeWithin(1_000, async () => null)).toBeNull();
    expect(await probeWithin(1_000, async () => NOT_LOGGED_IN)).toBe(NOT_LOGGED_IN);
    const d = { ...deps(), claude: { probe: async (): Promise<string | null> => { throw new Error("spawn 失败"); } } };
    expect(await inbox(d, order("c1"))).toMatchObject({ refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(stderrLines()).toEqual(["[lend] Claude 位暂不可用（报 0 位）：核对本机 Claude 登录失败：spawn 失败"]);
  });

  test("meta 写坏 / 自相矛盾当没有，照样重探", async () => {
    for (const bad of ["{", JSON.stringify({ ready: true, reason: "x", at: Date.now() }), JSON.stringify({ ready: false, reason: null, at: Date.now() })]) {
      const d = deps({ meta: bad, probe: null });
      probes = 0;
      noteClaudeReadiness(null);
      expect(await inbox(d, order("c1"))).toMatchObject({ accepted: ["c1"] });
      expect(probes).toBe(1);
    }
  });

  test("授权里没有 Claude 位、调度服务停摆、指纹对不上：不探（结果和以前一样）", async () => {
    expect(await inbox(deps({ families: { codex: 2 } }), order("c1"))).toMatchObject({ refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(await inbox(deps({ tickAt: Date.now() - 120_000 }), order("c1"))).toMatchObject({ refused: [{ orderId: "c1", code: "lender_idle" }] });
    expect(await lendInbox(["--", "team-a", OTHER_FP, offer(order("c1"))], deps())).toMatchObject({ refused: [{ orderId: "c1", code: "no_grant" }] });
    expect(probes).toBe(0);
  });
});

describe("验收 3：只有 Codex 单", () => {
  test("不探 Claude（连后台刷新也不起），结果与以前相同，不打 Claude 日志", async () => {
    for (const meta of [undefined, { ready: true, reason: null, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }]) {
      const d = deps({ meta, probe: NOT_LOGGED_IN });
      expect(await inbox(d, order("x1", "codex"), order("x2", "codex"), order("x3", "codex"))).toEqual({
        ok: true, accepted: ["x1", "x2"], refused: [{ orderId: "x3", code: "no_slot" }] });
      expect(probes).toBe(0);
      expect(claudeReadiness()).toBeNull(); // 一次性进程不后台刷新：缓存原样空着
      expect(stderrLines()).toEqual([]);
    }
  });
});

describe("验收 4：hello 和推送收单用同一份结论", () => {
  for (const [label, r] of [["可用", { ready: true, reason: null }], ["不可用", { ready: false, reason: `${NOT_LOGGED_IN}（hello 对照）` }]] as const) {
    test(`常驻循环里结论${label}：一轮 lendTick 把它写进 meta，新进程收单判的名额 = hello 报的`, async () => {
      const loop: ClaudeReadiness = { ...r, at: Date.now() - 30_000 };
      const h = harness({ entry: { families: { codex: 2, claude: 2 } } });
      noteClaudeReadiness(loop);
      await h.tick();
      expect(sharedClaudeReadiness(h.db)).toEqual(loop);
      const helloTotal = helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total;
      expect(helloTotal).toBe(r.ready ? 2 : 0);
      // 生产里两边是同一个 journal：把循环写下的 meta 原样搬过去；探测桩故意给相反结论，用了它就对不上
      const d = deps({ meta: getMeta(h.db, READY_KEY)!, probe: r.ready ? NOT_LOGGED_IN : null });
      noteClaudeReadiness(null);
      expect(accepted(await inbox(d, order("c1"), order("c2")))?.length).toBe(helloTotal);
      expect(probes).toBe(0);
    });
  }

  test("收单进程探到的更新结论，常驻循环下一轮认它（hello 跟着变）；更旧的不覆盖", async () => {
    const h = harness({ entry: { families: { codex: 2, claude: 2 } } });
    noteClaudeReadiness({ ready: true, reason: null, at: Date.now() - 40_000 });
    const newer: ClaudeReadiness = { ready: false, reason: `${NOT_LOGGED_IN}（收单进程新探）`, at: Date.now() - 1000 };
    setMeta(h.db, READY_KEY, JSON.stringify(newer));
    await h.tick();
    expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(0);
    const mine: ClaudeReadiness = { ready: true, reason: null, at: Date.now() };
    noteClaudeReadiness(mine);
    setMeta(h.db, READY_KEY, JSON.stringify({ ...newer, at: mine.at - 5000 }));
    syncClaudeReadiness(h.db);
    expect(sharedClaudeReadiness(h.db)).toEqual(mine);
    expect(helloBody(h.db, h.lend.lend[0], h.d.now()).slots.claude.total).toBe(2);
  });
});
