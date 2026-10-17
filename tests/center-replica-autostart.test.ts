/**
 * merge-arch-CREPAUTO1：中心副本里已发布的节点由调度器自动认领开工（验收线 1–4）。真实的副本 sync + 中心认领 + autostartTick，
 * 中心是 shared-center-kit 的本地假中心，binds 接口由这里的假实现接（只认「节点没绑、版本 / rev 对得上」就提交）。
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InventoryQuota } from "../src/lib/ai-quota.js";
import type { StepIO } from "../src/lib/dag-tools-steps.js";
import { instanceIdSync } from "../src/lib/instance-id.js";
import { getFeature } from "../src/lib/ledger-feature.js";
import { getTask, listEvents } from "../src/lib/ledger-store.js";
import { acquireLock } from "../src/lib/file-lock.js";
import { statePath } from "../src/lib/paths.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { SchedulerStopped } from "../src/lib/scheduler-maintenance.js";
import { featureGate } from "../src/lib/scheduler-autostart.js";
import { autostartTick, type StartTickEnv } from "../src/lib/scheduler-autostart-run.js";
import { featureProposalError, parseFeatureHomeBind, type FeatureHomeBind } from "../src/lib/shared-ledger-contract-v2-feature-proposals.js";
import { v2ObjectDigest } from "../src/lib/shared-ledger-contract-v2-integrity.js";
import { readCenterClaims } from "../src/lib/shared-ledger-center-claims.js";
import { claimCenterNode, configureCenterStart } from "../src/lib/shared-ledger-center-start.js";
import { fakeFeature, LOCAL_ID, replicaKit } from "./shared-center-kit.js";

type Kit = Awaited<ReturnType<typeof replicaKit>>;
let open: Kit | null = null;
afterEach(async () => {
  configureCenterStart(undefined);
  rmSync(RECOVERY_POLICY_PATH, { force: true });
  rmSync(SCHEDULER_CONFIG_PATH, { force: true });
  await open?.close();
  open = null;
});

const BINDS = "/v1/feature-proposals/binds";
const TASK = `${LOCAL_ID}-alpha`;
const QUOTA: InventoryQuota = { status: "known", source: "live", observedAt: 1, plan: null, reason: null,
  windows: [{ id: "7d", kind: "weekly", usedPct: 10, resetsAtMs: 9e12, resetPassed: false }] };

/** binds 的假中心：提交 = 在 kit 中心的 feature 上记绑定、rev+1；GET 按 op 回 committed / unknown。center 计所有发往中心的请求 */
function fakeBinds(k: Kit) {
  const receipts = new Map<string, Record<string, unknown>>();
  const n = { posts: 0, gets: 0, center: 0 };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    n.center++;
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === BINDS && init?.method === "POST") {
      n.posts++;
      const bind = (JSON.parse(String(init.body)) as { payload: FeatureHomeBind }).payload;
      const f = k.center.features.get(bind.featureId)!;
      if (f.bindings.some((b) => b.nodeKey === bind.nodeKey) || f.rev !== bind.expectedRev || f.version !== bind.version) {
        return Response.json(featureProposalError("conflict"), { status: 409 });
      }
      f.rev += 1;
      f.bindings.push({ nodeKey: bind.nodeKey, taskId: `center-${bind.sourceTaskId}` });
      const receipt = { schemaVersion: 1, requestId: bind.operationId, commandDigest: v2ObjectDigest(parseFeatureHomeBind(bind)), serverSeq: 200 + receipts.size,
        committedAt: 1000, result: { featureId: f.id, rev: f.rev, version: f.version } };
      receipts.set(bind.operationId, receipt);
      return Response.json(receipt);
    }
    if (path.startsWith(`${BINDS}/`) && init?.method === "GET") {
      n.gets++;
      const op = path.slice(BINDS.length + 1), receipt = receipts.get(op);
      return Response.json(receipt ? { status: "committed", receipt } : { status: "unknown", requestId: op });
    }
    return fetch(input, init);
  }) as typeof fetch;
  return { n, fetch: impl };
}

function policy(project: string, mode: "on" | "observe" | "off" | null) {
  if (mode === null) return rmSync(RECOVERY_POLICY_PATH, { force: true });
  writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { [project]: { keys: { centerReplicaAutostart: mode } } } }));
}

