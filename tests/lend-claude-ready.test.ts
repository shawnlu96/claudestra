/**
 * i28-CLP：推送收单是 bridge 每次新起的 `manager lend inbox` 子进程，进程里没有 Claude 就绪结论，以前 Claude 单恒 no_slot。
 * 结论放进 journal meta（lend-claude-ready.ts）：常驻出借循环每轮在发 hello 之前和它对齐（不新鲜就探、先写回），
 * 收单进程先读它（60 秒内新鲜直接用），没有 / 过期就当场探一次（8 秒封顶，超时 = 不可用）并写回；只有 Codex 单不探。
 * freshProcess() = 一个新进程；探测都注入计数桩，不跑真 claude auth status。
 * 条件写的并发见 tests/lend-claude-ready-race.test.ts，原因只用固定文案见 tests/lend-claude-ready-reason.test.ts。
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceKeySync, keyFingerprint } from "../src/lib/instance-key.js";
import type { LendFile } from "../src/lib/lend-config.js";
import { claudeReadiness, CLAUDE_READY_FRESH_MS, CLAUDE_REASONS, noteClaudeReadiness, type ClaudeReadiness } from "../src/lib/lend-claude-worker-capacity.js";
import { CLAUDE_PROBE_MS, probeWithin, READY_KEY, sharedClaudeReadiness } from "../src/lib/lend-claude-ready.js";
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
const { loggedOut: LOGGED_OUT, unreadable: UNREADABLE } = CLAUDE_REASONS;
/** 一个新进程（可带上它启动时就有的结论） */
const freshProcess = (r: ClaudeReadiness | null = null) => { noteClaudeReadiness(null); noteClaudeReadiness(r); };
const line = (reason: string) => `[lend] Claude 位暂不可用（报 0 位）：${reason}`;

let probes = 0;
const probeSays = (reason: string | null) => async () => { probes++; return reason; };
let n = 0;
/** 一份独立 journal：调度服务刚开过一轮（不 lender_idle），meta 里可以预先放常驻循环写的结论（对象或原样字符串） */
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
  freshProcess();
  probes = 0;
  stderr = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  stderr.mockRestore();
  freshProcess();
});
const stderrLines = () => stderr.mock.calls.map((c: unknown[]) => String(c[0]));

describe("验收 1：meta 里有新鲜结论", () => {
  test("30 秒前写的 ready=true：Claude 单直接收，不跑 auth status", async () => {
    const d = deps({ meta: { ready: true, reason: null, at: Date.now() - 30_000 } });
    expect(await inbox(d, order("c1"), order("c2"))).toEqual({ ok: true, accepted: ["c1", "c2"], refused: [] });
    expect(probes).toBe(0);
  });

  test("30 秒前写的不可用：不探，no_slot，stderr 一行带同一原因", async () => {
    const d = deps({ meta: { ready: false, reason: LOGGED_OUT, at: Date.now() - 30_000 } });
    expect(await inbox(d, order("c1"))).toEqual({ ok: true, accepted: [], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(probes).toBe(0);
    expect(stderrLines()).toEqual([line(LOGGED_OUT)]);
  });
});

describe("验收 2：meta 没有或过期，当场探一次", () => {
  test("没有：探出 ready → 收下，结论写回 meta 给下一个进程用", async () => {
    const d = deps({ probe: null });
    expect(await inbox(d, order("c1"))).toEqual({ ok: true, accepted: ["c1"], refused: [] });
    expect(probes).toBe(1);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: true, reason: null });
    freshProcess(); // 下一个新进程：meta 新鲜，不再探
    expect(await inbox(d, order("c2"))).toMatchObject({ accepted: ["c2"] });
    expect(probes).toBe(1);
  });

  test("过期的 ready：重探，探出不可用 → no_slot，stderr 带原因，meta 改成新结论", async () => {
    const d = deps({ meta: { ready: true, reason: null, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }, probe: LOGGED_OUT });
    expect(await inbox(d, order("c1"), order("x1", "codex"))).toEqual({ ok: true, accepted: ["x1"], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(probes).toBe(1);
    expect(stderrLines()).toEqual([line(LOGGED_OUT)]);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: false, reason: LOGGED_OUT });
  });

  test("过期的不可用：重探，探出 ready → 收下", async () => {
    const d = deps({ meta: { ready: false, reason: LOGGED_OUT, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }, probe: null });
    expect(await inbox(d, order("c1"))).toMatchObject({ accepted: ["c1"], refused: [] });
    expect(probes).toBe(1);
  });

  test("探测卡住：时限内回 no_slot，stderr 带「核对超时」（时限 ≤ 8 秒，短于 bridge 给收单子进程的 15 秒）", async () => {
    expect(CLAUDE_PROBE_MS).toBeLessThanOrEqual(8_000);
    const d = { ...deps(), claude: { probe: () => new Promise<string | null>(() => {}), budgetMs: 200 } };
    const t0 = Date.now();
    expect(await inbox(d, order("c1"), order("x1", "codex"))).toEqual({ ok: true, accepted: ["x1"], refused: [{ orderId: "c1", code: "no_slot" }] });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(stderrLines()).toEqual([line(CLAUDE_REASONS.timeout)]);
    expect(metaOf(d.journalPath)).toMatchObject({ ready: false, reason: CLAUDE_REASONS.timeout });
  });

  test("限时探测按时答完就用它的结论", async () => {
    expect(await probeWithin(1_000, async () => null)).toBeNull();
    expect(await probeWithin(1_000, async () => UNREADABLE)).toBe(UNREADABLE);
  });

  test("meta 写坏 / 自相矛盾 / 原因不在分类里都当没有，照样重探", async () => {
    const bad = ["{", JSON.stringify({ ready: true, reason: "x", at: Date.now() }), JSON.stringify({ ready: false, reason: null, at: Date.now() }),
      JSON.stringify({ ready: false, reason: "EACCES /Users/alice/.claude", at: Date.now() })];
    for (const meta of bad) {
      const d = deps({ meta, probe: null });
      probes = 0;
      freshProcess();
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
      const d = deps({ meta, probe: LOGGED_OUT });
      expect(await inbox(d, order("x1", "codex"), order("x2", "codex"), order("x3", "codex"))).toEqual({
        ok: true, accepted: ["x1", "x2"], refused: [{ orderId: "x3", code: "no_slot" }] });
      expect(probes).toBe(0);
      expect(claudeReadiness()).toBeNull(); // 不后台刷新：缓存原样空着
      expect(stderrLines()).toEqual([]);
    }
  });
});

