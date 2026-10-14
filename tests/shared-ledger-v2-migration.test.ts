/** X13 验收线 1–5：整组执行权迁移的预检 / 映射 / 切换 / 反向，以及演练只写临时根目录。
 * 隔离 fixture：mkdtemp 临时根 + 合成本机台账 + S2C 内存中心（经真实 S2T 签名传输）；实例只叫 本机 / peer A / peer B。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { V2_DTO_FIXTURES } from "../src/lib/shared-ledger-contract-v2-fixtures.js";
import { acquireMaintenance } from "../src/lib/scheduler-maintenance.js";
import { readSharedLedgerMode, writeSharedLedgerModes } from "../src/lib/shared-ledger-mode.js";
import { createStage2Transport } from "../src/lib/shared-ledger-v2-transport.js";
import { assertDrillRoot, productionDirs, sha256File } from "../src/lib/shared-ledger-v2-migration-local.js";
import {
  exportForReverse, migrationCenter, runExecutionMigration, type MigrationOutcome, type MigrationPlan,
} from "../src/lib/shared-ledger-v2-migration.js";
import { main } from "../scripts/shared-ledger-execution-migrate.js";
import { ACTORS, approvedAsk, featureRows, kit } from "./helpers/shared-ledger-v2-fake-center-kit.js";

const H = "b".repeat(40);
const PEERS = { local: "本机", "peer-a": "peer A", "peer-b": "peer B" } as const;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

/** 本机台账的最小表：卡、执行者会话、调度意图、出借单（只含迁移预检读的列）。 */
function ledger(root: string, rows: { workers?: boolean; unknownIntent?: boolean; order?: { status: string; leaseGen: number } | null; stage?: string } = {}) {
  const db = new Database(join(root, "ledger.sqlite"));
  db.run("CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT, featureId TEXT, extra TEXT NOT NULL DEFAULT '{}', stage TEXT)");
  db.run("CREATE TABLE scheduler_sessions (taskId TEXT, role TEXT, sessionId TEXT, state TEXT)");
  db.run("CREATE TABLE scheduler_intents (id TEXT PRIMARY KEY, taskId TEXT, status TEXT)");
  db.run("CREATE TABLE lend_orders (orderId TEXT PRIMARY KEY, taskId TEXT, status TEXT, leaseGen INTEGER, head TEXT, peer TEXT)");
  db.run("INSERT INTO tasks VALUES ('old-task', 'project', 'feature', '{}', ?)", [rows.stage ?? "build"]);
  db.run("INSERT INTO tasks VALUES ('other-task', 'project', NULL, '{}', 'build')");
  if (rows.workers) db.run("INSERT INTO scheduler_sessions VALUES ('old-task', 'author', 'session-1', 'active')");
  if (rows.unknownIntent) db.run("INSERT INTO scheduler_intents VALUES ('intent-u', 'old-task', 'unknown')");
  db.run("INSERT INTO scheduler_intents VALUES ('intent-done', 'old-task', 'done')");
  const order = rows.order === undefined ? { status: "claimed", leaseGen: 1 } : rows.order;
  if (order) db.run("INSERT INTO lend_orders VALUES ('old-order', 'old-task', ?, ?, ?, 'peer-a')", [order.status, order.leaseGen, H]);
  db.close();
}
async function world(rows: Parameters<typeof ledger>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "x13-drill-"));
  roots.push(root);
  ledger(root, rows);
  await writeSharedLedgerModes({ feature: { authorityMode: "planning", sharedPlanning: true } }, root, join(root, "ledger.sqlite"));
  const k = kit(), seeded = featureRows("feature", "task", "planning");
  k.center.seed({ features: [seeded.feature], asks: [approvedAsk("ask", "feature", "task")] });
  const pair = generateKeyPairSync("ed25519"), key = { privateKey: pair.privateKey, publicKey: String(pair.publicKey.export({ format: "jwk" }).x) };
  const transport = createStage2Transport({ key, projectId: "project", fetch: k.center.fetch(() => ACTORS.owner) as typeof fetch,
    connection: { centerId: "center", baseUrl: "https://center.invalid", teamId: "team", personId: "person", instanceId: "local", bearer: "drill-bearer-0123456789" } });
  return { root, k, center: migrationCenter(transport) };
}
/** X0 合成清单去掉本模块要填的字段；feature 映射改成同 id（前提一），出借单按 claimed / leaseGen 1 显式导入。 */
function plan(extra: Partial<MigrationPlan> = {}, edit: (m: Record<string, any>) => void = () => {}): MigrationPlan {
  const { manifestDigest: _d, evidence: _e, featureIds: _f, frozenAt: _z, batchId: _b, ...manifest } =
    structuredClone(V2_DTO_FIXTURES.migrationManifest.valid) as Record<string, any>;
  manifest.mappings = manifest.mappings.map((x: any) => x.kind === "feature" ? { ...x, sourceId: "feature" } : x);
  edit(manifest);
  return { batchId: "batch-x13", centerId: "center", featureIds: ["feature"], homeBootId: "boot-local", manifest: manifest as MigrationPlan["manifest"],
    orders: { "old-order": { disposition: "import", leaseGen: 1, head: H } },
    members: Object.entries(PEERS).map(([instanceId, label]) => ({ label, instanceId, versionVerified: true })), ...extra };
}
const settled = (m: Record<string, any>) => {
  m.lendOrders = []; m.lendClaims = []; m.lendLeases = []; m.lendResults = [];
  m.mappings = m.mappings.filter((x: any) => x.kind !== "order");
};
const codes = (o: MigrationOutcome) => o.status === "refused" ? o.findings.map(f => `${f.code}:${f.item}`).sort() : [];
const localOrders = (root: string) => {
  const db = new Database(join(root, "ledger.sqlite"), { readonly: true });
  try { return db.query("SELECT * FROM lend_orders").all(); } finally { db.close(); }
};
const report = (o: MigrationOutcome) => JSON.parse(readFileSync(o.report, "utf8"));
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(n => statSync(join(dir, n)).isDirectory() ? filesUnder(join(dir, n)) : [join(dir, n)]);
}

