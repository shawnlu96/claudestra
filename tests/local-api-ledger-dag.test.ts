/**
 * bridge/local-api/ledger-dag.ts：子 DAG 看板三条读路由的权限矩阵（同 local-api-ledger.test.ts）、403 先于 404、405、坏编码 400、
 * 跨项目 404 不区分、库不存在 / 打不开、只读（请求前后库文件 sha256 与 data_version 不变）。库是临时目录里的真实文件。
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { handleLedgerDagApi } from "../src/bridge/local-api/ledger-dag.js";
import { setLedgerApiProjectsForTest } from "../src/bridge/local-api/ledger.js";
import { canReadLedger, effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask, moveStage, setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { runLedger } from "../src/manager/ledger.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const at = "2026-09-28T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

/** 规格卡的权限矩阵（与 /ledger/:project 同一道门）：名字 → [principal, 能不能读] */
const MATRIX: [string, Principal, boolean][] = [
  ["owner 设备 · 全 scope", device({ agents: ["*"], terminal: true, manage: true }), true],
  ["owner 设备 · 全 scope、不带终端", device({ agents: ["*"], terminal: false, manage: true }), true],
  ["owner 设备 · 部分 scope", device({ agents: ["worker"], terminal: true, manage: true }), false],
  ["owner 设备 · 全 scope 但 manage 关", device({ agents: ["*"], terminal: false, manage: false }), false],
  ["guest 设备", device({ agents: ["*"], terminal: false, manage: true }, { id: "guest:g", role: "external", agents: ["*"], createdAt: at }), false],
  ["peer token（历史上签过 *）", { id: "token:tok_peer", role: "external", agents: ["*"], peer: "P", createdAt: at }, false],
  ["老的 * Bearer token（canManage 过渡期放行）", { id: "token:tok_old", role: "external", agents: ["*"], createdAt: at }, true],
  ["部分 scope 的 Bearer token", { id: "token:tok_s", role: "external", agents: ["worker"], createdAt: at }, false],
];
const OWNER = MATRIX[0][1];
const DENIED = MATRIX.filter(([, , ok]) => !ok).map(([, p]) => p);

const root = mkdtempSync(join(tmpdir(), "ledger-dag-api-"));
const dbPath = tempLedgerPath("ledger-dag-api-");
const ROUTES = ["/ledger/p/dag", "/ledger/p/dag/ab12-i28", "/ledger/p/dag/ab12-i28?version=1", "/ledger/p/dag/ab12-i28/diff"];

async function seed(): Promise<void> {
  const db = openLedger(dbPath);
  db.prepare("INSERT INTO ledger_instance (key, value) VALUES ('origin', 'ab12')").run();
  const owner = (now: number) => ({ actor: "owner", now });
  setMeta(db, owner(1), { project: "p", key: "pms", value: ["agent-pm"] });
  createTask(db, owner(10), { project: "p", id: "T1", title: "读接口", kind: "code", agent: "agent-exec" });
  moveStage(db, owner(20), { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, owner(30), { taskId: "T1", from: "restate", to: "build" });
  createTask(db, owner(10), { project: "q", id: "Q1", title: "B 项目的卡", kind: "code", agent: "agent-qx", branch: "q-branch" });
  const run = (project: string, ...args: string[]) => runLedger([...args, "--project", project], {
    db, actor: "owner", projectIds: ["p", "q"], now: () => 100,
    loadRegistry: async () => ({ socket: "", agents: {} }) as never, saveRegistry: async () => {}, notifyOwner: async () => true,
  }) as Promise<Record<string, any>>;
  for (const r of [
    await run("p", "feature-new", "i28", "--title", "协作底座"),
    await run("p", "dag-init", "i28", "--rev", "1", "--nodes", JSON.stringify([{ taskId: "T1" }, { key: "Z", oneLine: "计划" }])),
    await run("p", "dag-rewrite", "i28", "--rev", "2", "--nodes", JSON.stringify([{ key: "T1", taskId: "T1", oneLine: "读接口", deps: [] },
      { key: "Z", oneLine: "计划", deps: [] }, { key: "M", oneLine: "新计划", deps: [] }]), "--reason-kind", "new_issue", "--reason", "加一个"),
    await run("q", "feature-new", "secret", "--title", "B 项目的 feature"),
    await run("q", "dag-init", "secret", "--rev", "1", "--nodes", JSON.stringify([{ taskId: "Q1" }])),
  ]) expect(r.ok).toBe(true);
  // 手改库：p 的节点绑到 q 的卡上
  db.prepare("INSERT INTO dag_bindings (featureId, version, nodeKey, taskId, boundBy, boundAt) VALUES ('ab12-i28', 2, 'Z', 'Q1', 'hand', 1)").run();
  closeLedger(dbPath);
}

beforeAll(async () => {
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: ["p", "q", "empty"].map((id) => ({ id, name: id, dirs: [] })) }));
  setLedgerApiProjectsForTest(join(root, "projects.json"));
  await seed();
  setLedgerFeedForTest({ path: dbPath, emit: () => {} });
});
afterAll(() => {
  setLedgerApiProjectsForTest(undefined);
  setLedgerFeedForTest(undefined);
});

