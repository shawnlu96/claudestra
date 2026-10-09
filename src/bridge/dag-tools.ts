import { recoveryPolicy } from "../lib/recovery-policy.js";
import { setFeatureDeps } from "../lib/ledger-feature-deps-tool.js";
import { placementReservationPort } from "../lib/scheduler-placement-reservations.js";
/**
 * 子 DAG 与开卡的 MCP 工具（i28-L5，docs/architecture/dag-tools.md），挂进 bridge/order-tools.ts 的 HANDLERS。
 * 身份门（requireVerified）已在 routeOrderTool 过了；写类工具（plan_feature / rewrite_dag / start_node）再按台账角色拒：只有该项目 PM 名单里的 agent
 * 与 master 能调——manager CLI 以调用方频道认 actor 后还会再判一次，这一道挡在任何写动作之前（start_node 会建 worktree、起 agent，不能只靠 CLI）。
 * 写台账全经 manager 子进程（以调用方频道跑，同 lib/order-ledger-exit.ts），bridge 只读库算车道。tests/dag-tools-bridge.test.ts。
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { featureLanes } from "../lib/dag-tools-lanes.js";
import { composeRewrite, parseRewriteOps, parseToolNodes, planOverExisting, type NodeInput } from "../lib/dag-tools-plan.js";
import { preflightStart, startClaims, type StartArgs, type StartEnv } from "../lib/dag-tools-start.js";
import { runStart, type StepIO } from "../lib/dag-tools-steps.js";
import { centerPreflight, centerStartFailed } from "../lib/shared-ledger-center-start.js";
import { isManager } from "../lib/ledger-checks.js";
import { nodePhase } from "../lib/ledger-dag-rules.js";
import { dagDiff, dagSnapshot } from "../lib/ledger-dag-view.js";
import { buildNodes } from "../lib/ledger-feature-write.js";
import { effectiveNodes, getDagVersion, resolveFeature, type DagNode, type Feature } from "../lib/ledger-feature.js";
import { storedOrigin } from "../lib/ledger-origin.js";
import { getTask } from "../lib/ledger-store.js";
import { refuse, type OrderToolHandler, type OrderToolResult, type VerifiedCall } from "../lib/order-tool-route.js";
import { statePath } from "../lib/paths.js";
import { readProjects } from "../lib/projects.js";
import { readRegistryAgentsSync } from "../lib/registry.js";
import { runBounded } from "../lib/run-bounded.js";
import { runManagerProcess } from "../lib/run-manager.js";
import { readSchedulerConfig } from "../lib/scheduler-config.js";
import { startPlacement, type StartPlacementIO } from "../lib/scheduler-placement-start.js";
import { readEffectiveBorrow } from "../lib/scheduler-pool-borrow.js";
import { writeTextAtomicSync } from "../lib/state-file.js";
import { BUN_PATH, ENV_WITH_BUN, MANAGER_PATH } from "./config.js";
import { ledgerDb } from "./ledger-feed.js";
import { proposeBoundFeature } from "./local-api/shared-feature-proposals.js";
import { sharedExecStart } from "./shared-ledger-v2-entry-mcp.js";

/** 注入点：bridge 用真实的（liveDeps），测试换成进程内的台账与假 IO */
export interface DagToolDeps {
  db(): Database | null;
  /** 以调用方频道跑 manager（create 要等 agent 起来，给得起更长的超时） */
  manager(args: string[], channelId: string, timeoutMs?: number): Promise<any>;
  callerProject(agent: string): string | null;
  startEnv(): Omit<StartEnv, "db" | "caller">;
  stepIO(): Omit<StepIO, "db" | "manager" | "attempt">;
}

type Args = Record<string, unknown>;
const isObj = (x: unknown): x is Args => !!x && typeof x === "object" && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);
/** 同样的内容重试 = 同一个 dedup 键：工具超时后原样重调会回放，不会写两次 */
const dedupOf = (...parts: unknown[]) => `dag-tool:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24)}`;
const fail = (r: any): OrderToolResult => refuse(typeof r?.code === "string" ? r.code : "ledger", typeof r?.error === "string" ? r.error : "台账写入失败");