describe("X13 验收线 1：预检先暂停派单并备份；unknown 没核清就拒绝，逐项清单", () => {
  test("活跃 worker + 未声明出借单 + unknown 意图：已暂停、已备份，逐项拒绝，中心 0 调用", async () => {
    const w = await world({ workers: true, unknownIntent: true });
    const out = await runExecutionMigration({ root: w.root, plan: plan({ orders: {} }), center: w.center, mode: "commit" });
    expect(out.status).toBe("refused");
    expect(codes(out)).toEqual(["lend_not_declared:order", "lend_unsettled:old-order", "unknown_unreconciled:intent:intent-u", "worker_live:old-task/author"]);
    const r = report(out);
    expect(r.dispatchPaused).toBe(true);
    expect(r.inflight.map((i: any) => `${i.kind}:${i.id}:${i.status}`).sort())
      .toEqual(["intent:intent-u:unknown", "lend:old-order:claimed", "worker:old-task/author:active"]);
    for (const f of r.backup.files) { expect(existsSync(f.path)).toBe(true); expect(sha256File(f.path)).toBe(f.sha256); }
    expect(r.backup.files.map((f: any) => f.name)).toEqual(["ledger.sqlite", "shared-ledger-modes.json"]);
    expect(w.k.center.log).toHaveLength(0);
    expect(readSharedLedgerMode("feature", w.root)).toEqual({ authorityMode: "planning", sharedPlanning: true });
    // 预检结束释放维护锁：调度之后能照常拿到
    const lock = await acquireMaintenance("update", { path: join(w.root, "scheduler-maintenance.lock"),
      request: join(w.root, "scheduler-maintenance.request"), marker: join(w.root, "update-inflight.json") });
    expect(lock).not.toBeNull(); lock!.release();
  });
  test("脚本入口：unknown 未核清 → 退出码 2，stderr 逐项列出", async () => {
    const w = await world({ unknownIntent: true });
    writeFileSync(join(w.root, "plan.json"), JSON.stringify(plan()));
    const lines: string[] = [];
    const exit = await main(["--root", w.root, "--plan", "plan.json", "commit"], { center: () => w.center, print: l => lines.push(l) });
    expect(exit).toBe(2);
    expect(lines.some(l => l.includes("unknown_unreconciled") && l.includes("intent-u"))).toBe(true);
  });
  test("unknown 已人工核清 → 不再挡；调度占着维护锁 → dispatch_not_paused，不备份不调中心", async () => {
    const w = await world({ unknownIntent: true });
    const held = await acquireMaintenance("update", { path: join(w.root, "scheduler-maintenance.lock"),
      request: join(w.root, "scheduler-maintenance.request"), marker: join(w.root, "update-inflight.json") });
    const busy = await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "dry-run" });
    expect(codes(busy)).toEqual(["dispatch_not_paused:scheduler"]);
    expect(existsSync(join(w.root, "shared-ledger-v2-migration", "batch-x13-dry-run", "backup"))).toBe(false);
    held!.release();
    const out = await runExecutionMigration({ root: w.root, center: w.center, mode: "dry-run",
      plan: plan({ reconciled: [{ kind: "intent", id: "intent-u", outcome: "done" }] }) });
    expect(out.status).toBe("dry-run");
  });
});