/** 带 v2 端口的出借循环：记下这一轮真正发出去的 hello 里的 Claude 名额，以及发 hello 那一刻 meta 里的结论（原样） */
function loopWithHello() {
  const h = harness({ entry: { families: { codex: 2, claude: 2 } } });
  const sent: { total: number; meta: string | null }[] = [];
  h.d.v2 = { boot: "boot-aaaa-0001", call: async (_peer, op, body) => {
    if (op === "hello") sent.push({ total: (body.slots as { claude: { total: number } }).claude.total, meta: getMeta(h.db, READY_KEY) });
    return { status: 200, body: { ok: true, v: 1, proto: 2, helloMs: 60_000, beatMs: 15_000 } };
  } };
  h.d.claudeProbe = probeSays(LOGGED_OUT);
  return { h, sent };
}

/** 同一时刻起一个新的收单进程（生产里两边是同一个 journal：把发 hello 时的 meta 原样搬过去），推两张 Claude 单，返回收下几张 */
async function inboxAcceptsAt(meta: string | null, probe: string | null): Promise<number | undefined> {
  freshProcess();
  const before = probes;
  const out = await inbox(deps({ meta: meta ?? undefined, probe }), order("c1"), order("c2"));
  expect(probes).toBe(before); // meta 新鲜：收单进程没自己探
  return accepted(out)?.length;
}

describe("验收 4：这一轮真正发出去的 hello 和同一时刻新收单进程用同一份结论", () => {
  const RECENT = 1000;
  for (const [label, cache, meta] of [
    ["缓存可用 / meta 新写不可用", { ready: true, reason: null }, { ready: false, reason: LOGGED_OUT }],
    ["缓存不可用 / meta 新写可用", { ready: false, reason: LOGGED_OUT }, { ready: true, reason: null }],
  ] as const) for (const tie of [false, true]) {
    // tie：两个进程同一毫秒探完、结论相反。条件写保留库里那份，本进程也得改认它（r2：at 相等不能当作结论相同）
    test(`${label}${tie ? "，两边 at 同一毫秒" : ""}：hello 发出前先认 meta 里的那份`, async () => {
      const { h, sent } = loopWithHello();
      const at = Date.now() - RECENT;
      freshProcess({ ...cache, at: tie ? at : at - 29_000 });
      setMeta(h.db, READY_KEY, JSON.stringify({ ...meta, at }));
      await h.tick();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.total).toBe(meta.ready ? 2 : 0);
      expect(probes).toBe(0); // meta 新鲜：循环也没探
      expect(await inboxAcceptsAt(sent[0]!.meta, meta.ready ? LOGGED_OUT : null)).toBe(sent[0]!.total); // 探测桩给相反结论：用了它就对不上
    });
  }

  for (const [label, cache, probe] of [
    ["循环里从没探过", null, LOGGED_OUT],
    ["循环里的结论过期", { ready: false, reason: LOGGED_OUT, at: Date.now() - CLAUDE_READY_FRESH_MS - 1000 }, null],
  ] as const) {
    test(`${label}：本轮先探、写进 meta，再发 hello`, async () => {
      const { h, sent } = loopWithHello();
      freshProcess(cache);
      h.d.claudeProbe = probeSays(probe);
      await h.tick();
      expect(probes).toBe(1);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!.meta ?? "null")).toMatchObject({ ready: probe === null, reason: probe }); // 发 hello 时 meta 里已经是本轮探的结论
      expect(sent[0]!.total).toBe(probe === null ? 2 : 0);
      expect(await inboxAcceptsAt(sent[0]!.meta, probe === null ? LOGGED_OUT : null)).toBe(sent[0]!.total);
    });
  }

  test("授权里没有 Claude 位：循环不探、不写 meta", async () => {
    const h = harness({ entry: { families: { codex: 2 } } });
    h.d.claudeProbe = probeSays(null);
    await h.tick();
    expect(probes).toBe(0);
    expect(getMeta(h.db, READY_KEY)).toBeNull();
  });
});
