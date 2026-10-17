/**
 * merge-arch-CIPRECHK1 · 两个交付入口的薄接线：manager `ledger deliver`（src/manager/ledger-write-cmds.ts deliverCmd）与 worker
 * `submitLendWork`（src/lib/lend-submit.ts）。预检端口是假的（precheckHooks.port）；恢复键 off 走真实的 `ledger scheduler-recovery` 回退命令。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BackgroundState, type Inspection, LEND_PRECHECK_PROJECT, type PrecheckReceipt, precheckHooks, type PrecheckPort } from "../src/lib/ci-deliver-precheck.js";
import { advance, getOrder, openLendJournal, recordAsked } from "../src/lib/lend-journal.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import { submitLendWork, type SubmitterDeps } from "../src/lib/lend-submit.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { runLedger } from "../src/manager/ledger.js";

const H = "a".repeat(40), START = "b".repeat(40);
const ins = (o: Partial<Inspection> = {}): Inspection => ({
  binding: { repo: "r", base: START, mergeBase: START, head: H, status: "", selection: "s" },
  run: "selected", tests: ["tests/a.test.ts"], reasons: [], changedTests: [], registration: [], ...o,
});
let calls = { inspect: 0, run: 0 };
let bg: { dirs: string[]; state: BackgroundState } = { dirs: [], state: { state: "running" } };
/** registration / code 决定这一轮预检的结果；calls 记端口被碰了几次（off 时必须是 0） */
function usePort(o: Partial<Inspection> = {}, code = 0): void {
  const store = new Map();
  const port: PrecheckPort = {
    inspect: async () => { calls.inspect++; return ins(o); },
    runTests: async () => { calls.run++; return { code, tail: code ? "(fail) tests/a.test.ts > wiring" : "" }; },
    recall: (k) => store.get(k) ?? null, remember: (k, r) => store.set(k, r),
    background: async (dir) => { bg.dirs.push(dir); return bg.state; },
  };
  precheckHooks.port = port;
}
beforeEach(() => { calls = { inspect: 0, run: 0 }; bg = { dirs: [], state: { state: "running" } }; });
afterEach(() => { delete precheckHooks.port; rmSync(RECOVERY_POLICY_PATH, { force: true }); });

describe("manager deliver（ledger deliver）", () => {
  let db: Database;
  const agents = { "agent-dev": { cwd: "/wt/agent-dev" } } as never;
  const deps = (actor: string) => ({ db, actor, projectIds: ["p"], loadRegistry: async () => ({ socket: "", agents }), saveRegistry: async () => {}, now: () => 1_000_000 });
  const run = (args: string[], actor = "agent-dev") => runLedger(args, deps(actor)) as Promise<Record<string, any>>;
  const deliver = (...more: string[]) => run(["deliver", "T1", "--from", "build", "--head", H, ...more]);
  const delivers = () => listEvents(db, { target: "T1" }).filter((e) => e.kind === "deliver").length;
  beforeEach(() => {
    db = openLedger(":memory:");
    setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
    createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "agent-dev" } as never);
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
  });
  afterEach(() => closeLedger(":memory:"));

  test("[验收线 1] 漏登记动态加载 / 相关测试失败：带失败清单拒绝，不写交付、卡不动；修好后同一命令交得上", async () => {
    usePort({ registration: ["未登记的非字面量动态加载：src/lib/dyn.ts"] }, 1);
    const r = await deliver();
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.error).toContain("交付前预检未通过，未写交付");
    expect(r.error).toContain("- 登记检查：未登记的非字面量动态加载：src/lib/dyn.ts");
    expect(r.error).toContain("(fail) tests/a.test.ts > wiring");
    expect([delivers(), getTask(db, "T1")?.stage, getTask(db, "T1")?.headSHA]).toEqual([0, "build", null]);
    usePort();
    const ok = await deliver();
    expect(ok).toMatchObject({ ok: true, duplicate: false, precheck: expect.stringContaining("交付前预检通过") });
    expect([delivers(), getTask(db, "T1")?.stage, getTask(db, "T1")?.headSHA]).toEqual([1, "review", H]);
  });

  test("[验收线 4] 预检通过仍走原交付校验：阶段不对照旧被 deliver 本身拒；同一 dedup 重放不再预检", async () => {
    usePort();
    expect(await run(["deliver", "T1", "--from", "review", "--head", H])).toMatchObject({ ok: false });
    expect(calls.inspect).toBeGreaterThan(0);
    calls = { inspect: 0, run: 0 };
    expect(await deliver("--dedup", "k1")).toMatchObject({ ok: true, duplicate: false });
    const once = { ...calls };
    expect(await deliver("--dedup", "k1")).toMatchObject({ ok: true, duplicate: true });
    expect(calls).toEqual(once);
  });

  test("bridge 入口（mcp-deliver 去重键）：按执行者 registry 目录走后台预检；还在跑 / 失败都不写交付，通过后同一命令交得上", async () => {
    usePort();
    const viaMcp = () => deliver("--dedup", `mcp-deliver:o1:${H}`);
    const r = await viaMcp();
    expect(r).toMatchObject({ ok: false, code: "conflict", error: expect.stringContaining("交付前预检还没跑完，未写交付") });
    expect([bg.dirs, calls, delivers()]).toEqual([["/wt/agent-dev"], { inspect: 0, run: 0 }, 0]); // 不在 bridge 的 30 秒里同步跑
    const receipt = (ok: boolean): PrecheckReceipt => ({ ok, scope: "selected", selected: 1, ran: ["tests/a.test.ts"], degradeReasons: [],
      failures: ok ? [] : ["相关测试失败（退出码 1，1 个文件）"], key: "k", reused: false });
    bg.state = { state: "done", receipt: receipt(false) };
    expect(await viaMcp()).toMatchObject({ ok: false, error: expect.stringContaining("- 相关测试失败") });
    expect(delivers()).toBe(0);
    bg.state = { state: "done", receipt: receipt(true) };
    expect(await viaMcp()).toMatchObject({ ok: true, duplicate: false, precheck: expect.stringContaining("交付前预检通过") });
    expect(await viaMcp()).toMatchObject({ ok: true, duplicate: true });
    expect(bg.dirs.length).toBe(3);
  });

  test("不带 head 的交付没有代码可绑，不预检", async () => {
    usePort({}, 1);
    expect(await run(["deliver", "T1", "--from", "build", "--evidence", "docs/x.md"])).toMatchObject({ ok: true });
    expect(calls).toEqual({ inspect: 0, run: 0 });
  });

  test("[验收线 5] 恢复键 off（规格的回退命令）：不碰端口，结果、事件与没有预检时逐字一致；错误也一致", async () => {
    // 对照组：同样跑一次回退命令（序号对齐），但没有预检端口——等于没有本卡
    const fresh = async (mode: string) => {
      closeLedger(":memory:");
      db = openLedger(":memory:");
      setMeta(db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: ["agent-pm"] });
      createTask(db, { actor: "owner", now: 1 }, { project: "p", id: "T1", title: "T1", kind: "code", agent: "agent-dev" } as never);
      db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
      expect(await run(["scheduler-recovery", "p", mode, "--key", "ciDeliverPrecheck", "--reason", "回退"], "owner")).toMatchObject({ ok: true });
    };
    const events = () => listEvents(db, { target: "T1" }).map((e) => [e.seq, e.kind, e.data.op ?? null]);
    await fresh("on");
    const bare = [await deliver(), await deliver()], bareEvents = events();
    await fresh("off");
    usePort({ registration: ["会失败"] }, 1);
    const off = [await deliver(), await deliver()];
    expect(calls).toEqual({ inspect: 0, run: 0 });
    expect(off).toEqual(bare);
    expect(off[1]).toMatchObject({ ok: false }); // 第二次交付（阶段已是 review）的错误也逐字一致
    expect(events()).toEqual(bareEvents);
  });
});