describe("X13 验收线 2：映射 / 规格副本 / 审查证据缺一项拒绝；旧出借单结清或导入核租约，不重发", () => {
  test("规格副本缺、审查证据缺、租约不符、feature id 不同：逐项拒绝", async () => {
    const w = await world({ stage: "review" });
    const p = plan({ orders: { "old-order": { disposition: "import", leaseGen: 2, head: H } }, centerFeatureIds: { feature: "feature-center" } },
      m => { m.tasks[0].stage = "review"; m.tasks[0].spec = { ...m.tasks[0].spec, visibility: "home_only", artifactId: null, sharedDigest: null }; });
    const out = await runExecutionMigration({ root: w.root, plan: p, center: w.center, mode: "commit" });
    expect(codes(out)).toEqual(["feature_id_mismatch:feature", "lend_lease_mismatch:old-order", "review_evidence_missing:task", "spec_copy_missing:task"]);
    expect(w.k.center.log).toHaveLength(0);
  });
  test("本机卡没有映射 / 审查报告哈希不符 → 拒绝", async () => {
    const w = await world({ stage: "review" });
    mkdirSync(join(w.root, "reports"));
    writeFileSync(join(w.root, "reports", "task.md"), "审查报告");
    const p = plan({ reviews: { task: { reportPath: "reports/task.md", digest: "0".repeat(64) } } },
      m => { m.mappings = m.mappings.map((x: any) => x.kind === "task" ? { ...x, sourceId: "ghost-task" } : x); });
    const out = await runExecutionMigration({ root: w.root, plan: p, center: w.center, mode: "commit" });
    expect(codes(out)).toEqual(["mapping_missing:old-task", "mapping_unknown_source:ghost-task", "review_evidence_digest:task"]);
  });
  test("显式导入并核对租约：迁移成功，证据 imported_reconciled，中心与本机都没有新出借单", async () => {
    const w = await world({ stage: "review" });
    mkdirSync(join(w.root, "reports"));
    writeFileSync(join(w.root, "reports", "task.md"), "审查报告");
    const before = localOrders(w.root);
    const p = plan({ reviews: { task: { reportPath: "reports/task.md", digest: sha256File(join(w.root, "reports", "task.md")) } } },
      m => { m.tasks[0].stage = "review"; });
    const out = await runExecutionMigration({ root: w.root, plan: p, center: w.center, mode: "commit" });
    expect(out.status).toBe("switched");
    expect(report(out).batch.mappings.some((x: any) => x.kind === "order" && x.sourceId === "old-order")).toBe(true);
    expect(w.k.center.rows().orders.size).toBe(0);
    expect(w.k.center.log.some(e => e.command === "lend.create")).toBe(false);
    expect(localOrders(w.root)).toEqual(before);
  });
  test("旧单已结清：清单不带订单，证据 settled；结清单不需要声明", async () => {
    const w = await world({ order: { status: "done", leaseGen: 3 } });
    const out = await runExecutionMigration({ root: w.root, plan: plan({ orders: {} }, settled), center: w.center, mode: "dry-run" });
    expect(out.status).toBe("dry-run");
    const r = report(out);
    expect(r.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(w.k.center.log.map(e => e.route)).toEqual(["migrations", "migration"]);
    expect(w.k.center.rows().orders.size).toBe(0);
  });
});

describe("X13 验收线 3：持久写门 → 整组切换 → 中心租约；第 2 步失败按 batch 回执定位并冻结", () => {
  test("三步都过：中心 execution + 新 epoch + 主场租约，本机 mode execution 绑中心 epoch", async () => {
    const w = await world();
    const out = await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "commit" });
    expect(out).toMatchObject({ status: "switched", epochs: { feature: 2 }, leases: ["task"] });
    expect(w.k.center.feature("feature")).toMatchObject({ authorityMode: "execution", epoch: 2 });
    expect(w.k.center.rows().leases.get("task")).toMatchObject({ epoch: 2, bootId: "boot-local", holderInstanceId: "local" });
    expect(readSharedLedgerMode("feature", w.root)).toEqual({ authorityMode: "execution", sharedPlanning: true,
      centerExecution: { centerId: "center", teamId: "team", projectId: "project", centerFeatureId: "feature", epoch: 2 } });
    // 顺序：迁移提交在前、快照、再租约；scheduler_sessions / 进程锁不在清单里
    expect(w.k.center.log.map(e => e.route ?? "")).toEqual(["migrations", "features", "commands"]);
    expect(report(out).notMigrated).toEqual(["scheduler_sessions", "process locks"]);
    expect(report(out).versions).toBe("verified");
  });
  test("切换响应丢失（中心已提交）：batch 回执 committed，冻结，本机写门保持关闭不回 planning", async () => {
    const w = await world();
    w.k.center.inject({ kind: "drop", route: "migrations" });
    const out = await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "commit" });
    expect(out).toMatchObject({ status: "frozen", step: "switch", batch: { status: "committed", batchId: "batch-x13" } });
    expect(w.k.center.feature("feature")).toMatchObject({ authorityMode: "execution" });
    expect(readSharedLedgerMode("feature", w.root)).toEqual({ authorityMode: "planning", sharedPlanning: true,
      migrating: { batchId: "batch-x13", kind: "execute" } });
    const frozen = JSON.parse(readFileSync(join(w.root, "shared-ledger-v2-migration", "batch-x13", "frozen.json"), "utf8"));
    expect(frozen).toMatchObject({ state: "frozen_pending_pm", step: "switch", batch: { status: "committed" } });
    expect(w.k.center.rows().leases.size).toBe(0);
  });
  test("切换时中心不可用（未提交）：batch 回执 unknown，中心仍 planning，本机仍冻结", async () => {
    const w = await world();
    w.k.center.inject({ kind: "unavailable", route: "migrations" });
    const out = await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "commit" });
    expect(out).toMatchObject({ status: "frozen", step: "switch", batch: { status: "unknown", result: null } });
    expect(w.k.center.feature("feature")).toMatchObject({ authorityMode: "planning", epoch: 1 });
    expect(readSharedLedgerMode("feature", w.root).migrating).toEqual({ batchId: "batch-x13", kind: "execute" });
  });
  test("租约一步失败：逐条回执 unknown，冻结在 lease 步", async () => {
    const w = await world();
    w.k.center.inject({ kind: "unavailable", command: "lease.acquire" });
    const out = await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "commit" });
    expect(out).toMatchObject({ status: "frozen", step: "lease", batch: { status: "committed" },
      receipts: [{ requestId: "batch-x13.lease.task", lookup: { status: "unknown" } }] });
    expect(readSharedLedgerMode("feature", w.root).authorityMode).toBe("planning");
    expect(readSharedLedgerMode("feature", w.root).migrating?.batchId).toBe("batch-x13");
  });
});