function gate(db: Database, call: VerifiedCall, project: string): OrderToolResult | null {
  return isManager(db, call.agent, { project, agent: null }) ? null : refuse("forbidden", `只有项目 ${project} 的 PM / master 能改子 DAG 或开卡（你是 ${call.agent}）`);
}

function feature(db: Database, raw: unknown): Feature | OrderToolResult {
  try {
    return resolveFeature(db, str(raw), storedOrigin(db));
  } catch (e) {
    return refuse("not_found", (e as Error).message);
  }
}
const isFeature = (x: Feature | OrderToolResult): x is Feature => "project" in x;

interface Opened { db: Database; f: Feature; a: Args }
/** 取库、找 feature；给了 call（写类工具）再过角色门 */
function open(deps: DagToolDeps, args: unknown, call: VerifiedCall | null): Opened | OrderToolResult {
  const db = deps.db();
  if (!db) return refuse("no_ledger", "台账库打不开");
  const a = isObj(args) ? args : {};
  const f = feature(db, a.featureId);
  if (!isFeature(f)) return f;
  return (call && gate(db, call, f.project)) || { db, f, a };
}
const isOpened = (x: Opened | OrderToolResult): x is Opened => "db" in x;

const livePhase = (db: Database) => (n: DagNode) => nodePhase(n.taskId, n.taskId ? (getTask(db, n.taskId)?.stage ?? null) : null);
const currentNodes = (db: Database, f: Feature): DagNode[] => {
  const v = getDagVersion(db, f.id, f.currentVersion);
  return v ? effectiveNodes(db, v) : [];
};

/** 先在只读库上按 CLI 同一套规矩校验（key、依赖、成环），新 feature 就不会只建出一个空壳 */
function precheck(db: Database, f: Pick<Feature, "id" | "project">, nodes: NodeInput[]): OrderToolResult | null {
  try {
    buildNodes(db, f, nodes);
    return null;
  } catch (e) {
    return refuse("invalid", (e as Error).message);
  }
}

async function done(deps: DagToolDeps, fid: string, r: any): Promise<OrderToolResult> {
  const db = deps.db();
  const f = db ? feature(db, fid) : null;
  const lanes = db && f && isFeature(f) ? featureLanes(db, f) : null;
  const { ok: _ok, event: _e, ...rest } = r ?? {};
  return { ok: true, feature: fid, ...rest, lanes };
}

async function planExisting(deps: DagToolDeps, db: Database, call: VerifiedCall, f: Feature, nodes: NodeInput[], a: Args): Promise<OrderToolResult> {
  if (!f.currentVersion) {
    const bad = precheck(db, f, nodes);
    if (bad) return bad;
    const r = await deps.manager(["ledger", "dag-init", f.id, `--rev=${f.rev}`, `--nodes=${JSON.stringify(nodes)}`, `--dedup=${dedupOf("init", f.id, nodes)}`], call.channelId);
    return r?.ok ? done(deps, f.id, r) : fail(r);
  }
  const kind = str(a.reasonKind), reason = str(a.reason);
  if (!kind || !reason) return refuse("invalid", `feature ${f.id} 已有 v${f.currentVersion}：改图要带 reasonKind 和 reason（原话）`);
  const next = planOverExisting(currentNodes(db, f), nodes, livePhase(db));
  if (!next.ok) return refuse("invalid", next.error);
  return rewrite(deps, call, f, next.value, kind, reason, {}, false);
}

async function rewrite(deps: DagToolDeps, call: VerifiedCall, f: Feature, nodes: NodeInput[], kind: string, reason: string, cancel: Record<string, string>, scope: boolean) {
  const args = ["ledger", "dag-rewrite", f.id, `--rev=${f.rev}`, `--nodes=${JSON.stringify(nodes)}`, `--reason-kind=${kind}`, `--reason=${reason}`];
  if (Object.keys(cancel).length) args.push(`--cancel=${JSON.stringify(cancel)}`);
  if (scope) args.push("--scope-change");
  args.push(`--dedup=${dedupOf("rewrite", f.id, f.rev, nodes, kind, reason, cancel, scope)}`);
  const r = await deps.manager(args, call.channelId);
  return r?.ok ? done(deps, f.id, r) : fail(r);
}

