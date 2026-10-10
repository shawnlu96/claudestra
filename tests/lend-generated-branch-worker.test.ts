/**
 * GB1 全链路：长卡号自产分支从自由文本拿掉后，B 侧 worker 仍只靠结构化字段拿到完整精确分支。
 * A 侧是真实台账（runLedger 的 lend-offer / lend-poll / lend-claim / lend-lease / lend-write，临时内存库），
 * B 侧是真实 lend 循环（lendTick → journal → prepareClone → probePush / pushWork，lab 本地 bare 仓库）+ 真实 lend submit；
 * 两侧之间的 call 原样转给 A 的 bridge 端点。只有开 PR（没有 GitHub）、起 worker 窗口、回执验签是假的。
 */
import type { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { instanceKeySync, signPurpose } from "../src/lib/instance-key.js";
import type { BorrowEntry, LendEntry } from "../src/lib/lend-config.js";
import { listLendOrders } from "../src/lib/ledger-lend.js";
import { getWriteLease, holdWriteLease, LEND_BRANCH_TEXT } from "../src/lib/ledger-lend-lease.js";
import { RECEIPT_PURPOSE } from "../src/lib/ledger-lend-result.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { prepareClone } from "../src/lib/lend-clone.js";
import { lendBranch } from "../src/lib/lend-git.js";
import { getOrder, type LendRow } from "../src/lib/lend-journal.js";
import { lendTick, type LoopDeps } from "../src/lib/lend-loop.js";
import { probePush, pushWork } from "../src/lib/lend-push.js";
import type { LendOp } from "../src/lib/lend-remote.js";
import { submitLendWork } from "../src/lib/lend-submit.js";
import { LEND_STATUS } from "../src/lib/lend-wire.js";
import type { RemoteHead } from "../src/lib/order-deliver.js";
import type { HttpPeer } from "../src/lib/peers.js";
import { runLedger } from "../src/manager/ledger.js";
import { writeLab, writeResources } from "./lend-write-fixture.ts";

const P = "claude-orchestrator";
const LONG = "dispatch-recovery-PCAP6Extra", LONG2 = "dispatch-recovery-PCAP7Extra"; // 合成长卡号（含大写节点）
const B_FP = "b1a2-0c0c-1d1d-2e2e"; // 出借方 B 的合成指纹：前 4 位不是单词形
const A_FP = "abcd-ef01-2345-6789";
const LBR = `lend/${LONG}-b1a2`;
const REPO = "o/r";
const T0 = 1_000_000;

let resources = writeResources();
let db: Database;
let clock: { t: number };
afterEach(async () => {
  closeLedger(":memory:");
  const owned = resources;
  resources = writeResources();
  await owned.dispose();
});
beforeEach(() => {
  db = openLedger(":memory:");
  clock = { t: T0 };
  setMeta(db, { actor: "owner", now: T0 }, { project: P, key: "pms", value: ["agent-pm"] });
});

type Tamper = { claim?: (b: Record<string, any>) => void; result?: (b: Record<string, any>) => void; skipPush?: boolean };

function world(tamper: Tamper = {}) {
  const L = writeLab(resources);
  const dir = resources.temp();
  const key = instanceKeySync(dir);
  const spec = join(dir, "spec.md");
  writeFileSync(spec, "规格：只改 src/lib/x.ts\n验收：单测全绿");
  const borrow: BorrowEntry[] = [{ peer: "mate", projects: [P], roles: ["write"], maxOpen: 2 }];
  const remoteHead = async (_repo: string, branch: string): Promise<RemoteHead> => {
    const r = L.tryGit(L.bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    return r.code === 0 ? { ok: true, head: r.stdout } : { ok: false, error: "没有这个分支" };
  };
  // ── A：真实台账 ──
  const aDeps = (actor: string) => ({
    db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }), saveRegistry: async () => {}, now: () => clock.t,
    lend: {
      borrow: async () => borrow, notifyPm: async () => {},
      result: { reportDir: () => dir, writeReport: (p: string, b: string) => writeFileSync(p, b), sign: (f: string[]) => signPurpose(RECEIPT_PURPOSE, f, key),
        remoteHead, peerFp: async (peer: string) => (peer === "mate" ? B_FP : null) },
    },
  });
  const a = (args: string[], actor = "agent-pm") => runLedger(args, aDeps(actor)) as Promise<Record<string, any>>;
  const card = (id: string, stage = "build", extra = ""): void => {
    createTask(db, { actor: "owner", now: clock.t }, { project: P, id, title: id, kind: "code", spec, agent: "agent-dev" } as never);
    db.run(`UPDATE tasks SET stage = '${stage}', round = 0${extra} WHERE id = '${id}'`);
  };
  // ── B：真实 lend 循环；call 原样转给 A 的 bridge 端点 ──
  const journal = resources.journal();
  const calls: { op: LendOp; body: Record<string, any>; res: Record<string, any> }[] = [];
  const log = { clones: [] as unknown[], sent: [] as string[], pushed: [] as unknown[], prs: [] as unknown[] };
  const registry = new Map<string, { sessionId?: string; cwd?: string }>();
  const opts = { root: L.lendRoot, env: L.env, run: L.run };
  const entry: LendEntry = { peer: "team-a", fp: A_FP, families: { codex: 2 }, roles: ["review", "write"], repos: [REPO], ordersPerDay: 5,
    grantedAt: new Date(T0).toISOString(), until: new Date(T0 + 6 * 86_400_000).toISOString() };
  const peer = { name: "team-a", addedAt: "x", fp: A_FP, baseUrl: "relay://abcd", outToken: "t", publicKey: "k", e2e: { idk: "i", ek: {} } } as unknown as HttpPeer;
  const d: LoopDeps = {
    db: journal, now: () => clock.t, env: {}, footer: () => "（本机尾注）", log: () => {},
    failure: () => undefined, closeAsks: async () => ({ ok: true }), codexQuota: async () => null,
    call: async (_p, op, body) => {
      const sent = structuredClone(body) as Record<string, any>;
      if (op === "result") tamper.result?.(sent);
      const res = await a([`lend-${op === "result" ? "write" : op}`, "--", "mate", JSON.stringify({ v: 1, ...sent })], "owner");
      if (op === "claim" && res.ok) tamper.claim?.(res);
      calls.push({ op, body: sent, res });
      // 同 bridge/local-api/lend.ts：成功去掉 notified 原样回，拒绝按码映射 HTTP 状态
      if (res.ok) { const { ok: _ok, notified: _n, ...rest } = res; return { status: 200, body: { ok: true, ...rest } }; }
      const code = String(res.current?.lend ?? res.code);
      return { status: LEND_STATUS[code as keyof typeof LEND_STATUS] ?? 500, body: { ok: false, code, error: String(res.error ?? code) } };
    },
    readLend: async () => ({ status: "ok", file: { version: 2, enabled: true, lend: [entry], borrow: [] } }),
    context: async () => ({ contacts: [{ name: "team-a", fp: A_FP }], projects: [] }),
    peers: async () => [peer],
    notify: async () => ({ ok: true }), retireAsk: async () => ({ ok: true }),
    clone: async (i) => { log.clones.push(i); return prepareClone(i, opts); },
    removeDir: () => {},
    selfFp: () => B_FP, identity: () => ({ name: "lender", email: "l@example.invalid" }),
    push: {
      probe: (t) => probePush(t, opts),
      work: async (t) => { log.pushed.push(t); return tamper.skipPush ? { ok: true } : pushWork(t, opts); },
      pr: async (p) => { log.prs.push(p); return { ok: true, pr: p.pr ?? 42 }; }, // 没有 GitHub：开 PR 是假的
    },
    verifyReceipt: async () => true, writeReceipt: async () => {},
    worker: {
      find: (n) => registry.get(n),
      create: async (n, cwd, _purpose, gate) => {
        if (await gate()) return { ok: false, error: "gate" };
        registry.set(n, { sessionId: "thr-1", cwd }); return { ok: true }; },
      send: async (_n, _s, text) => { log.sent.push(text); return { ok: true, messageId: "m1" }; },
      kill: async (n) => { registry.delete(n); return { ok: true }; },
      alive: async (n) => (registry.has(n) ? "running" : "no_window"),
    },
  };
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { await lendTick(d); clock.t += 1_000; } };
  const row = (orderId: string) => getOrder(journal, orderId) as LendRow;
  /** worker 在副本里提交，再走真实 lend submit（交当前 HEAD） */
  const work = async (orderId: string, file: string) => {
    const cwd = row(orderId).dir!;
    const head = L.commit(cwd, file);
    const r = await submitLendWork(journal, orderId, { summary: "实现了 x", selfCheck: "逐条对了验收线" },
      { cwd, pid: 10, agentSession: () => "thr-1", panePid: async () => 7, ancestors: async () => [7], headOf: async (x) => L.git(x, "rev-parse", "HEAD") }, clock.t);
    expect(r).toMatchObject({ ok: true });
    return head;
  };
  return { L, a, card, journal, calls, log, tick, row, work, remoteHead };
}