describe("X13 验收线 4：中心已有新提交时反向只冻结 → 导出 → 核对报告", () => {
  test("拒绝直接回写旧本机库；本机台账不变，模式冻结，产出导出与报告", async () => {
    const w = await world();
    expect((await runExecutionMigration({ root: w.root, plan: plan(), center: w.center, mode: "commit" })).status).toBe("switched");
    const set = w.k.command("task.set", { taskId: "task", expectedRev: 1, expectedSpecRev: 1, patch: { title: "迁后新提交" } }, { epoch: 2 });
    expect(w.k.post(ACTORS.member, set).status).toBe(200);
    const ledgerBefore = sha256File(join(w.root, "ledger.sqlite"));
    const out = await exportForReverse({ root: w.root, batchId: "batch-x13", featureIds: ["feature"], center: w.center });
    expect(out).toMatchObject({ status: "exported", directWriteBack: "refused", centerAdvanced: true });
    expect(sha256File(join(w.root, "ledger.sqlite"))).toBe(ledgerBefore);
    expect(readSharedLedgerMode("feature", w.root)).toMatchObject({ authorityMode: "execution", migrating: { batchId: "batch-x13", kind: "revert" } });
    const r = JSON.parse(readFileSync(out.report, "utf8"));
    expect(r).toMatchObject({ state: "frozen_pending_pm", directWriteBack: "refused", centerAdvanced: true });
    expect(r.tasks).toEqual([{ centerTaskId: "task", centerStage: "spec", centerRev: 2, localTaskId: "old-task", localStage: "build" }]);
    expect(JSON.parse(readFileSync(out.export, "utf8")).views[0].tasks[0].title).toBe("迁后新提交");
    expect(w.k.center.log.some(e => e.route === "reverts")).toBe(false);
  });
});