describe("worker submitLendWork", () => {
  let jdb: Database;
  const dir = mkdtempSync(join(tmpdir(), "precheck-submit-"));
  const deps: SubmitterDeps = { cwd: dir, pid: 10, agentSession: () => "s1", panePid: async () => 7, ancestors: async () => [7], headOf: async () => H };
  beforeEach(() => {
    jdb = openLendJournal(join(mkdtempSync(join(tmpdir(), "precheck-journal-")), "j.sqlite"));
    recordAsked(jdb, { orderId: "o1", peer: "a", fp: null, family: "claude", preview: {} });
    advance(jdb, "o1", "asked", "claimed", { leaseGen: 1, wire: { order: { step: "write", head: START, taskId: "T1", round: 0, specRev: 1 }, text: "t",
      write: { branch: "lend/T1-ab", base: "main" } } });
    advance(jdb, "o1", "claimed", "cloned", { dir });
    advance(jdb, "o1", "cloned", "started", { agent: "agent-lend-1", sessionId: "s1" });
  });
  afterEach(() => jdb.close());
  const submit = () => submitLendWork(jdb, "o1", { summary: "一行", selfCheck: "自查" }, deps);

  test("[验收线 1] 预检失败：拒交、给失败清单，journal 仍是 started；修好后交得上；重交是幂等的、不再预检", async () => {
    usePort({ registration: ["未登记的非字面量动态加载：src/lib/dyn.ts"] });
    const r = await submit();
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("- 登记检查：未登记的非字面量动态加载") });
    expect(getOrder(jdb, "o1")?.state).toBe("started");
    usePort({}, 1);
    expect(await submit()).toMatchObject({ ok: false, error: expect.stringContaining("相关测试失败") });
    usePort();
    expect(await submit()).toMatchObject({ ok: true, duplicate: false });
    expect(getOrder(jdb, "o1")).toMatchObject({ state: "result_pending", work: { head: H } });
    calls = { inspect: 0, run: 0 };
    expect(await submit()).toMatchObject({ ok: true, duplicate: true });
    expect(calls).toEqual({ inspect: 0, run: 0 });
  });

  test("[验收线 5] 恢复键 off：不碰端口，结果与没有预检时一致", async () => {
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [LEND_PRECHECK_PROJECT]: { keys: { ciDeliverPrecheck: "off" } } } }));
    usePort({ registration: ["会失败"] }, 1);
    const r = await submit();
    expect(calls).toEqual({ inspect: 0, run: 0 });
    expect(r).toMatchObject({ ok: true, duplicate: false });
  });
});