async function planNew(deps: DagToolDeps, db: Database, call: VerifiedCall, slug: string, nodes: NodeInput[], a: Args): Promise<OrderToolResult> {
  const title = str(a.title);
  if (!title) return refuse("invalid", "新建 feature 要带 title");
  const project = str(a.project) ?? deps.callerProject(call.agent);
  if (!project) return refuse("invalid", "认不出你所在的项目：带 project");
  const denied = gate(db, call, project);
  if (denied) return denied;
  const proposed = await proposeBoundFeature(call, project, title, nodes, a); if (proposed) return proposed; // 已绑定团队项目：只交中心提案，不写本机台账（N7B）
  const bad = precheck(db, { id: slug, project }, nodes);
  if (bad) return bad;
  const words = typeof a.ownerWords === "string" ? a.ownerWords : "";
  const made = await deps.manager(["ledger", "feature-new", slug, `--title=${title}`, `--words=${words}`, `--project=${project}`, `--dedup=${dedupOf("new", project, slug)}`], call.channelId);
  if (!made?.ok) return fail(made);
  const f = made.feature as Feature;
  const r = await deps.manager(["ledger", "dag-init", f.id, `--rev=${f.rev}`, `--nodes=${JSON.stringify(nodes)}`, `--dedup=${dedupOf("init", f.id, nodes)}`], call.channelId);
  if (!r?.ok) return refuse((fail(r) as { code: string }).code, `feature ${f.id} 已建，但 DAG 没建成：${r?.error ?? "?"}；修正后用 featureId=${f.id} 重调`);
  return done(deps, f.id, r);
}

async function planFeature(deps: DagToolDeps, call: VerifiedCall, args: unknown): Promise<OrderToolResult> {
  const db = deps.db();
  if (!db) return refuse("no_ledger", "台账库打不开");
  const a = isObj(args) ? args : {};
  const nodes = parseToolNodes(a.nodes);
  if (!nodes.ok) return refuse("invalid", nodes.error);
  if (!nodes.value.length) return refuse("invalid", "nodes 不能为空");
  const fid = str(a.featureId), slug = str(a.slug);
  if (!!fid === !!slug) return refuse("invalid", "featureId（改已有的）和 slug（新建）二选一");
  if (slug) return planNew(deps, db, call, slug, nodes.value, a);
  const f = feature(db, fid);
  if (!isFeature(f)) return f;
  return gate(db, call, f.project) ?? planExisting(deps, db, call, f, nodes.value, a);
}

async function rewriteDag(deps: DagToolDeps, call: VerifiedCall, args: unknown): Promise<OrderToolResult> {
  const o = open(deps, args, call);
  if (!isOpened(o)) return o;
  const { db, f, a } = o;
  const kind = str(a.reasonKind), reason = str(a.reason);
  if (!kind || !reason) return refuse("invalid", "改图要带 reasonKind 和 reason（原话）");
  const ops = parseRewriteOps(a);
  if (!ops.ok) return refuse("invalid", ops.error);
  if (!f.currentVersion) return refuse("invalid", `feature ${f.id} 还没建 DAG：先 plan_feature`);
  const next = composeRewrite(currentNodes(db, f), ops.value, livePhase(db));
  if (!next.ok) return refuse("invalid", next.error);
  return rewrite(deps, call, f, next.value, kind, reason, ops.value.cancel, a.scopeChange === true);
}

/**
 * 进程内占用表：节点在预检前占（同一节点不并发开工），卡号 / agent / 分支 / 路径在预检后一次占齐（lib/dag-tools-start.ts startClaims）。
 * 只按节点锁不够：不同节点可以给出只差大小写的卡号，派生到同一个 worktree，后失败的那次回滚会删掉先成功那次建的。
 */
const claimed = new Set<string>();

