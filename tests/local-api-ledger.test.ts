/**
 * bridge/local-api/ledger.ts + bridge/ledger-feed.ts：台账读接口的权限矩阵、项目校验、视图、docs 路径穿越，
 * 以及 SSE 过滤（ledger 事件只给 canReadLedger）与懒启动的每秒轮询。库是临时目录里的真实文件。
 * SSE 段每个用例在独立子进程里跑（local-api-ledger-feed-fixture.ts），不碰本进程的 feed / event-bus。
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentListExtras } from "../src/bridge/agent-info-routes.js";
import { setLedgerFeedForTest } from "../src/bridge/ledger-feed.js";
import { handleLocalApi, LOCAL_API_FEATURES } from "../src/bridge/local-api/index.js";
import { handleLedgerApi, setLedgerApiProjectsForTest } from "../src/bridge/local-api/ledger.js";
import { canReadLedger, effectivePrincipal, type DeviceCredential, type Grant } from "../src/lib/devices.js";
import { taskMetrics } from "../src/lib/ledger-metrics.js";
import { closeLedger, LEDGER_SCHEMA_VERSION, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { setMeta } from "../src/lib/ledger-write.js";
import type { Principal } from "../src/lib/principals.js";
import { runFeedScenario, type AgentResult, type E2eResult, type LazyResult } from "./local-api-ledger-feed-fixture.js";
import { runLedgerScript, seedLedger, tempLedgerPath } from "./ledger-test-helpers.js";

const at = "2026-09-28T00:00:00Z";
const cred = (grant: Grant): DeviceCredential => ({ id: "dev_x", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" });
const OWNER_BASE: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true };
const device = (grant: Grant, base: Principal = OWNER_BASE) => effectivePrincipal({ principal: base, credential: cred(grant) });

/** 规格卡的权限矩阵：名字 → [principal, 能不能读台账] */
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

const root = mkdtempSync(join(tmpdir(), "ledger-api-"));
const docs = join(root, "docs");
const dbPath = tempLedgerPath();