/** 副本（本实例为主场、本机有 service 凭据）已 sync；规格卡放好并静置；调度 env 的 ledger 是调度身份的进程内 CLI */
/** died：台账写完这一笔后进程被杀（之后什么都没做） */
async function setup(opts: { createFails?: boolean; died?: (args: string[]) => boolean } = {}) {
  const me = instanceIdSync();
  const k = open = await replicaKit({ credentialInstance: me });
  k.center.publish(fakeFeature({ homeInstanceId: me }));
  expect(await k.sync()).toMatchObject({ features: [{ result: "created" }] });
  const b = fakeBinds(k);
  configureCenterStart({ fetch: b.fetch, timeoutMs: 1000 });
  const f = k.f, ledgerDir = f.startEnv.ledgerDir, agents = new Set<string>(), notes: string[] = [], calls: string[][] = [];
  const specPath = (id: string) => join(ledgerDir, "docs", "tasks", `${id}.md`);
  mkdirSync(join(ledgerDir, "docs", "tasks"), { recursive: true });
  const spec = (id: string) => {
    writeFileSync(specPath(id), "# 副本节点\n模板：code\n");
    const aged = new Date(Date.now() - 120_000);
    utimesSync(specPath(id), aged, aged);
  };
  spec(TASK);
  const stepIO = (): Omit<StepIO, "db" | "manager" | "attempt"> => ({ ...f.io, agentExists: (a) => agents.has(a) });
  const env: StartTickEnv = {
    db: f.db, svc: { autoDispatch: true, projects: [f.project], maxWorkers: () => 3 },
    ledger: async (...args) => {
      calls.push(args);
      const r = await f.ledger(args.slice(1), "scheduler");
      if (opts.died?.(args)) throw new SchedulerStopped(`进程被杀：${args.slice(1, 4).join(" ")} 之后`);
      return r;
    },
    plain: async (args) => {
      calls.push(args);
      if (args[0] === "create" && opts.createFails) return { ok: false, error: "合成失败" };
      if (args[0] === "create") agents.add(`agent-${args[1]}`);
      return { ok: true };
    },
    startEnv: () => ({ ...f.startEnv, agentNames: () => [...agents], exists: (p) => p === join(ledgerDir, ".git") || existsSync(p) }),
    stepIO, readSpec: (id) => (existsSync(specPath(id)) ? { mtimeMs: statSync(specPath(id)).mtimeMs, text: readFileSync(specPath(id), "utf8") } : null),
    quota: async () => QUOTA, notifyPm: async (_p, text) => void notes.push(text), memo: new Set(), now: Date.now, attempt: () => "crep-attempt",
  };
  const bound = () => (f.db.query("SELECT taskId FROM dag_bindings WHERE featureId = ? AND nodeKey = 'alpha'").get(LOCAL_ID) as { taskId: string } | null)?.taskId ?? null;
  const events = (op: string) => listEvents(f.db, { project: f.project }).filter((e) => e.data.op === op && (e.data.feature ?? e.target) === LOCAL_ID);
  return { k, b, f, env, notes, calls, bound, events, spec, tick: () => autostartTick(env) };
}

test("[验收线 1] on：已发布、依赖齐、规格齐、车道空的副本节点一轮内在中心认领、建卡、绑节点", async () => {
  const s = await setup();
  policy(s.f.project, "on");
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.posts).toBe(1);
  expect(readCenterClaims()).toMatchObject([{ localFeatureId: LOCAL_ID, key: "alpha", taskId: TASK, state: "committed" }]);
  expect(getTask(s.f.db, TASK)).toMatchObject({ id: TASK, project: s.f.project });
  expect(s.bound()).toBe(TASK);
  expect(s.events("autostart_settle").map((e) => e.data.outcome)).toEqual(["done"]);
  // beta 依赖 alpha（还没完成）：车道门拦住，没去中心认领
  expect(readCenterClaims().filter((c) => c.key === "beta")).toEqual([]);
  expect(s.notes).toEqual([]);
});

test("[验收线 1] observe：只记 recovery_observe（节点、本会认领、放哪），不碰中心、不认领、不建卡；同一份只记一次", async () => {
  const s = await setup();
  policy(s.f.project, "observe");
  expect(await s.tick()).toEqual([]);
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.center).toBe(0);
  expect(readCenterClaims()).toEqual([]);
  expect(getTask(s.f.db, TASK)).toBeNull();
  expect(s.bound()).toBeNull();
  const obs = s.events("recovery_observe");
  expect(obs).toHaveLength(1);
  expect(obs[0]!.data).toMatchObject({ mechanism: "centerReplicaAutostart", feature: LOCAL_ID, node: "alpha", action: "claim", taskId: TASK });
  expect(obs[0]!.text).toContain("在中心认领并开卡");
  expect(String(obs[0]!.data.placement)).toContain("本机");
  expect(s.events("autostart_claim")).toEqual([]);
});