const delivers = (id: string) => listEvents(db, { target: id }).filter((e) => e.kind === "deliver");

describe("GB1 长卡号自产分支：offer → claim → journal → clone → push → 交付 全链路", () => {
  test("开工单：提示不含分支；claim.write / journal / clone / 推送 / 交付体 / 入账全是同一个完整精确分支，main 不动", async () => {
    const w = world();
    w.card(LONG);
    const offered = await w.a(["lend-offer", LONG, "--peer", "mate", "--repo", REPO]);
    expect(offered).toMatchObject({ ok: true, step: "write", branch: LBR, base: "main" });
    expect(lendBranch(LONG, B_FP)).toBe(LBR);
    const [o] = listLendOrders(db, LONG);
    expect(o).toMatchObject({ branch: LBR, head: w.L.main, status: "pooled" });
    expect(o!.text).not.toContain(LBR);
    expect(o!.text).toContain(LEND_BRANCH_TEXT);

    await w.tick(5); // poll → claim → clone + 试推 → 起 worker → 发首条派单
    const r = w.row(o!.orderId);
    expect(r.state).toBe("started");
    expect(w.calls.find((c) => c.op === "claim")!.res.write).toEqual({ branch: LBR, base: "main" });
    expect(r.wire!.write).toEqual({ branch: LBR, base: "main" });
    expect(w.log.clones).toEqual([expect.objectContaining({ head: w.L.main, write: expect.objectContaining({ branch: LBR }) })]);
    expect(w.L.git(r.dir!, "rev-parse", "--abbrev-ref", "HEAD")).toBe(LBR); // 副本检出的就是这个分支
    expect(w.log.sent).toHaveLength(1);
    expect(w.log.sent[0]).not.toContain(LBR); // worker 看到的派单正文只有「已登记的分支」
    expect(w.log.sent[0]).toContain(LEND_BRANCH_TEXT);

    const head = await w.work(o!.orderId, "x.txt");
    await w.tick();
    expect(w.row(o!.orderId).state).toBe("acked");
    expect(w.log.pushed).toEqual([expect.objectContaining({ branch: LBR, base: "main", orderHead: w.L.main, head })]);
    expect(w.L.git(w.L.bare, "rev-parse", LBR)).toBe(head);
    expect(w.L.git(w.L.bare, "rev-parse", "main")).toBe(w.L.main);
    expect(w.calls.find((c) => c.op === "result")!.body).toMatchObject({ branch: LBR, deliver: { head } });
    expect(getTask(db, LONG)).toMatchObject({ stage: "review", headSHA: head, branch: LBR });
    expect(delivers(LONG)).toHaveLength(1);
  });

  test("修复单：同一登记分支在远端 head 上接着改，快进推上去后入账", async () => {
    const w = world();
    w.card(LONG);
    await w.a(["lend-offer", LONG, "--peer", "mate", "--repo", REPO]);
    const built = listLendOrders(db, LONG)[0]!.orderId;
    await w.tick(5);
    const h1 = await w.work(built, "x.txt");
    await w.tick();
    expect(getTask(db, LONG)).toMatchObject({ stage: "review", headSHA: h1, branch: LBR });
    // 审查要修：卡进 fix，写租约仍在 B
    db.run(`UPDATE tasks SET stage = 'fix', round = 1, pr = 'https://github.com/${REPO}/pull/42' WHERE id = '${LONG}'`);
    const path = join(resources.temp(), "r0.md");
    writeFileSync(path, "## P1\n- race-1：并发写丢数据");
    insertEvent(db, { actor: "agent-rev", now: clock.t }, { project: P, target: LONG, kind: "review", text: "changes",
      data: { round: 0, verdict: "changes", path, findings: [{ findingId: "race-1", family: "concurrency", severity: "P1", probe: "两进程同时写" }] } }, true);
    if (getWriteLease(db, LONG)?.state !== "held") holdWriteLease(db, getTask(db, LONG)!, { peer: "mate", fp: B_FP, branch: LBR, repo: REPO }, clock.t);
    expect(await w.a(["lend-offer", LONG, "--peer", "mate", "--repo", REPO, "--pr", "42"])).toMatchObject({ ok: true, step: "fix", branch: LBR });
    const fix = listLendOrders(db, LONG).find((x) => x.step === "fix")!;
    expect(fix.text).not.toContain(LBR);
    clock.t += 60_000; // 过了 A 给的轮询间隔再拉
    await w.tick(5);
    const r = w.row(fix.orderId);
    expect(r.state).toBe("started");
    expect(r.wire!.write).toEqual({ branch: LBR, base: "main" });
    expect(w.L.git(r.dir!, "rev-parse", "HEAD")).toBe(h1);
    const h2 = await w.work(fix.orderId, "fix.txt");
    await w.tick();
    expect(w.row(fix.orderId).state).toBe("acked");
    expect(w.L.git(w.L.bare, "rev-parse", LBR)).toBe(h2);
    expect(w.L.git(w.L.bare, "rev-parse", "main")).toBe(w.L.main);
    expect(w.calls.filter((c) => c.op === "result").at(-1)!.body).toMatchObject({ branch: LBR, pr: 42, deliver: { head: h2 } });
    expect(getTask(db, LONG)).toMatchObject({ stage: "review", headSHA: h2, branch: LBR });
  });
});