beforeAll(() => {
  mkdirSync(join(docs, "sub"), { recursive: true });
  writeFileSync(join(docs, "T8c.md"), "# 规格卡\n");
  writeFileSync(join(docs, "sub", "report.md"), "报告");
  writeFileSync(join(docs, "shot.png"), "png-bytes");
  writeFileSync(join(docs, "pic.JPEG"), "jpeg-bytes");
  writeFileSync(join(docs, "notes.txt"), "不在白名单");
  writeFileSync(join(root, "secret.md"), "docsDir 外面");
  symlinkSync(join(docs, "T8c.md"), join(docs, "link-in.md"));
  symlinkSync(join(root, "secret.md"), join(docs, "link-out.md"));
  symlinkSync(join(docs, "notes.txt"), join(docs, "link-txt.md"));
  writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p", name: "P", dirs: [] }, { id: "empty", name: "E", dirs: [] }] }));
  setLedgerApiProjectsForTest(join(root, "projects.json"));
  seedLedger(dbPath, { docsDir: docs });
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
/** 绕过 URL 规范化，直接把原始路径交给 handler（`..` 在 new URL 里会先被折叠掉） */
async function raw(path: string): Promise<Response> {
  return (await handleLedgerApi(new Request("http://bridge.local/"), path, OWNER))!;
}

describe("权限：canReadLedger 矩阵（三个端点一致）", () => {
  for (const [name, p, ok] of MATRIX) {
    test(`${name} → ${ok ? "200" : "403"}`, async () => {
      expect(canReadLedger(p)).toBe(ok);
      for (const path of ["/ledger/p", "/ledger/p/tasks/T1", "/ledger/p/docs/T8c.md"]) {
        expect((await get(path, p)).status).toBe(ok ? 200 : 403);
      }
    });
  }
  test("403 在查项目之前：不能读台账的人探不出项目在不在", async () => {
    expect((await get("/ledger/nope", MATRIX[2][1])).status).toBe(403);
  });
});

describe("GET /ledger/:project", () => {
  test("项目不在 projects.json → 404（台账里有也不行）；非 GET → 405；能力表里有 ledger", async () => {
    expect((await get("/ledger/q")).status).toBe(404);
    expect((await get("/ledger/p", OWNER, "POST")).status).toBe(405);
    expect(LOCAL_API_FEATURES).toContain("ledger");
  });

  test("总览：事项、任务带 lastEvent 与服务端算的指标（与 ledger-metrics 一致）、冻结状态、项目级事件", async () => {
    const res = await get("/ledger/p");
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, project: "p", exists: true, schema: LEDGER_SCHEMA_VERSION, audit: [] });
    expect(body.meta).toMatchObject({ docsDir: docs, queueFrozen: { frozen: true, reason: "等 T1 上线" } });
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["i1"]);
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual(["T1", "T2"]);
    const db = openLedger(dbPath);
    try {
      const all = listEvents(db, { project: "p" });
      // 总览只带首页要的几个计数（0 / null 不发），完整指标走单卡接口
      expect(body.tasks.map((t: any) => t.metrics)).toEqual([{ reviewRounds: 2, p1: 1 }, { endTs: 600 }]);
      for (const t of body.tasks) {
        const detail = await (await get(`/ledger/p/tasks/${encodeURIComponent(t.id)}`)).json() as any;
        expect(detail.task.metrics).toEqual(taskMetrics(detail.task, all, detail.now));
      }
      expect(body.tasks[0].lastEvent.seq).toBe(all.filter((e) => e.target === "T1").at(-1)!.seq);
    } finally {
      closeLedger(dbPath);
    }
    expect(body.projectEvents.map((e: { kind: string }) => e.kind)).toEqual(["freeze", "meta"]);
    expect(body.deps).toEqual([]);
    expect(body.tasks.map((t: { runnable: boolean; blockedBy: string[] }) => [t.runnable, t.blockedBy])).toEqual([[true, []], [false, []]]);
  });

  test("schema 报库里的 user_version：库比代码新时如实报，并在打开时提醒一次", async () => {
    const path = tempLedgerPath();
    await runLedgerScript(path, `seedLedger(path);\nconst c = new Database(path);\nc.exec("PRAGMA user_version = 99");\nc.close();`);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    setLedgerFeedForTest({ path, emit: () => {} });
    try {
      for (let i = 0; i < 2; i++) expect(((await (await get("/ledger/p")).json()) as any).schema).toBe(99);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("重启 bridge");
    } finally {
      warn.mockRestore();
      setLedgerFeedForTest({ path: dbPath, emit: () => {} });
    }
  });

  test("任务详情：全部事件 + 时间线；别的项目的任务 404", async () => {
    const body = (await (await get("/ledger/p/tasks/T1")).json()) as any;
    expect(body.task).toMatchObject({ id: "T1", stage: "merge", round: 2 });
    expect(body.events.length).toBe(11);
    expect(body.timeline.at(-1).stage).toBe("merge");
    expect([body.deps, body.reviewBranches]).toEqual([{ in: [], out: [] }, { pass: "merge", changes: "fix", taken: "pass" }]);
    expect((await get("/ledger/p/tasks/T3")).status).toBe(404);
    expect((await get("/ledger/p/tasks/nope")).status).toBe(404);
  });

  test("库还不存在：总览回空台账（exists:false），任务与文档 404", async () => {
    setLedgerFeedForTest({ path: join(root, "none", "ledger.sqlite"), emit: () => {} });
    try {
      const body = (await (await get("/ledger/empty")).json()) as any;
      expect(body).toMatchObject({ ok: true, exists: false, items: [], tasks: [], deps: [], projectEvents: [], audit: [], meta: { docsDir: null } });
      expect((await get("/ledger/empty/tasks/T1")).status).toBe(404);
      expect((await get("/ledger/empty/docs/T8c.md")).status).toBe(404);
    } finally {
      setLedgerFeedForTest({ path: dbPath, emit: () => {} });
    }
  });
});