/** 全部空闲才一起占上，返回 null；有被占的返回它 */
function claim(keys: string[]): string | null {
  const hit = keys.find((k) => claimed.has(k));
  if (hit) return hit;
  for (const k of keys) claimed.add(k);
  return null;
}

const START_OPTIONAL = ["base", "branch", "taskId", "title", "item", "repo", "placement"] as const;
/** 回执里给 ui / security 卡补的一句；code 卡的 next 逐字不变 */
const TEMPLATE_NOTE: Record<string, string> = {
  ui: "；ui 卡：合并前 PM 验收前后截图（extra.screenshots ≥ 2 + screenshotsDigest；改整体观感的用 ledger ui-owner-visual <卡> on 交 owner 看）", security: "；security 卡：只在本机跨模型审查，不进借算力池",
};

async function startNode(deps: DagToolDeps, call: VerifiedCall, args: unknown): Promise<OrderToolResult> {
  const o = open(deps, args, null);
  if (!isOpened(o)) return o;
  const { db, f, a } = o;
  const key = str(a.key);
  const shared = await sharedExecStart(call, f, key ?? "", a, { db });
  if (shared) return shared;
  const denied = gate(db, call, f.project);
  if (denied) return denied;
  if (!key) return refuse("invalid", "缺节点 key");
  const held = [`node:${f.id}:${key}`];
  if (claim(held)) return refuse("busy", `节点 ${key} 正在开工，等这次的结果`);
  try {
    const input: StartArgs = { featureId: f.id, key };
    for (const k of START_OPTIONAL) if (str(a[k])) input[k] = str(a[k]);
    // 放哪不能因为传错类型就静默变成 auto：非字符串交给预检按不合法拒
    if (a.placement !== undefined && typeof a.placement !== "string") input.placement = JSON.stringify(a.placement);
    // 模板同理，且不 trim、不跳过空串：""、" ui"、对象都交预检拒，不能静默落成 code 卡（ui 卡就没了截图闸）
    if (a.template !== undefined) input.template = typeof a.template === "string" ? a.template : JSON.stringify(a.template);
    if (typeof a.spec === "string") input.spec = a.spec;
    const pre = await centerPreflight(db, f, key, input, () => preflightStart({ ...deps.startEnv(), db, caller: call.agent }, input));
    if (!pre.ok) return refuse(pre.code, pre.error);
    if ("already" in pre) return { ok: true, duplicate: true, ...pre.already, next: "这个节点已经开工过了（已绑卡），没有再建" };
    const res = startClaims(pre.plan);
    const busy = claim(res);
    if (busy) return refuse("busy", `${busy} 正被另一次 start_node 占用：等它结束，或换 taskId / branch`);
    held.push(...res);
    const io: StepIO = { ...deps.stepIO(), db: () => deps.db() ?? db, manager: (args, timeoutMs) => deps.manager(args, call.channelId, timeoutMs), attempt: randomBytes(4).toString("hex") };
    const out = await runStart(io, pre.plan);
    if (!out.ok) return (await centerStartFailed(f.id, key), out as unknown as OrderToolResult);
    const note = TEMPLATE_NOTE[pre.plan.workflow?.template ?? "code"] ?? "";
    if ("placement" in out) return { ...out, next: `卡固定放在 ${out.placement}：复述已跳过，开工单由调度器按放置结果派出（远端写代码等 W8）${note}` };
    return { ...out, next: `调度器会给 ${out.agent} 派复述单；不用给它发消息${note}` };
  } finally {
    for (const k of held) claimed.delete(k);
  }
}

function showDag(deps: DagToolDeps, args: unknown): OrderToolResult {
  const o = open(deps, args, null);
  if (!isOpened(o)) return o;
  const { db, f, a } = o;
  try {
    if (Array.isArray(a.diff)) return { ok: true, feature: f.id, ...dagDiff(db, f, String(a.diff[0]), String(a.diff[1] ?? f.currentVersion)) };
    const snap = dagSnapshot(db, f, typeof a.version === "number" ? a.version : undefined);
    const nodes = snap.version.nodes.map((n) => {
      const t = n.taskId ? getTask(db, n.taskId) : null;
      return { ...n, agent: t?.agent ?? t?.assignee ?? null, branch: t?.branch ?? null, pr: t?.pr ?? null };
    });
    const lanes = snap.version.version === f.currentVersion ? featureLanes(db, f) : null;
    return { ok: true, feature: f.id, title: f.title, current: f.currentVersion, version: { ...snap.version, nodes }, pending: snap.pending, lanes };
  } catch (e) {
    return refuse("not_found", (e as Error).message);
  }
}

