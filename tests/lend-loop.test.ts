/** T94 lend 循环（src/lib/lend-loop.ts + lend-drive.ts）：确认门、重启恢复、心跳自停、前提不满足不 poll。A 与 worker 都是假的。 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { LendEntry } from "../src/lib/lend-config.js";
import { BEAT_MS, detailOf, workerName } from "../src/lib/lend-drive.js";
import { advance, getMeta, getOrder, openLendJournal, patchOrder, recordAsked, type LendRow } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import type { LendOp } from "../src/lib/lend-remote.js";
import type { HttpPeer } from "../src/lib/peers.js";

const HEAD = "e".repeat(40);
const FP = "abcd-ef01-2345-6789";
const ENTRY: LendEntry = { peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review"], repos: ["shawnlu96/claudestra"],
  quota: { ordersPerDay: 5, tokensPerDay: null }, confirm: "per-order" };
const PEER = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
const TEXT = "【调度派单】T93 · review";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const polled = (orderId = "o1") => ({ orderId, taskId: "T93", step: "review", family: "codex", repo: "shawnlu96/claudestra", pr: 270, head: HEAD, round: 1, specRev: 1, offeredAt: 1 });
const wire = (orderId = "o1") => ({ v: 1, orderId, taskId: "T93", specRev: 1, dagVersion: null, node: "R3", step: "review", round: 1, head: HEAD,
  repo: "shawnlu96/claudestra", pr: 270, inputs: ["规格"], outputs: ["报告"], acceptance: ["验收"], writeBack: "submit_verdict", findings: [], fallback: null });

/** 限时预先授权（specRev 2）：auto 必须带 until 才算数；harness 的时钟从 1970 年开始，2100 年远在未来 */
const AUTO = { confirm: "auto", until: "2100-01-01T00:00:00.000Z" } as const;

type Reply = { status: number; body: unknown } | "throw";

