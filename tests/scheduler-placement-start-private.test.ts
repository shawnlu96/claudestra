/**
 * dispatch-recovery-PRIVSTART1：私仓卡（fileGlobs 带 repo:）自动开卡只放 peer，恢复键 privateStartPlacement。
 * startPlacement 用真实 borrowPeers / placeFor（临时内存台账 + recordHello 的 peer）；preflightStart 用合成 DAG 走真实预检。
 * on：本机更闲也选 peer；没 peer 空位 / 读借入名单失败 / 没注入放置 / 放置抛错 / 显式 local 都拒，不回落本机。
 * observe：放置不变，同卡同规格版本只排一条观察。off 与公共仓卡三档：与改前逐字等价。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightStart, type StartEnv } from "../src/lib/dag-tools-start.js";
import { createFeature, initDag } from "../src/lib/ledger-feature-write.js";
import { recordHello } from "../src/lib/ledger-lend-peers.js";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";
import type { BorrowEntry } from "../src/lib/lend-config.js";
import type { RecoveryMode, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";
import type { RemotePolicy } from "../src/lib/scheduler-config.js";
import { drainPrivateStartObserved, privateStartPending, resetPrivateStartObserved, startPlacement, type StartPlacementIO }
  from "../src/lib/scheduler-placement-start.js";

const now = 1000;
const PRIV = ["repo:o/priv/src/a.ts"], PUB = ["src/lib/a.ts"];
/** 本机先于 peer（localPriority first）：改前私仓卡在本机有空时总落本机 */
const remote: RemotePolicy = { mode: "balance", roles: ["review", "write"], repo: "o/r", poolTimeoutMin: 15, localPriority: "first" };
const BORROW: BorrowEntry[] = [{ peer: "mate", projects: ["p"], roles: ["review", "write"], maxOpen: 2, priority: "balance" }];
/** 唯一的 peer 停用（priority off）：没有任何 peer 写位 */
const FULL = { borrow: async (): Promise<BorrowEntry[]> => [{ ...BORROW[0], priority: "off" }] };

let db: Database, mode: RecoveryMode, reads: string[];
const recovery: RecoveryPolicyPort = (_p, key) => { reads.push(key); return { mode, manualAfterMs: null, source: "config" }; };

function hello(busy: number) {
  recordHello(db, "mate", null, { v: 1, proto: 2, boot: "boot-mate", seq: 1, paused: null,
    slots: { codex: { total: 2, busy }, claude: { total: 0, busy: 0 } },
    grant: { until: now + 3_600_000, roles: ["review", "write"], repos: ["o/r", "o/priv"], ordersPerDay: 9, ordersLeftToday: 9 } }, now);
}

const io = (over: Partial<StartPlacementIO> = {}): StartPlacementIO => ({
  policy: () => ({ remote, maxWorkers: 2 }), borrow: async () => BORROW, originRepo: async () => "o/priv", now: () => now, recovery, ...over,
});
const place = (globs: readonly string[], over: Partial<StartPlacementIO> = {}, card = "p-c1") =>
  startPlacement(db, io(over), { project: "p", repoDir: "/r", fileGlobs: globs, want: "auto", card });

beforeEach(() => {
  db = openLedger(":memory:");
  mode = "on";
  reads = [];
  resetPrivateStartObserved();
  hello(1);
});
afterEach(() => closeLedger(":memory:"));

describe("startPlacement：私仓卡 on 只放 peer", () => {
  test("私仓自动开卡:本机负载更低仍选 peer", async () => {
    mode = "off";
    expect(await place(PRIV)).toMatchObject({ where: "local" }); // 改前（off）：本机空闲、优先，落本机
    mode = "on";
    expect(await place(PRIV)).toMatchObject({ where: "peer", peer: "mate", repo: "o/priv" });
  });

  test("私仓自动开卡:peer 无空位不 claim、不建作者", async () => {
    mode = "off";
    expect(await place(PRIV, FULL)).toMatchObject({ where: "local" });
    mode = "on";
    const got = await place(PRIV, FULL);
    expect(got.where).toBe("refused");
    expect((got as { reason: string }).reason).toStartWith("私仓卡只放 peer：");
  });

  test("私仓自动开卡:放置缺失或异常不得回落本机（借入名单读失败）", async () => {
    const borrow = async () => { throw new Error("borrow.json 坏了"); };
    mode = "off";
    expect(await place(PRIV, { borrow })).toMatchObject({ where: "local" });
    mode = "on";
    expect(await place(PRIV, { borrow })).toEqual({ where: "refused", reason: "私仓卡只放 peer：读借入名单 / 仓库地址失败：borrow.json 坏了" });
  });

  test("显式 peer:<名> 不受影响；读开关抛错按 off", async () => {
    expect(await startPlacement(db, io(), { project: "p", repoDir: "/r", fileGlobs: PRIV, want: "peer:mate" }))
      .toMatchObject({ where: "peer", peer: "mate" });
    expect(await place(PRIV, { recovery: () => { throw new Error("坏"); } })).toMatchObject({ where: "local" });
  });

  test("私仓 peer claim:跳过复述;公共仓放置保持原行为", async () => {
    const results = [];
    for (const m of ["off", "observe", "on"] as RecoveryMode[]) {
      mode = m;
      results.push(await place(PUB), await place(PUB, { borrow: async () => { throw new Error("x"); } }));
    }
    expect(results.slice(2)).toEqual([...results.slice(0, 2), ...results.slice(0, 2)]);
    expect(results[0]).toMatchObject({ where: "local" });
    expect(reads).toEqual([]); // 公共仓卡不读开关
    expect(privateStartPending()).toEqual([]);
  });
});