async function get(path: string, p: Principal = OWNER, method = "GET"): Promise<Response> {
  const r = new Request(`http://bridge.local/api/v1${path}`, { method });
  return (await handleLocalApi(r, new URL(r.url), p))!;
}
const body = async (path: string) => (await (await get(path)).json()) as any;

describe("权限：canReadLedger 矩阵（三条路由一致）", () => {
  for (const [name, p, ok] of MATRIX) {
    test(`${name} → ${ok ? "200" : "403"}`, async () => {
      expect(canReadLedger(p)).toBe(ok);
      for (const path of ROUTES) expect((await get(path, p)).status).toBe(ok ? 200 : 403);
    });
  }
  test("403 先于一切：项目 / feature 不存在、坏编码、坏参数、非 GET，拿不到门的人一律 403，探不出存在性", async () => {
    const probes = ["/ledger/nope/dag", "/ledger/p/dag/nope", "/ledger/q/dag/ab12-i28", "/ledger/p/dag/%E0%A4%A", "/ledger/p/dag/ab12-i28?version=x",
      "/ledger/p/dag/ab12-i28/diff?from=9&to=1", "/ledger/p/dag/ab12-secret/diff"];
    for (const p of DENIED) {
      for (const path of probes) expect((await get(path, p)).status).toBe(403);
      for (const path of ROUTES) expect((await get(path, p, "POST")).status).toBe(403);
    }
  });
  test("全权：非 GET → 405；能力表里有 ledger-dag", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) for (const path of ROUTES) expect((await get(path, OWNER, method)).status).toBe(405);
    expect(LOCAL_API_FEATURES).toContain("ledger-dag");
  });
});

describe("GET /ledger/:project/dag", () => {
  test("快照：feature 当前版节点 + agent 行；别的项目的卡按 missing，不带出任何字段", async () => {
    const b = await body("/ledger/p/dag");
    expect(b).toMatchObject({ ok: true, project: "p", exists: true });
    expect(b.asOfSeq).toBeGreaterThan(0);
    expect(b.features.map((f: any) => f.id)).toEqual(["ab12-i28"]);
    const nodes = b.features[0].nodes;
    expect(nodes.find((n: any) => n.key === "T1")).toMatchObject({ phase: "active", since: 30, handler: { role: "executor", agent: "agent-exec" } });
    expect(nodes.find((n: any) => n.key === "Z")).toMatchObject({ missing: true, taskId: "Q1", status: null, title: null, handler: null, branch: null });
    expect(b.agents.map((r: any) => r.agent)).toEqual(["pm", "exec"]);
    const text = JSON.stringify(b);
    for (const leak of ["B 项目", "agent-qx", "q-branch", "ab12-secret"]) expect(text).not.toContain(leak);
  });
  test("项目不在 projects.json → 404；在但没有 feature → 空", async () => {
    expect((await get("/ledger/nope/dag")).status).toBe(404);
    expect(await body("/ledger/empty/dag")).toMatchObject({ ok: true, exists: true, features: [], agents: [] });
  });
});