test("缺省（未配置）是 observe：permission 类恢复键", async () => {
  const s = await setup();
  policy(s.f.project, null);
  await s.tick();
  expect(s.b.n.center).toBe(0);
  expect(s.events("recovery_observe")).toHaveLength(1);
  expect(getTask(s.f.db, TASK)).toBeNull();
});

test("[验收线 2] 认领冲突（中心已被别的成员绑走）：跳过并记一条 note，下一轮不再向中心尝试同一冲突", async () => {
  const s = await setup();
  const me = instanceIdSync();
  s.k.center.publish(fakeFeature({ homeInstanceId: me, rev: 6, bindings: [{ nodeKey: "alpha", taskId: "center-other-member" }] }), "none");
  policy(s.f.project, "on");
  expect(await s.tick()).toEqual([]);
  const skips = s.events("center_replica_skip");
  expect(skips).toHaveLength(1);
  expect(skips[0]!.data).toMatchObject({ key: "alpha", code: "conflict", taskId: TASK, version: getFeature(s.f.db, LOCAL_ID)!.currentVersion });
  expect(s.b.n.posts).toBe(0);
  expect(getTask(s.f.db, TASK)).toBeNull();
  expect(s.events("autostart_claim")).toEqual([]); // arm 没被烧：规格或版本变了还能再开
  const asked = s.b.n.center;
  expect(await s.tick()).toEqual([]);
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.center).toBe(asked);
  expect(s.events("center_replica_skip")).toHaveLength(1);
  expect(s.notes).toEqual([]);
});

test("[验收线 2] 中心回 409 conflict（POST 被拒）：认领记录落 conflict，记 note，下一轮不再 POST", async () => {
  const s = await setup();
  policy(s.f.project, "on");
  const f = s.k.center.features.get(fakeFeature().id)!;
  const realFetch = s.b.fetch;
  // POST 进来前中心的 rev 被别人推进了：本机拿旧 rev 提交，两次都对不上
  configureCenterStart({ timeoutMs: 1000, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") f.rev += 1;
    return realFetch(input, init);
  }) as typeof fetch });
  await s.tick();
  expect(s.b.n.posts).toBe(2); // 原规则：conflict 后按同版本重试一次
  expect(readCenterClaims().map((c) => c.state)).toEqual(["conflict", "conflict"]);
  expect(s.events("center_replica_skip")).toHaveLength(1);
  await s.tick();
  expect(s.b.n.posts).toBe(2);
  expect(getTask(s.f.db, TASK)).toBeNull();
});

test("[验收线 3] 中心已有本机 committed 认领、本机没有卡（建卡那步断了）：on 补建卡、绑节点，不再认领一次", async () => {
  const s = await setup();
  expect(await claimCenterNode(s.f.db, { id: LOCAL_ID }, "alpha")).toEqual({ ok: true, taskId: TASK });
  expect(s.b.n.posts).toBe(1);
  expect(getTask(s.f.db, TASK)).toBeNull();
  policy(s.f.project, "on");
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.posts).toBe(1);
  expect(s.b.n.gets).toBeGreaterThan(0);
  expect(readCenterClaims()).toMatchObject([{ key: "alpha", taskId: TASK, state: "committed" }]);
  expect(getTask(s.f.db, TASK)).not.toBeNull();
  expect(s.bound()).toBe(TASK);
});

test("[验收线 3] observe 下同一种断链记成「补建卡」", async () => {
  const s = await setup();
  await claimCenterNode(s.f.db, { id: LOCAL_ID }, "alpha");
  policy(s.f.project, "observe");
  const before = s.b.n.center;
  await s.tick();
  expect(s.b.n.center).toBe(before);
  expect(s.events("recovery_observe").map((e) => e.data.action)).toEqual(["repair"]);
});

test("[验收线 4] off：整 feature 跳过（与改前一致），不碰中心、不记样本", async () => {
  const s = await setup();
  policy(s.f.project, "off");
  const f = getFeature(s.f.db, LOCAL_ID)!;
  expect(featureGate(s.f.db, f, s.env.svc)).toMatchObject({ gate: "feature", why: expect.stringContaining("中心副本") });
  await s.tick();
  expect(s.b.n.center).toBe(0);
  expect(readCenterClaims()).toEqual([]);
  expect(["recovery_observe", "center_replica_skip", "autostart_claim"].flatMap(s.events)).toEqual([]);
  expect(getTask(s.f.db, TASK)).toBeNull();
});

