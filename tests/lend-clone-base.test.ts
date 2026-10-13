/**
 * LENDBASE1：写单副本把订单 base 分支取成 refs/remotes/origin/HEAD（src/lib/lend-clone.ts），取不到 / 解析不出就 ok:false，
 * lend 循环按现有释放路径退回、不进 cloned、不起 worker；审查单仍是可选的默认分支抓取。base 从订单（wire.write.base）一路传到 clone。
 * lab 本地 bare 仓库（真 git）；A 与 worker 是假的。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { LendEntry } from "../src/lib/lend-config.js";
import { prepareClone, type Run } from "../src/lib/lend-clone.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { getOrder } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { writeLab, writeResources } from "./lend-write-fixture.ts";

let resources = writeResources();
afterEach(async () => {
  const owned = resources;
  resources = writeResources();
  await owned.dispose();
});
const BR = "lend/T1-abcd";
const W = { branch: BR, name: "lender", email: "l@x" };
const BASE_FETCH = /:refs\/remotes\/origin\/HEAD$/;
/** 订单 head 照常取，取基线（不论默认分支还是 base 分支）那一步失败 */
const failBase = (run: Run): Run => (argv, opts) =>
  argv.includes("fetch") && BASE_FETCH.test(argv.at(-1)!) ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: couldn't find remote ref", timedOut: false }) : run(argv, opts);