describe("GET /ledger/:project/dag/:featureId[/diff]", () => {
  test("版本列表 + 快照：缺省当前版、?version=n、pending 没有 → 404、不存在的版本 → 404", async () => {
    const d = await body("/ledger/p/dag/ab12-i28");
    expect(d.feature).toMatchObject({ id: "ab12-i28", currentVersion: 2 });
    expect(d.feature.nodes).toBeUndefined();
    expect(d.versions.map((v: any) => [v.version, v.delta])).toEqual([[1, null], [2, { added: 1, removed: 0, changed: 1, cancelled: 0 }]]); // changed = Z 在 v2 被手改绑到了 Q1
    expect(d.snapshot).toMatchObject({ version: 2, meta: { version: 2, reasonKind: "new_issue" } });
    expect((await body("/ledger/p/dag/ab12-i28?version=1")).snapshot.nodes.map((n: any) => n.key)).toEqual(["T1", "Z"]);
    for (const q of ["?version=pending", "?version=3", "?version=0"]) expect((await get(`/ledger/p/dag/ab12-i28${q}`)).status).toBe(404);
  });
  test("diff：缺省 to = 当前、from = to − 1；from ≥ to → 400；越界 → 404；pending 只能在 to", async () => {
    expect(await body("/ledger/p/dag/ab12-i28/diff")).toMatchObject({ ok: true, featureId: "ab12-i28", from: 1, to: 2, diff: { added: ["M"] }, rewrittenDone: [] });
    expect((await body("/ledger/p/dag/ab12-i28/diff?from=1&to=2")).phaseNow).toEqual({ T1: "active", Z: "active", M: "idle" });
    expect((await get("/ledger/p/dag/ab12-i28/diff?from=2&to=2")).status).toBe(400);
    expect((await get("/ledger/p/dag/ab12-i28/diff?from=2&to=1")).status).toBe(400);
    expect((await get("/ledger/p/dag/ab12-i28/diff?from=pending")).status).toBe(400);
    expect((await get("/ledger/p/dag/ab12-i28/diff?to=9")).status).toBe(404);
    expect((await get("/ledger/p/dag/ab12-i28/diff?to=pending")).status).toBe(404);
  });
  test("feature 不存在与属于别的项目同一个 404；只认全 id；坏编码 / 控制字符 / 超长 → 400", async () => {
    const miss = await get("/ledger/p/dag/nope");
    const cross = await get("/ledger/p/dag/ab12-secret");
    expect([miss.status, cross.status]).toEqual([404, 404]);
    expect((await get("/ledger/p/dag/ab12-secret/diff")).status).toBe(404);
    expect((await get("/ledger/p/dag/i28")).status).toBe(404);
    expect((await get("/ledger/q/dag/ab12-secret")).status).toBe(200);
    for (const seg of ["%E0%A4%A", "a%00b", "a%0Ab", "x".repeat(201)]) expect((await get(`/ledger/p/dag/${seg}`)).status).toBe(400);
  });
});

describe("只读与库状态", () => {
  const files = () => [dbPath, `${dbPath}-wal`].filter(existsSync).map((f) => createHash("sha256").update(readFileSync(f)).digest("hex"));
  test("请求前后库文件 sha256 与 data_version 不变", async () => {
    const watch = new Database(dbPath, { readonly: true });
    const dv = () => (watch.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    try {
      const before = [files(), dv()];
      for (const path of [...ROUTES, "/ledger/p/dag/ab12-i28/diff?from=1&to=2", "/ledger/q/dag/ab12-secret"]) expect((await get(path)).status).toBe(200);
      expect([files(), dv()]).toEqual(before);
    } finally {
      watch.close();
    }
  });
  test("库不存在：/dag 回 exists:false，feature 路由 404；库打不开 → 503", async () => {
    setLedgerFeedForTest({ path: join(root, "none", "ledger.sqlite"), emit: () => {} });
    try {
      expect(await body("/ledger/p/dag")).toMatchObject({ ok: true, exists: false, features: [], agents: [] });
      expect((await get("/ledger/p/dag/ab12-i28")).status).toBe(404);
      const junk = join(root, "junk.sqlite");
      writeFileSync(junk, "not a database at all, just text padding ".repeat(200));
      setLedgerFeedForTest({ path: junk, emit: () => {} });
      expect((await get("/ledger/p/dag")).status).toBe(503);
      expect((await get("/ledger/p/dag/ab12-i28/diff")).status).toBe(503);
    } finally {
      setLedgerFeedForTest({ path: dbPath, emit: () => {} });
    }
  });
  test("路径不是本族的不接（交给别的族）", async () => {
    for (const path of ["/ledger/p", "/ledger/p/dagx", "/ledger/p/dag/a/b", "/ledger/p/dag/a/diff/x"]) {
      expect(await handleLedgerDagApi(new Request("http://bridge.local/"), path, OWNER, new URL("http://bridge.local/"))).toBeNull();
    }
  });
});