test("开卡失败回滚：认领标孤儿、台账 claim 结为 failed，之后不再自动开这个节点", async () => {
  const s = await setup({ createFails: true });
  policy(s.f.project, "on");
  await s.tick();
  expect(readCenterClaims().map((c) => c.state)).toEqual(["orphan"]);
  expect(s.events("autostart_settle").map((e) => e.data.outcome)).toEqual(["failed"]);
  expect(s.bound()).toBeNull();
  expect(getTask(s.f.db, TASK)?.stage ?? "cancelled").toBe("cancelled");
  const posts = s.b.n.posts;
  await s.tick();
  expect(s.b.n.posts).toBe(posts);
});

test("[验收线 3] 中心认领后、建卡前进程被杀：下一轮 claim 结 unknown，按补建 arm 补建卡一次，不再认领；补建也断了就不再自动试", async () => {
  let deaths = 1;
  const s = await setup({ died: (args) => args[2] === "claim" && deaths-- > 0 });
  policy(s.f.project, "on");
  await expect(s.tick()).rejects.toBeInstanceOf(SchedulerStopped);
  expect(readCenterClaims()).toMatchObject([{ key: "alpha", taskId: TASK, state: "committed" }]);
  expect(getTask(s.f.db, TASK)).toBeNull();
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.posts).toBe(1);
  expect(getTask(s.f.db, TASK)).not.toBeNull();
  expect(s.bound()).toBe(TASK);
  expect(s.events("autostart_settle").map((e) => e.data.outcome)).toEqual(["unknown", "done"]);
  expect(new Set(s.events("autostart_claim").map((e) => e.data.arm)).size).toBe(2);
});

test("[验收线 3] 补建只给一次：补建那次也在建卡前断了，之后不再自动开", async () => {
  const s = await setup({ died: (args) => args[2] === "claim" });
  policy(s.f.project, "on");
  await expect(s.tick()).rejects.toBeInstanceOf(SchedulerStopped);
  await expect(s.tick()).rejects.toBeInstanceOf(SchedulerStopped);
  await s.tick();
  await s.tick();
  expect(s.events("autostart_claim")).toHaveLength(2);
  expect(s.events("autostart_settle").map((e) => e.data.outcome)).toEqual(["unknown", "unknown"]);
  expect(s.b.n.posts).toBe(1);
  expect(getTask(s.f.db, TASK)).toBeNull();
});

test("[验收线 3] 中心已按自定义卡号认领（PM 的 start_node 带 taskId）、本机没卡：沿用那个卡号补建，不按默认卡号再认领", async () => {
  const s = await setup();
  const custom = "roster-custom-alpha";
  expect(await claimCenterNode(s.f.db, { id: LOCAL_ID }, "alpha", custom)).toEqual({ ok: true, taskId: custom });
  s.spec(custom);
  policy(s.f.project, "on");
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.posts).toBe(1);
  expect(getTask(s.f.db, custom)).not.toBeNull();
  expect(getTask(s.f.db, TASK)).toBeNull();
  expect(s.bound()).toBe(custom);
  expect(s.events("autostart_claim").map((e) => e.data.taskId)).toEqual([custom]);
  expect(readCenterClaims()).toMatchObject([{ key: "alpha", taskId: custom, state: "committed" }]);
});

test("本机作者 Codex、全机槽锁被占：中心认领后台账零写、arm 不烧；放开槽后下一轮按已有认领补建，不再 POST", async () => {
  const s = await setup();
  const runtime = (extra: object) => writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { [s.f.project]: { maxActiveWorkers: 3, requiredChecks: ["check"], repoDir: s.f.startEnv.ledgerDir, ...extra } } }));
  runtime({ localAuthorRuntime: "codex" });
  policy(s.f.project, "on");
  const held = (await acquireLock(statePath("scheduler-local-codex.lock"), 0))!;
  try {
    expect(await s.tick()).toEqual([]);
  } finally { held.release(); }
  expect(readCenterClaims()).toMatchObject([{ key: "alpha", taskId: TASK, state: "committed" }]);
  expect(s.events("autostart_claim")).toEqual([]);
  expect(getTask(s.f.db, TASK)).toBeNull();
  runtime({});
  expect(await s.tick()).toEqual([]);
  expect(s.b.n.posts).toBe(1);
  expect(s.bound()).toBe(TASK);
  expect(s.events("autostart_settle").map((e) => e.data.outcome)).toEqual(["done"]);
});