function harness(opts: { entry?: Partial<LendEntry>; peer?: Partial<HttpPeer>; env?: Record<string, string> } = {}) {
  const db = openLendJournal(":memory:");
  let t = 1_000_000;
  const calls: { op: LendOp; body: Record<string, unknown> }[] = [];
  const A: Record<LendOp, (b: Record<string, unknown>) => Reply> = {
    poll: () => ({ status: 200, body: { ok: true, v: 1, orders: [polled()], pollAfterMs: 30_000 } }),
    claim: (b) => ({ status: 200, body: { ok: true, v: 1, order: wire(String(b.orderId)), text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } }),
    lease: (b) => ({ status: 200, body: { ok: true, v: 1, lease: b.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } }),
    result: (b) => ({ status: 200, body: { ok: true, v: 1, receipt: { orderId: b.orderId, sha256: sha(JSON.stringify(b)), eventSeq: 9, taskId: "T93", key: "k", sig: "s" } } }),
  };
  const asks = new Map<string, "waiting" | "approved" | "declined">();
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const log = { created: [] as string[], sent: [] as string[], killed: [] as string[], removed: [] as string[], receipts: [] as LendRow[], asksOpened: 0, informs: [] as string[] };
  const inform = { ok: true, delayMs: 0 };
  const entry = { ...ENTRY, ...opts.entry };
  const d: LoopDeps = {
    db, now: () => t, env: opts.env ?? {}, footer: () => "（交结论的办法）", log: () => {},
    call: async (_peer, op, body) => {
      calls.push({ op, body });
      const r = A[op](body);
      if (r === "throw") throw new Error("网络断了");
      return r;
    },
    readLend: async () => ({ status: "ok", file: { version: 1, enabled: true, lend: [entry], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    peers: async () => [{ ...PEER, ...opts.peer } as HttpPeer],
    ask: {
      open: async (p) => { log.asksOpened++; if (!asks.has(`ask-${p.orderId}`)) asks.set(`ask-${p.orderId}`, "waiting"); return { ok: true, askId: `ask-${p.orderId}` }; },
      inform: async (p) => { t += inform.delayMs; inform.delayMs = 0; if (!inform.ok) return { ok: false, error: "bridge 不在" }; log.informs.push(p.orderId); return { ok: true }; },
      verdict: (id) => { const s = asks.get(id) ?? "declined"; return s === "declined" ? { state: "declined", reason: "不批" } : { state: s }; },
    },
    clone: async (i) => ({ ok: true, dir: `/lend/work/${i.orderId}` }),
    removeDir: (id) => void log.removed.push(id),
    verifyReceipt: async () => true,
    writeReceipt: async (row) => void log.receipts.push(row),
    worker: {
      find: (n) => registry.get(n),
      create: async (n, dir) => { log.created.push(n); registry.set(n, { sessionId: "thr-1", cwd: dir }); return { ok: true }; },
      send: async (_n, _s, text) => { log.sent.push(text); return { ok: true, messageId: "m1" }; },
      kill: async (n) => { log.killed.push(n); registry.delete(n); return { ok: true }; },
      alive: async (n) => registry.has(n),
    },
  };
  return { db, d, A, asks, registry, log, calls, inform, tick: () => lendTick(d), advanceTime: (ms: number) => { t += ms; }, ops: () => calls.map((c) => c.op) };
}

/** 一路走到 started（首条派单已发） */
async function toStarted(h: ReturnType<typeof harness>) {
  await h.tick();
  h.asks.set("ask-o1", "approved");
  for (let i = 0; i < 4; i++) await h.tick();
  expect(getOrder(h.db, "o1")!.state).toBe("started");
}

describe("T94 确认门", () => {
  test("per-order：poll 到单只开 ask，owner 没批之前不 claim、不 clone、不起 worker", async () => {
    const h = harness();
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "asked", askId: "ask-o1" });
    expect(h.log.asksOpened).toBe(1);
    expect(h.ops()).not.toContain("claim");
    expect(h.log.created).toEqual([]);
  });

  test("owner 批了才 claim → clone → 起 worker → 首条派单（订单全文 + 本机尾注）", async () => {
    const h = harness();
    await toStarted(h);
    expect(h.log.created).toEqual([workerName("o1")]);
    expect(h.log.sent).toHaveLength(1);
    expect(h.log.sent[0]).toContain(TEXT);
    expect(getOrder(h.db, "o1")!.submit).toBe("sent");
  });

  test("owner 不批 / 过期 → declined，永远不 claim", async () => {
    const h = harness();
    await h.tick();
    h.asks.set("ask-o1", "declined");
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("declined");
    expect(h.ops()).not.toContain("claim");
    expect(h.log.created).toEqual([]);
  });

  test("auto：不开 ask，直接 claim", async () => {
    const h = harness({ entry: AUTO });
    await h.tick();
    await h.tick();
    expect(h.log.asksOpened).toBe(0);
    expect(h.ops()).toContain("claim");
  });
});

describe("T94 限时预先授权（specRev 2）", () => {
  test("生效期间：不开 ask，每单先通知 owner 一次再 claim；通知只发一次", async () => {
    const h = harness({ entry: AUTO });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.log.asksOpened).toBe(0);
    expect(h.log.informs).toEqual(["o1"]);
    expect(typeof getOrder(h.db, "o1")!.preview.informedAt).toBe("number");
    expect(h.log.created).toEqual([workerName("o1")]);
  });

  test("通知没送到：不 claim、不起 worker，下轮再发", async () => {
    const h = harness({ entry: AUTO });
    h.inform.ok = false;
    await h.tick();
    await h.tick();
    expect(h.ops()).not.toContain("claim");
    expect(getOrder(h.db, "o1")!.state).toBe("asked");
    h.inform.ok = true;
    await h.tick();
    expect(h.log.informs).toEqual(["o1"]);
    expect(h.ops()).toContain("claim");
  });

  test("通知送出去的这段时间里到期（r1 P1-2）：通知回来后按此刻重算，不再免确认 claim，下一轮开 ask", async () => {
    const h = harness({ entry: { confirm: "auto", until: new Date(1_000_000 + 1_000).toISOString() } });
    await h.tick(); // poll 到单，落 asked
    h.inform.delayMs = 2_000; // bridge / manager 往返跨过了 until
    await h.tick();
    expect(h.log.informs).toEqual(["o1"]);
    expect(h.ops()).not.toContain("claim");
    await h.tick();
    expect(h.log.asksOpened).toBe(1);
    expect(h.ops()).not.toContain("claim");
    expect(h.log.created).toEqual([]);
  });

  test("同一轮里前一张单的通知慢、跨过了 until：后一张单也不用本轮开头的快照去 claim", async () => {
    const h = harness({ entry: { confirm: "auto", until: new Date(1_000_000 + 1_000).toISOString() } });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o1"), polled("o2")], pollAfterMs: 30_000 } });
    await h.tick();
    h.inform.delayMs = 2_000; // 只有第一张单的通知慢
    await h.tick();
    expect(h.ops()).not.toContain("claim");
    expect(getOrder(h.db, "o2")!.state).toBe("asked");
  });

  test("到期：恢复逐单确认——开 ask，owner 没批不 claim", async () => {
    const h = harness({ entry: { confirm: "auto", until: new Date(1_000_000 + 60_000).toISOString() } });
    h.advanceTime(120_000);
    await h.tick();
    await h.tick();
    expect(h.log.informs).toEqual([]);
    expect(h.log.asksOpened).toBe(1);
    expect(h.ops()).not.toContain("claim");
  });

  test("没写 until 的 auto 一律按逐单确认", async () => {
    const h = harness({ entry: { confirm: "auto" } });
    await h.tick();
    await h.tick();
    expect(h.log.asksOpened).toBe(1);
    expect(h.ops()).not.toContain("claim");
  });

  test("当天单数用完：第二张单不通知、不 claim", async () => {
    const h = harness({ entry: { ...AUTO, quota: { ordersPerDay: 1, tokensPerDay: null } } });
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, orders: [polled("o1"), polled("o2")], pollAfterMs: 30_000 } });
    for (let i = 0; i < 4; i++) await h.tick();
    expect(h.log.informs).toEqual(["o1"]);
    expect(h.calls.filter((c) => c.op === "claim").map((c) => c.body.orderId)).toEqual(["o1"]);
  });

  test("出借关掉后，还没 claim 的单放弃", async () => {
    const h = harness();
    await h.tick();
    h.d.readLend = async () => ({ status: "ok", file: { version: 1, enabled: false, lend: [ENTRY], borrow: [] } });
    h.asks.set("ask-o1", "approved");
    await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("declined");
    expect(h.ops()).not.toContain("claim");
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
    const h = harness({ entry: { ...AUTO, repos: ["other/repo"] } });
    await h.tick();
    await h.tick();
    expect(h.ops().filter((o) => o === "poll")).toHaveLength(1);
    h.advanceTime(30_000);
    await h.tick();
    expect(h.ops().filter((o) => o === "poll")).toHaveLength(2);
  });

  test("白名单外的仓库、非 codex 家族、非 review 步骤的单本地就不收", async () => {
    const h = harness();
    h.A.poll = () => ({ status: 200, body: { ok: true, v: 1, pollAfterMs: 30_000,
      orders: [{ ...polled("x1"), repo: "evil/repo" }, { ...polled("x2"), family: "claude" }, { ...polled("x3"), step: "write" }] } });
    await h.tick();
    expect(getOrder(h.db, "x1") ?? getOrder(h.db, "x2") ?? getOrder(h.db, "x3")).toBeNull();
  });
});

describe("T94 失败与释放", () => {
  test("clone / 核 head 失败：没起 worker，记 released 并向 A 报 not_started", async () => {
    const h = harness({ entry: AUTO });
    h.d.clone = async () => ({ ok: false, reason: "HEAD 与订单 head 不一致" });
    for (let i = 0; i < 3; i++) await h.tick();
    expect(getOrder(h.db, "o1")!.state).toBe("released");
    expect(h.calls.find((c) => c.op === "lease" && c.body.action === "release")?.body).toMatchObject({ reason: "not_started" });
    expect(h.log.created).toEqual([]);
  });

  test("完整订单的 head 和挂单摘要对不上：领了也立刻按 not_started 退回", async () => {
    const h = harness({ entry: AUTO });
    h.A.claim = () => ({ status: 200, body: { ok: true, v: 1, order: { ...wire(), head: "f".repeat(40) }, text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 } } });
    await h.tick();
    await h.tick();
    expect(getOrder(h.db, "o1")).toMatchObject({ state: "released" });
    expect(h.log.created).toEqual([]);
  });

  test("派单全文的 sha256 对不上：当作没领成（结果不明），不 clone", async () => {
    const h = harness({ entry: AUTO });
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
