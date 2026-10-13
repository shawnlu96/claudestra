/**
 * GET /api/v1/usage/task/:id 的 summary（UXUSAGE1 验收线 3、4）：逐行结果不变，另给按家族合计（归档 + 明细，明细与逐行加总一致）、
 * 出借单数（台账 lend_orders，标「未回传」）、估算占本周额度（额度与本机本周 token 齐了才给）；非全权凭据仍 403；taskDetail 不带用量。
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import { setUsageDbPathForTest, setUsageSummaryDepsForTest } from "../src/bridge/local-api/usage.js";
import { effectivePrincipal, type Grant } from "../src/lib/devices.js";
import type { QuotaReport } from "../src/lib/quota-week.js";
import { taskDetail } from "../src/lib/ledger-read.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import type { Principal } from "../src/lib/principals.js";
import { openUsageDb } from "../src/lib/usage-store.js";

const NOW = Date.now();
const H = 3600_000;
const dir = mkdtempSync(join(tmpdir(), "usage-api-summary-"));
const ledgerPath = join(dir, "ledger.sqlite");
let quota: QuotaReport = {};

const at = "2026-10-01T00:00:00Z";
const device = (grant: Grant): Principal => effectivePrincipal({
  principal: { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: at, terminal: true },
  credential: { id: "dev_s", v: 1, type: "bearer", hash: "h", deviceName: "d", grant, createdAt: at, expiresAt: "2099-01-01T00:00:00Z" },
});
const OWNER = device({ agents: ["*"], terminal: true, manage: true });

let seq = 0;
function turn(u: Database, task: string | null, runtime: string, ts: number, tokens: number, session: string) {
  const id = `t${++seq}`;
  u.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime, attr_task, attr_step, attr_round, attr_basis)
    VALUES (?, ?, ?, 0, ?, 'channel', '', ?, ?, 'write', 1, 'worker')`).run(id, `agent-${runtime}`, session, ts, runtime, task);
  u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) VALUES (?, ?, ?, '2026-10-12', 'm', ?, 0, 0, 0, 0)`)
    .run(`${id}:0`, id, ts, tokens);
}

beforeAll(() => {
  const usagePath = join(dir, "usage.sqlite");
  const u = openUsageDb(usagePath);
  turn(u, "T1", "claude-code", NOW - H, 300, "s1");
  turn(u, "T1", "claude-code", NOW - 2 * H, 100, "s2");
  turn(u, "T1", "codex", NOW - H, 50, "s3");
  turn(u, "OTHER", "claude-code", NOW - H, 600, "s4");
  turn(u, null, "codex", NOW - H, 150, "s5");
  u.prepare(`INSERT INTO task_usage_archive (task, family, calls, input, cache_creation, cache_read, output, reasoning, first_at, last_at)
    VALUES ('T1', 'claude', 2, 70, 0, 0, 0, 0, 1000, 2000)`).run();
  u.prepare("INSERT INTO task_usage_archive_sessions (task, family, session_id) VALUES ('T1', 'claude', 's1'), ('T1', 'claude', 's-old')").run();
  u.close();
  const l = openLedger(ledgerPath);
  l.exec("PRAGMA foreign_keys = OFF");
  l.prepare("INSERT INTO items (project, id, title, status, createdAt, updatedAt) VALUES ('p', 'i1', 'x', 'doing', 0, 0)").run();
  l.prepare("INSERT INTO tasks (id, project, itemId, title, kind, stage, createdAt, updatedAt) VALUES ('T1', 'p', 'i1', 'T1', 'code', 'build', 0, 0)").run();
  const order = l.prepare(`INSERT INTO lend_orders (orderId, taskId, project, peer, family, step, specRev, round, head, repo, wire, text, sha256, status, leaseMs,
    createdBy, createdAt, updatedAt) VALUES (?, 'T1', 'p', 'peer', ?, 'write', 1, 0, 'h', 'r', '{}', '', 's', ?, 1, 'pm', 0, 0)`);
  order.run("o1", "codex", "done");
  order.run("o2", "codex", "cancelled");
  closeLedger(ledgerPath); // openLedger 按路径缓存连接：关要走 closeLedger，后面才能再开
  setUsageDbPathForTest(usagePath);
  setUsageSummaryDepsForTest({ ledger: ledgerPath, quota: async () => quota });
});
afterAll(() => {
  setUsageDbPathForTest(null);
  setUsageSummaryDepsForTest(null);
  closeLedger(ledgerPath);
});

async function get(p: Principal, id = "T1") {
  const r = new Request(`http://bridge.local/api/v1/usage/task/${id}`);
  return (await handleLocalApi(r, new URL(r.url), p))!;
}
const json = async (id = "T1"): Promise<any> => (await get(OWNER, id)).json();

test("[验收线 3] 按家族的明细合计与逐行结果加总一致；合计含归档；会话合并去重", async () => {
  const body = await json();
  const byRuntime = (rt: string) => body.rows.filter((r: any) => r.runtime === rt).reduce((s: number, r: any) => s + r.totalTokens, 0);
  expect(body.rows).toHaveLength(2);
  const { claude, codex } = body.summary.families;
  expect(claude.detail.totalTokens).toBe(byRuntime("claude-code"));
  expect(codex.detail.totalTokens).toBe(byRuntime("codex"));
  expect(claude).toMatchObject({ totalTokens: 470, calls: 4, sessions: 3, firstAt: 1000 });
  expect(codex).toMatchObject({ totalTokens: 50, archived: null, sessions: 1 });
  expect(body.summary).toMatchObject({ totalTokens: 520, hasArchive: true, detailFrom: "2026-10-12" });
});

test("[验收线 3] 出借单给单数、标未回传，没有 token 数", async () => {
  const { lent } = (await json()).summary;
  expect(lent).toEqual({ codex: { orders: 2, byStatus: { done: 1, cancelled: 1 }, tokensReported: false, note: "用量对方未回传" } });
  expect((await json("NOPE")).summary.lent).toEqual({});
});

test("[验收线 3] 估算占比：额度齐全按本周 token 算，缺额度的家族不给", async () => {
  quota = {};
  expect((await json()).summary.weekEstimate).toEqual({});
  quota = { claude: { weekUsedPct: 30, resetAt: NOW + 24 * H } };
  const est = (await json()).summary.weekEstimate;
  expect(Object.keys(est)).toEqual(["claude"]);
  // 本卡本周 claude 400（归档不在本周）÷ 本机本周 claude 1000 × 30% = 12%
  expect(est.claude).toMatchObject({ taskWeekTokens: 400, machineWeekTokens: 1000, estimatePct: 12, estimateLabel: "约 12%" });
  quota = { claude: { weekUsedPct: 30, resetAt: NOW - H + 7 * 24 * H + 1 } }; // 周起点晚于这些调用：本机本周 0 → 不给
  expect((await json()).summary.weekEstimate).toEqual({});
});

test("[验收线 4] 非全权凭据仍 403；台账 taskDetail 不带用量", async () => {
  const partial = device({ agents: ["worker"], terminal: true, manage: true });
  expect((await get(partial)).status).toBe(403);
  expect((await get({ id: "token:t", role: "external", agents: ["*"], createdAt: at })).status).toBe(403);
  const l = openLedger(ledgerPath);
  const detail = taskDetail(l, "p", "T1", NOW);
  expect(detail).not.toBeNull();
  expect(JSON.stringify(detail)).not.toMatch(/totalTokens|weekEstimate|tokensReported/);
});

test("[验收线 3] 同名 agent 同一步换了运行家族：逐行按家族拆开，rows.runtime 能和汇总的家族对上", async () => {
  const u = openUsageDb(join(dir, "usage.sqlite"));
  for (const [rt, sid] of [["claude-code", "mx-1"], ["codex", "mx-2"]]) {
    const id = `t${++seq}`;
    u.prepare(`INSERT INTO turns (turn_id, agent, session_id, sidechain, started_at, kind, trigger, runtime, attr_task, attr_step, attr_round, attr_basis)
      VALUES (?, 'agent-same', ?, 0, ?, 'channel', '', ?, 'MIX', 'write', 1, 'worker')`).run(id, sid, NOW - H, rt);
    u.prepare(`INSERT INTO calls (key, turn_id, ts, day, model, input, cache_creation, cache_read, output, reasoning) VALUES (?, ?, ?, '2026-10-12', 'm', 100, 0, 0, 0, 0)`)
      .run(`${id}:0`, id, NOW - H);
  }
  u.close();
  const body = await json("MIX");
  expect(body.rows.map((r: any) => [r.runtime, r.totalTokens]).sort()).toEqual([["claude-code", 100], ["codex", 100]]);
  expect(body.summary.families.claude.detail.totalTokens).toBe(100);
  expect(body.summary.families.codex.detail.totalTokens).toBe(100);
});