describe("GET /ledger/:project/docs/<path>", () => {
  test("白名单内的文件原样给出，Content-Type 按扩展名、nosniff、不缓存；子目录与指向根内的软链可以", async () => {
    const md = await get("/ledger/p/docs/T8c.md");
    expect(md.status).toBe(200);
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(md.headers.get("Cache-Control")).toBe("no-store");
    expect(await md.text()).toBe("# 规格卡\n");
    expect((await get("/ledger/p/docs/shot.png")).headers.get("Content-Type")).toBe("image/png");
    expect((await get("/ledger/p/docs/pic.JPEG")).headers.get("Content-Type")).toBe("image/jpeg");
    expect(await (await get("/ledger/p/docs/sub/report.md")).text()).toBe("报告");
    expect(await (await get("/ledger/p/docs/sub%2Freport.md")).text()).toBe("报告");
    expect(await (await get("/ledger/p/docs/link-in.md")).text()).toBe("# 规格卡\n");
  });

  test("穿越：`..`（原样 / 编码 / 编码斜杠）、绝对路径、指向根外的软链 → 403", async () => {
    expect((await raw("/ledger/p/docs/../secret.md")).status).toBe(403);
    expect((await raw("/ledger/p/docs/sub/../../secret.md")).status).toBe(403);
    expect((await get("/ledger/p/docs/..%2Fsecret.md")).status).toBe(403);
    expect((await get("/ledger/p/docs/%2e%2e%2Fsecret.md")).status).toBe(403);
    expect((await get("/ledger/p/docs/%2F..%2Fsecret.md")).status).toBe(403);
    expect((await get(`/ledger/p/docs/${encodeURIComponent(join(root, "secret.md"))}`)).status).toBe(403);
    expect((await get("/ledger/p/docs/link-out.md")).status).toBe(403);
  });

  test("解码失败 / 带 NUL → 400；不在白名单（含软链到 .txt 的 .md）、不存在、目录 → 404", async () => {
    expect((await get("/ledger/p/docs/%E0%A4%A.md")).status).toBe(400);
    expect((await get("/ledger/p/docs/T8c.md%00.png")).status).toBe(400);
    expect((await get("/ledger/%E0%A4%A")).status).toBe(400);
    expect((await get("/ledger/p/docs/notes.txt")).status).toBe(404);
    expect((await get("/ledger/p/docs/link-txt.md")).status).toBe(404);
    expect((await get("/ledger/p/docs/missing.md")).status).toBe(404);
    expect((await get("/ledger/p/docs/sub")).status).toBe(404);
  });

  test("docsDir 被设成 / 、家目录、/tmp（傘形根）→ 404，不把整机的 .md / 图片放出去", async () => {
    const sub = mkdtempSync("/tmp/ledger-umbrella-");
    writeFileSync(join(sub, "a.md"), "真实存在");
    const name = sub.slice("/tmp/".length);
    const cases: [string, string, number][] = [
      [sub, "a.md", 200], // 对照：同一个文件从正常 docsDir 读得到
      ["/tmp", `${name}/a.md`, 404],
      ["/private/tmp", `${name}/a.md`, 404],
      ["/", `tmp/${name}/a.md`, 404],
      [process.env.HOME!, "x.md", 404],
    ];
    for (const [dir, rel, status] of cases) {
      const w = openLedger(dbPath);
      try {
        setMeta(w, { actor: "owner" }, { project: "empty", key: "docsDir", value: dir });
      } finally {
        closeLedger(dbPath);
      }
      expect([dir, (await get(`/ledger/empty/docs/${rel}`)).status]).toEqual([dir, status]);
    }
  });

  test("项目没设 docsDir → 404", async () => {
    expect((await get("/ledger/empty/docs/T8c.md")).status).toBe(404);
  });
});

test("GET /agents 的 ledgerTask 默认从同一条只读连接读：执行中的任务按裸名挂上，终态不挂，不能读的人没有", async () => {
  const own = await agentListExtras(OWNER); // 默认 io：principals / missions 走 preload 的临时状态目录
  expect(own("agent-exec", {}).ledgerTask).toEqual({ id: "T1", stage: "merge", round: 2 });
  expect(own("other", {}).ledgerTask).toEqual({ id: "T3", stage: "spec", round: 0 });
  expect((await agentListExtras(MATRIX[2][1]))("agent-exec", {}).ledgerTask).toBeUndefined();
});

describe("SSE：ledger 事件只给 canReadLedger；轮询在第一条能读的连接上懒启动（每个用例一个独立子进程，见 feed-fixture）", () => {
  const conns = (rows: typeof MATRIX) => rows.map(([name, principal]) => ({ name, principal }));

  test("端到端：写入 → 覆盖它的那一轮轮询里能读的连接收到 {project}，其余连接收不到；多条能读的连接只起一个轮询", async () => {
    const r = await runFeedScenario<E2eResult>({ kind: "e2e", conns: conns(MATRIX) });
    for (const [name, , ok] of MATRIX) expect([name, r.got[name]]).toEqual([name, ok ? [{ project: "p" }] : []]);
    expect([r.emitted, r.timers]).toEqual([[{ project: "p" }], 1]);
  });

  test("只有不能读台账的连接时不起轮询；第一条能读的连接先记游标，之后别的项目的写入才发", async () => {
    const denied = MATRIX.filter(([, , ok]) => !ok);
    const r = await runFeedScenario<LazyResult>({ kind: "lazy", denied: conns(denied), reader: { name: "owner", principal: OWNER } });
    expect([r.deniedTimers, r.readerTimers]).toEqual([0, 1]);
    expect([r.emitted, r.got.owner]).toEqual([[{ project: "q" }], [{ project: "q" }]]);
    for (const [name] of denied) expect([name, r.got[name]]).toEqual([name, []]);
  });

  test("agent 事件的过滤不变：* 不含 master，部分 scope 只看自己的", async () => {
    const r = await runFeedScenario<AgentResult>({ kind: "agent", conns: conns([MATRIX[6], MATRIX[7]]), agents: ["agent-worker", "master", "agent-master", "agent-other"] });
    expect(r[MATRIX[6][0]]).toEqual([true, false, false, true]);
    expect(r[MATRIX[7][0]]).toEqual([true, false, false, false]);
  });
});