describe("X13 验收线 5：测试与脚本不写生产目录", () => {
  test("生产状态目录与非临时目录一律拒绝；脚本拒绝后不建任何文件", async () => {
    for (const p of productionDirs()) expect(() => assertDrillRoot(p)).toThrow(/production_root|not_isolated/);
    expect(() => assertDrillRoot(join(homedir(), ".claude-orchestrator", "drill"))).toThrow(/production_root/);
    expect(() => assertDrillRoot(homedir())).toThrow();
    expect(() => assertDrillRoot(tmpdir())).toThrow(/production_root|not_isolated/);
    const prod = join(homedir(), ".claude-orchestrator", "shared-ledger-v2-migration"), existed = existsSync(prod);
    const lines: string[] = [];
    expect(await main(["--root", join(homedir(), ".claude-orchestrator"), "--plan", "plan.json", "commit"], { print: l => lines.push(l) })).toBe(2);
    expect(lines.join("\n")).toContain("production_root");
    expect(existsSync(prod)).toBe(existed);
  });
  test("整条演练（dry-run → commit → reverse）写下的每个文件都在临时根下", async () => {
    const w = await world();
    writeFileSync(join(w.root, "plan.json"), JSON.stringify(plan()));
    const run = (action: string) => main(["--root", w.root, "--plan", "plan.json", action], { center: () => w.center, print: () => {} });
    expect(await run("dry-run")).toBe(0);
    expect(w.k.center.feature("feature")).toMatchObject({ authorityMode: "planning" });
    expect(await run("commit")).toBe(0);
    expect(await run("reverse")).toBe(3);
    const files = filesUnder(w.root);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(f.startsWith(w.root)).toBe(true);
    for (const name of ["dry-run-report.json", "commit-report.json", "reverse-export.json", "reverse-report.json"]) {
      expect(existsSync(join(w.root, "shared-ledger-v2-migration", "batch-x13", name))).toBe(true);
    }
  });
});