describe("startPlacement：私仓卡 observe 只记不改", () => {
  test("放置不变，只排一条观察；同卡同规格版本重复算不重复记", async () => {
    mode = "off";
    const before = await place(PRIV);
    mode = "observe";
    expect(await place(PRIV)).toEqual(before);
    expect(await place(PRIV)).toEqual(before);
    expect(privateStartPending()).toMatchObject([{ project: "p", mechanism: "privateStartPlacement", target: "p-c1", actionKey: "private-start:s1",
      data: { actual: "local", wouldBe: "peer:mate", specRev: 1 } }]);
    const written: string[] = [];
    expect(await drainPrivateStartObserved((a) => { written.push(a.action); })).toBe(0); // 卡还没建：等一轮
    expect(privateStartPending()).toHaveLength(1);
    createTask(db, { actor: "agent-pm", now }, { id: "p-c1", project: "p", title: "t", pm: "agent-pm", kind: "code" } as never);
    expect(await drainPrivateStartObserved((a) => { written.push(a.action); })).toBe(1);
    expect(written[0]).toContain("私仓卡只放 peer 时放到 peer:mate（现在放 local）");
    await place(PRIV);
    expect(privateStartPending()).toEqual([]); // 已记过：不再排
  });

  test("规格版本变了再记一条；peer 满时记「等」；没有卡号不记", async () => {
    mode = "observe";
    createTask(db, { actor: "agent-pm", now }, { id: "p-c2", project: "p", title: "t", pm: "agent-pm", kind: "code" } as never);
    db.prepare("UPDATE tasks SET specRev = 3 WHERE id = 'p-c2'").run();
    await place(PRIV, FULL, "p-c2");
    expect(privateStartPending()).toMatchObject([{ target: "p-c2", actionKey: "private-start:s3", data: { wouldBe: "等" } }]);
    await startPlacement(db, io(), { project: "p", repoDir: "/r", fileGlobs: PRIV, want: "auto" });
    expect(privateStartPending()).toHaveLength(1);
  });

  test("写失败的观察留在队里下一轮再写", async () => {
    mode = "observe";
    createTask(db, { actor: "agent-pm", now }, { id: "p-c1", project: "p", title: "t", pm: "agent-pm", kind: "code" } as never);
    await place(PRIV);
    for (let i = 0; i < 3; i++) expect(await drainPrivateStartObserved(() => { throw new Error("query_only"); })).toBe(0);
    expect(privateStartPending()).toHaveLength(1);
  });

  test("卡两轮都不在 / 是别的项目的卡：观察丢掉，不写", async () => {
    mode = "observe";
    createTask(db, { actor: "agent-pm", now }, { id: "q-c1", project: "q", title: "t", pm: "agent-pm", kind: "code" } as never);
    await place(PRIV, {}, "q-c1");
    await place(PRIV, {}, "p-gone");
    const written: string[] = [];
    expect(await drainPrivateStartObserved((a) => { written.push(a.target); })).toBe(0);
    expect(privateStartPending()).toMatchObject([{ target: "p-gone" }]);
    expect(await drainPrivateStartObserved((a) => { written.push(a.target); })).toBe(0);
    expect(privateStartPending()).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe("preflightStart：placeStart 的回落与显式 local", () => {
  const P = "claude-orchestrator", PM = "agent-pm", FID = "ab12-i28";
  let dir: string, ldb: Database;
  const policy: RecoveryPolicyPort = (_p, key) => ({ mode: key === "privateStartPlacement" ? mode : "off", manualAfterMs: null, source: "config" });
  const env = (over: Partial<StartEnv> = {}): StartEnv => ({
    db: ldb, caller: PM, ledgerDir: join(dir, "ledger"), worktreeRoot: join(dir, "wt"), projectDirs: async () => [join(dir, "repo")],
    agentNames: () => [], exists: existsSync, branchExists: async () => false, autoReady: () => null, template: () => null,
    recoveryPolicy: policy, privatePool: () => "off", ...over,
  });
  const start = (e: StartEnv, placement?: string) => preflightStart(e, { featureId: "i28", key: "a", ...(placement ? { placement } : {}) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "privstart-"));
    mkdirSync(join(dir, "ledger", "docs", "tasks"), { recursive: true });
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    const spec = join(dir, "ledger", "docs", "tasks", "i28-a.md");
    writeFileSync(spec, "# 规格\n模板：code\n\n## 目标\n做事\n");
    utimesSync(spec, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    ldb = openLedger(join(dir, "ledger.sqlite"));
    ldb.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
    setMeta(ldb, { actor: "owner", now: 500 }, { project: P, key: "pms", value: [PM] });
    createFeature(ldb, { actor: PM, now: 600 }, { project: P, slug: "i28", title: "协作底座" });
  });
  afterEach(() => {
    closeLedger(join(dir, "ledger.sqlite"));
    rmSync(dir, { recursive: true, force: true });
  });
  const dag = (globs: string[]) => initDag(ldb, { actor: PM, now: 700 }, { id: FID, rev: 1, nodes: [{ key: "a", oneLine: "节点 a", fileGlobs: globs }] });

  test("私仓自动开卡:放置缺失或异常不得回落本机（没注入放置 / 放置抛错）", async () => {
    dag(PRIV);
    const boom = async (): Promise<never> => { throw new Error("借入名单超时"); };
    mode = "off";
    expect(await start(env())).toMatchObject({ ok: true, plan: { peer: null } });
    expect(await start(env({ placement: boom }))).toMatchObject({ ok: true, plan: { peer: null } });
    mode = "on";
    expect(await start(env())).toEqual({ ok: false, code: "placement", error: "不能放到 auto：私仓卡只放 peer：没有放置信息" });
    expect(await start(env({ placement: boom }))).toEqual({ ok: false, code: "placement", error: "不能放到 auto：私仓卡只放 peer：算放置出错：借入名单超时" });
    expect(getTask(ldb, "i28-a")).toBeNull();
  });

  test("放置拿到卡号；observe 回落本机照旧并记一条「等」", async () => {
    dag(PRIV);
    const seen: (string | undefined)[] = [];
    mode = "on";
    const got = await start(env({ placement: async (_db, q) => { seen.push(q.card); return { where: "peer", peer: "mate", repo: "o/priv", reason: "r" }; } }));
    expect(got).toMatchObject({ ok: true, plan: { peer: { name: "mate", repo: "o/priv" } } });
    expect(seen).toEqual(["i28-a"]);
    mode = "observe";
    expect(await start(env())).toMatchObject({ ok: true, plan: { peer: null } });
    expect(privateStartPending()).toMatchObject([{ target: "i28-a", actionKey: "private-start:s1", data: { actual: "local", wouldBe: "等" } }]);
  });

  test("显式 placement=local：私仓卡 on 下拒并写清原因；off / 公共仓照旧", async () => {
    dag(PRIV);
    mode = "on";
    const bad = await start(env(), "local");
    expect(bad).toMatchObject({ ok: false, code: "placement" });
    expect((bad as { error: string }).error).toContain("私仓卡只放 peer：privateStartPlacement 是 on，显式 placement=local");
    mode = "off";
    expect(await start(env(), "local")).toMatchObject({ ok: true, plan: { localOnly: true } });
  });

  test("公共仓卡：三档下没注入放置 / 抛错都照旧落本机", async () => {
    dag(["src/lib/a*.ts"]);
    const outs = [];
    for (const m of ["off", "observe", "on"] as RecoveryMode[]) {
      mode = m;
      outs.push(await start(env()), await start(env({ placement: async () => { throw new Error("x"); } })), await start(env(), "local"));
    }
    for (const o of outs) expect(o).toMatchObject({ ok: true });
    expect(outs.slice(3)).toEqual([...outs.slice(0, 3), ...outs.slice(0, 3)]);
    expect(privateStartPending()).toEqual([]);
  });
});