describe("写单副本的基线", () => {
  test("红测 1：订单 head 取到、base 取不到 → 写单 ok:false，原因写明基线", async () => {
    const L = writeLab(resources);
    const c = await prepareClone({ orderId: "b1", repo: "o/r", pr: null, head: L.main, write: { ...W, base: "main" } },
      { root: L.lendRoot, env: L.env, run: failBase(L.run) });
    expect(c).toEqual({ ok: false, reason: expect.stringMatching(/^基线 main 取不到：.*couldn't find remote ref/) });
  });

  test("base 分支在远端不存在 / 分支名不合法 → ok:false；订单 base 为空按 main 并写明", async () => {
    const L = writeLab(resources);
    const o = { root: L.lendRoot, env: L.env, run: L.run };
    const gone = await prepareClone({ orderId: "b2", repo: "o/r", pr: null, head: L.main, write: { ...W, base: "nope" } }, o);
    expect(gone).toMatchObject({ ok: false, reason: expect.stringContaining("基线 nope 取不到：") });
    const bad = await prepareClone({ orderId: "b3", repo: "o/r", pr: null, head: L.main, write: { ...W, base: "a..b" } }, o);
    expect(bad).toMatchObject({ ok: false, reason: expect.stringContaining("基线 a..b 取不到：分支名不合法") });
    const empty = await prepareClone({ orderId: "b4", repo: "o/r", pr: null, head: L.main, write: { ...W, base: "" } }, { ...o, run: failBase(L.run) });
    expect(empty).toMatchObject({ ok: false, reason: expect.stringContaining("基线 main（订单 base 为空，按 main） 取不到：") });
    const fine = await prepareClone({ orderId: "b5", repo: "o/r", pr: null, head: L.main, write: { ...W, base: "" } }, o);
    expect(fine.ok).toBe(true);
    expect(L.git((fine as { dir: string }).dir, "rev-parse", "refs/remotes/origin/HEAD")).toBe(L.main);
  });

  test("红测 2：远端默认分支是别的分支、main 比订单 head 多一个提交 → origin/HEAD 指向 main、对象在、订单 HEAD 不变", async () => {
    const L = writeLab(resources);
    const head = L.main;
    L.git(L.bare, "branch", "dev", head);
    L.git(L.bare, "symbolic-ref", "HEAD", "refs/heads/dev");
    const tip = L.commit(L.seed, "main-only.txt");
    L.git(L.seed, "push", "-q", L.bare, "main");
    expect(L.git(L.bare, "rev-parse", "HEAD")).toBe(head);
    const c = await prepareClone({ orderId: "b6", repo: "o/r", pr: null, head, write: { ...W, base: "main" } }, { root: L.lendRoot, env: L.env, run: L.run });
    expect(c.ok).toBe(true);
    const dir = (c as { dir: string }).dir;
    expect(L.git(dir, "rev-parse", "refs/remotes/origin/HEAD")).toBe(tip);
    expect(L.tryGit(dir, "cat-file", "-e", `${tip}^{commit}`).code).toBe(0);
    expect(L.git(dir, "rev-parse", "HEAD")).toBe(head);
    expect(L.git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BR);
    // 锁照旧：基线取完才上锁，worker 自己 fetch / push 都被拒
    expect(L.tryGit(dir, "fetch", "origin", "main")).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
    expect(L.tryGit(dir, "push", "origin", `HEAD:${BR}`)).toMatchObject({ code: 128, stderr: expect.stringContaining("not allowed") });
  });

  test("审查单行为不变：取远端默认分支，取不到不算失败", async () => {
    const L = writeLab(resources);
    L.git(L.bare, "branch", "dev", L.main);
    L.git(L.bare, "symbolic-ref", "HEAD", "refs/heads/dev");
    const dev = L.commit(L.seed, "dev-only.txt");
    L.git(L.seed, "push", "-q", L.bare, "HEAD:dev");
    const o = { root: L.lendRoot, env: L.env };
    const ok = await prepareClone({ orderId: "r1", repo: "o/r", pr: null, head: L.main }, { ...o, run: L.run });
    expect(ok.ok).toBe(true);
    expect(L.git((ok as { dir: string }).dir, "rev-parse", "refs/remotes/origin/HEAD")).toBe(dev);
    const seen: string[][] = [];
    const run: Run = (argv, opts) => (seen.push(argv), failBase(L.run)(argv, opts));
    expect((await prepareClone({ orderId: "r2", repo: "o/r", pr: null, head: L.main }, { ...o, run })).ok).toBe(true);
    expect(seen.filter((a) => a.includes("fetch") && BASE_FETCH.test(a.at(-1)!)).map((a) => a.at(-1))).toEqual(["HEAD:refs/remotes/origin/HEAD"]);
  });
});

// ── lend 循环：base 传到 clone；基线取不到走释放路径 ──

const BASE = "b".repeat(40);
const FP = "abcd-ef01-2345-6789";
const WB = lendBranch("T93", FP)!;
const T0 = 1_000_000;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const TEXT = "【出借派单】T93 · write";
const PEER = { name: "team-a", addedAt: "x", fp: FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;

function harness(o: { repo: string; head: string; step: string; base: string; findings?: unknown[]; clone?: LoopDeps["clone"] }) {
  const db = resources.journal();
  const ENTRY: LendEntry = { peer: "team-a", fp: FP, families: { codex: 2 }, roles: ["review", "write"], repos: [o.repo], ordersPerDay: 5,
    grantedAt: new Date(T0).toISOString(), until: new Date(T0 + 6 * 86_400_000).toISOString() };
  const polled = { orderId: "w1", taskId: "T93", step: o.step, family: "codex", repo: o.repo, pr: null, head: o.head, round: o.step === "fix" ? 1 : 0, specRev: 1, offeredAt: 1 };
  const wire = { v: 1, orderId: "w1", taskId: "T93", specRev: 1, dagVersion: null, node: "write", step: o.step, round: polled.round, head: o.head, repo: o.repo, pr: null,
    inputs: ["规格原文：X"], outputs: ["提交"], acceptance: ["只推订单分支"], writeBack: "lend submit", findings: o.findings ?? [], fallback: null };
  const calls: { op: string; body: Record<string, unknown> }[] = [];
  const log = { clones: [] as Parameters<LoopDeps["clone"]>[0][], created: [] as string[], lines: [] as string[] };
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const d: LoopDeps = {
    db, now: () => T0, env: {}, footer: () => "", log: (m) => log.lines.push(m),
    failure: () => undefined, closeAsks: async () => ({ ok: true }), codexQuota: async () => null,
    call: async (_p, op, body) => {
      calls.push({ op, body });
      if (op === "poll") return { status: 200, body: { ok: true, v: 1, orders: [polled], pollAfterMs: 30_000 } };
      if (op === "claim") return { status: 200, body: { ok: true, v: 1, order: wire, text: TEXT, sha256: sha(TEXT), lease: { gen: 1, expiresAt: 0, ms: 600_000 },
        write: { branch: WB, base: o.base } } };
      return { status: 200, body: { ok: true, v: 1, lease: body.action === "renew" ? { gen: 1, expiresAt: 0, ms: 600_000 } : null } };
    },
    readLend: async () => ({ status: "ok", file: { version: 2, enabled: true, lend: [ENTRY], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: FP }], projects: [] }),
    peers: async () => [PEER],
    notify: async () => ({ ok: true }), retireAsk: async () => ({ ok: true }),
    clone: async (i) => { log.clones.push(i); return o.clone ? o.clone(i) : { ok: true, dir: `/lend/work/${i.orderId}` }; },
    removeDir: () => {},
    selfFp: () => FP, identity: () => ({ name: "lender", email: "l@x" }),
    push: { probe: async () => ({ ok: true }), work: async () => ({ ok: true }), pr: async () => ({ ok: true, pr: 42 }) },
    verifyReceipt: async () => true, writeReceipt: async () => {},
    worker: {
      find: (n) => registry.get(n),
      create: async (n, dir) => { log.created.push(`${n} ${dir}`); registry.set(n, { sessionId: "thr-1", cwd: dir }); return { ok: true }; },
      send: async () => ({ ok: true, messageId: "m1" }),
      kill: async (n) => { registry.delete(n); return { ok: true }; },
      alive: async (n) => (registry.has(n) ? "running" : "no_window"),
    },
  };
  return { db, log, calls, tick: () => lendTick(d) };
}

describe("lend 循环：写单副本的 base", () => {
  const cases = [
    { name: "开工单", step: "write", base: "main", findings: [] },
    { name: "普通修复单", step: "fix", base: "release/2", findings: [{ findingId: "race-1", family: "race", severity: "P1", probe: "两次并发写" }] },
    { name: "冲突退回的修复单", step: "fix", base: "main", findings: [{ findingId: "merge-conflict", family: "merge", severity: "P1", probe: "与 main 冲突" }] },
  ];
  for (const c of cases) {
    test(`端口：${c.name}把订单 base（${c.base}）传到 clone`, async () => {
      const h = harness({ repo: "shawnlu96/claudestra", head: BASE, step: c.step, base: c.base, findings: c.findings });
      for (let i = 0; i < 4; i++) await h.tick();
      expect(h.log.clones).toHaveLength(1);
      expect(h.log.clones[0]).toMatchObject({ head: BASE, write: { branch: WB, base: c.base, name: "lender", email: "l@x" } });
      expect(getOrder(h.db, "w1")!.state).toBe("started");
    });
  }

  test("红测 1（循环）：真 clone 取 base 失败 → 退回 not_started 并带原因，不进 cloned、不起 worker", async () => {
    const L = writeLab(resources);
    const h = harness({ repo: "o/r", head: L.main, step: "fix", base: "main",
      clone: (i) => prepareClone(i, { root: L.lendRoot, env: L.env, run: failBase(L.run) }) });
    for (let i = 0; i < 4; i++) await h.tick();
    const row = getOrder(h.db, "w1")!;
    expect(row.state).toBe("released");
    expect(row.reason).toMatch(/^基线 main 取不到：/);
    expect(h.log.created).toEqual([]);
    const rel = h.calls.find((c) => c.op === "lease" && c.body.action === "release")?.body;
    expect(rel).toMatchObject({ reason: "not_started", detail: expect.stringContaining("基线 main 取不到") });
  });
});