/** 槽池放置要读的：scheduler.json 的项目策略、生效的借入名单、项目目录 origin 的 GitHub 坐标 */
export function livePlacementIO(git: (cwd: string, args: string[]) => Promise<{ ok: boolean; out: string }>): StartPlacementIO {
  return {
    reservations: (project) => placementReservationPort(project, recoveryPolicy),
    policy: (project) => {
      const p = readSchedulerConfig().projects[project];
      return p ? { remote: p.remote ?? null, maxWorkers: p.maxActiveWorkers } : null;
    },
    borrow: readEffectiveBorrow,
    originRepo: async (dir) => {
      const r = await git(dir, ["remote", "get-url", "origin"]);
      return r.ok ? r.out.match(/github\.com[:/]([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?$/)?.[1] ?? null : null;
    },
    now: Date.now,
  };
}

function liveDeps(): DagToolDeps {
  const git = async (cwd: string, args: string[], timeoutMs = 30_000) => {
    const r = await runBounded(["git", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
    const ok = r.code === 0 && !r.timedOut;
    // 成功取完整 stdout（rev-parse 的 sha、worktree list 要整份解析）；失败取错误，截短了放进回报
    return { ok, out: ok ? r.stdout.trim() : (r.timedOut ? "超时" : r.stderr || r.stdout).trim().slice(0, 500) };
  };
  const agents = () => readRegistryAgentsSync();
  return {
    db: ledgerDb,
    manager: (args, channelId, timeoutMs = 30_000) =>
      runManagerProcess(args, { bunPath: BUN_PATH, managerPath: MANAGER_PATH, env: { ...ENV_WITH_BUN, DISCORD_CHANNEL_ID: channelId }, timeoutMs }),
    callerProject: (agent) => agents().find((x) => x.name === agent)?.projectId ?? null,
    startEnv: () => ({
      ledgerDir: statePath("ledger"), worktreeRoot: statePath("worktrees"),
      projectDirs: async (id) => (await readProjects()).projects.find((p) => p.id === id)?.dirs ?? [],
      agentNames: () => agents().map((x) => x.name), exists: existsSync,
      branchExists: async (repo, branch) => (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).ok,
      autoReady: (project) => {
        const c = readSchedulerConfig();
        if (!c.enabled || !c.autoDispatch) return "调度服务没开自动派单（scheduler.json enabled + autoDispatch）：开了 auto 也没人推，先手动建卡";
        return Object.hasOwn(c.projects, project) ? null : `调度服务没列项目 ${project}（scheduler.json projects）`;
      },
      template: () => (existsSync(statePath("ledger", "prompts", "exec-template.md")) ? readFileSync(statePath("ledger", "prompts", "exec-template.md"), "utf8") : null),
      placement: (db, q) => startPlacement(db, livePlacementIO(git), q),
    }),
    stepIO: () => ({
      git, exists: existsSync, read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
      write: (p, text) => writeTextAtomicSync(p, text), remove: (p) => existsSync(p) && unlinkSync(p),
      symlink: (target, p) => symlinkSync(target, p), agentExists: (agent) => agents().some((x) => x.name === agent),
    }),
  };
}

export function dagToolHandlers(deps: DagToolDeps = liveDeps()): Record<string, OrderToolHandler> {
  return {
    set_feature_deps: (call, args) => setFeatureDeps(deps, call, args),
    plan_feature: (call, args) => planFeature(deps, call, args),
    rewrite_dag: (call, args) => rewriteDag(deps, call, args),
    start_node: (call, args) => startNode(deps, call, args),
    show_dag: async (_call, args) => showDag(deps, args),
  };
}