describe("GB1 全链路反例：只认结构化登记分支，零交付", () => {
  async function started(w: ReturnType<typeof world>): Promise<string> {
    w.card(LONG);
    await w.a(["lend-offer", LONG, "--peer", "mate", "--repo", REPO]);
    const orderId = listLendOrders(db, LONG)[0]!.orderId;
    await w.tick(5);
    return orderId;
  }
  const zero = (w: ReturnType<typeof world>) => {
    expect(delivers(LONG)).toEqual([]);
    expect(getTask(db, LONG)).toMatchObject({ stage: "build", headSHA: null });
    expect(w.L.git(w.L.bare, "rev-parse", "main")).toBe(w.L.main);
  };

  // 合法出借分支形状但不是本机指纹 / 本卡算出的 → 领下后退回 not_started；连分支形状都不是的 → claim 应答解析不过，不落 claimed、下轮再领
  for (const [branch, state] of [[`lend/${LONG}-ffff`, "released"], [`lend/${LONG2}-b1a2`, "released"], ["main", "asked"], [LEND_BRANCH_TEXT, "asked"]] as const) {
    test(`A 的 claim 给的分支被换成 ${branch}：B 不 clone、不起 worker（${state}）`, async () => {
      const w = world({ claim: (res) => { res.write = { ...res.write, branch }; } });
      const orderId = await started(w);
      expect(w.row(orderId).state).toBe(state);
      expect(w.row(orderId).wire?.write?.branch).not.toBe(LBR);
      expect(w.log.clones).toEqual([]);
      expect(w.log.sent).toEqual([]);
      if (state === "released") expect(w.calls.find((c) => c.op === "lease" && c.body.action === "release")?.body).toMatchObject({ reason: "not_started" });
      expect(w.calls.filter((c) => c.op === "result")).toEqual([]);
      zero(w);
    });
  }

  for (const [name, t] of [
    ["交付体分支换成别的长分支", { result: (b: Record<string, any>) => { b.branch = `lend/${LONG}-ffff`; } }],
    ["交付体分支换成别卡分支", { result: (b: Record<string, any>) => { b.branch = `lend/${LONG2}-b1a2`; } }],
    ["交付体分支换成提示字样", { result: (b: Record<string, any>) => { b.branch = LEND_BRANCH_TEXT; } }],
    ["交付体错代数", { result: (b: Record<string, any>) => { b.gen = 2; } }],
    ["head 没推上去", { skipPush: true }],
  ] as const) {
    test(`${name}：A 不入账`, async () => {
      const w = world(t);
      const orderId = await started(w);
      expect(w.row(orderId).wire!.write).toEqual({ branch: LBR, base: "main" });
      await w.work(orderId, "x.txt");
      await w.tick();
      const res = w.calls.filter((c) => c.op === "result");
      expect(res.length).toBeGreaterThan(0);
      for (const c of res) expect(c.res.ok).toBe(false);
      zero(w);
    });
  }

  test("租约过期后才交：A 不入账", async () => {
    const w = world();
    const orderId = await started(w);
    await w.work(orderId, "x.txt");
    clock.t = listLendOrders(db, LONG)[0]!.leaseUntil! + 1;
    await w.tick();
    for (const c of w.calls.filter((x) => x.op === "result")) expect(c.res.ok).toBe(false);
    zero(w);
  });
});
