/**
 * team-parity-C 的唯一数据源：一份「主场本机台账」形状的合成数据（LedgerOverview + 每张卡的 TaskDetail + DAG 版本），
 * 本地路由只吐它，团队路由只吐 home-to-team-fixture.ts 从它推出来的投影——两边不再各造一份（docs/team/team-collab-parity-plan.md §5.1 P1-C）。
 * 事件按 LedgerEventView 带完整 data（stage from/to、review round/verdict/p0..p2、verify result），审查结论 pass / changes / block 各至少一条。
 * 台账里有、总览不带的行级事实（rev、headSHA、步骤行、提问行、导入时审过的摘要 / 成员代号）放在 rows，投影规则只读这些。
 * 纯模块，tests/ 直接 import；确定性（同参数同输出），截图可对比。
 */
import type { LedgerDepView, LedgerEventView, LedgerOverview, LedgerTaskView, Stage, TaskMetricsView } from "../collab-model";
import type { StageEntryView, TaskDetail } from "../collab-detail-model";
import type { BoardNode, DagBoard, DagDiffResponse, FeatureCard, FeatureDetail as DagFeatureDetail, VersionMeta } from "../dag/dag-types";
import type { ProductBoard } from "../../../lib/api/product-board";
import type { WorkBoard, WorkRow } from "../work/work-types";

/** 主场台账里一张卡的行级事实：mirrorTaskProjections 读的正是这些（src/lib/shared-ledger-projector.ts） */
export interface HomeLedgerRow {
  rev: number;
  headSHA: string | null;
  steps: { step: string; round: number; rev: number; state: string; derived: boolean; executor: string | null; verdict: string | null }[];
  asks: { kind: string; state: string; blocking: number | null; source: string }[];
  /** MirrorTaskMeta：导入时审过的摘要 / 成员代号，不从规格原文或昵称重算 */
  meta: { specSummary: string; specDigest: string | null; assigneeCode: string | null };
}
export interface HomeDagNode { key: string; oneLine: string; deps: string[]; fileGlobs: string[]; estimate: string; taskId: string | null }
export interface HomeFeature {
  id: string; centerId: string; title: string; ownerWords: string;
  versions: { meta: VersionMeta; nodes: HomeDagNode[] }[];
}
export interface HomeFixture {
  team: string; project: string; now: number;
  /** 主场实例 id（投影的 executorInstanceId / sourceInstanceId） */
  sourceInstanceId: string;
  /** 主场全局事件 seq（投影的 sourceSeq 上限） */
  seq: number;
  /** scrub 认得的真实提交：不在里面的 head 投影成 null */
  commits: string[];
  overview: LedgerOverview;
  details: Record<string, TaskDetail>;
  rows: Record<string, HomeLedgerRow>;
  features: HomeFeature[];
}

type Review = { verdict: "pass" | "changes" | "block"; p0: number; p1: number; p2: number };
interface CardPlan { stage: Stage; path: Stage[]; reviews: Review[]; ask?: boolean; pr?: string; commit?: boolean }
const PASS: Review = { verdict: "pass", p0: 0, p1: 0, p2: 1 };
const CHANGES: Review = { verdict: "changes", p0: 0, p1: 2, p2: 1 };
const BLOCK: Review = { verdict: "block", p0: 1, p1: 1, p2: 0 };
const FULL: Stage[] = ["spec", "restate", "build", "review", "merge", "live", "verified", "done"];
const upTo = (...s: Stage[]) => s;
/** 每个 feature 的卡：最后一个 null 是没开卡的计划节点（中心只有规划，没有执行镜像） */
const PLANS: (CardPlan | null)[][] = [[
  { stage: "done", path: FULL, reviews: [PASS], pr: "411", commit: true },
  { stage: "verified", path: upTo("spec", "restate", "build", "review", "fix", "review", "merge", "live", "verified"), reviews: [CHANGES, PASS], pr: "412", commit: true },
  { stage: "merge", path: upTo("spec", "restate", "build", "review", "merge"), reviews: [PASS], pr: "https://github.com/shawnlu96/claudestra/pull/413" },
  { stage: "review", path: upTo("spec", "restate", "build", "review"), reviews: [], pr: "414" },
  { stage: "fix", path: upTo("spec", "restate", "build", "review", "fix"), reviews: [BLOCK], pr: "415" },
  { stage: "build", path: upTo("spec", "restate", "build"), reviews: [] },
  { stage: "build", path: upTo("spec", "restate", "build"), reviews: [], ask: true },
  null,
], [
  { stage: "done", path: upTo("spec", "restate", "build", "review", "fix", "review", "merge", "live", "verified", "done"), reviews: [CHANGES, PASS], pr: "421", commit: true },
  { stage: "review", path: upTo("spec", "restate", "build", "review", "fix", "review"), reviews: [BLOCK], pr: "422" },
  { stage: "build", path: upTo("spec", "restate", "build"), reviews: [] },
  { stage: "restate", path: upTo("spec", "restate"), reviews: [] },
  null,
]];
const SUBJECTS = ["团队视图", "共享台账 shared-ledger", "出借池 lend worker", "合并闸 merge gate", "执行镜像 projection", "子 DAG 画布"];
const VERBS = ["复用本地协作视图的组件并接上中心数据源", "补齐 409 冲突重放与回执查询", "把卡片标题和连线文字的重叠彻底修掉",
  "手机端列表与全屏详情对齐", "生产形状夹具与截图自动检查", "按 CAS 提交规划新版本", "绑卡后节点锁定、改阶段与审批入口"];
const STEP_OF: Partial<Record<Stage, string>> = { restate: "restate", build: "write", review: "review", fix: "fix", merge: "merge", verified: "verify" };
const STEP_MS = 40 * 60_000;

/** 确定性的十六进制串（head、中心 id）：同 key 同输出 */
function hex(key: string, len: number): string {
  let h = 2166136261, out = "";
  while (out.length < len) {
    for (const c of `${key}:${out.length}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}
export const uuidOf = (key: string) => { const x = hex(key, 32); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20)}`; };

interface Built { view: LedgerTaskView; detail: TaskDetail; row: HomeLedgerRow }

/** 沿阶段路径走一遍：事件、时间线、步骤行、指标都从同一条路径推出，互相对得上 */
function buildCard(plan: CardPlan, ctx: { id: string; itemId: string; title: string; start: number; now: number; seq: { n: number }; member: number }): Built {
  const { id, now } = ctx, dev = `agent-dev-${ctx.member}`, reviewer = "agent-rv-1", pm = "agent-pm-a";
  const events: LedgerEventView[] = [], timeline: StageEntryView[] = [], steps: HomeLedgerRow["steps"] = [];
  const reviews = [...plan.reviews];
  const head = plan.path.includes("review") ? hex(`${id}:head`, 40) : null;
  let at = ctx.start, round = 0, deliveredAt: number | null = null, lastReview: LedgerTaskView["lastReview"] = null;
  const push = (kind: string, actor: string, text: string, data: Record<string, unknown>) =>
    events.push({ seq: ++ctx.seq.n, ts: at, actor, target: id, kind, text, data });
  const step = (name: string, executor: string | null, verdict: string | null = null) => {
    for (const s of steps) if (s.state !== "done") s.state = "done";
    steps.push({ step: name, round: Math.max(round, 1), rev: steps.length + 1, state: "assigned", derived: false, executor, verdict });
  };
  push("task:new", pm, "开卡", { patch: { stage: "spec" } });
  for (let i = 1; i < plan.path.length; i++) {
    const from = plan.path[i - 1]!, to = plan.path[i]!;
    timeline.push({ stage: from, from: at, to: at + STEP_MS });
    at += STEP_MS;
    if (to === "review") {
      round += 1; deliveredAt = at;
      push("deliver", dev, `第 ${round} 轮交付`, { headSHA: head });
    }
    if (from === "review") {
      const r = reviews.shift() ?? PASS;
      push("review", reviewer, r.verdict === "pass" ? "通过，可以合并" : "需要返工：边界条件没覆盖", { round, ...r, reviewer });
      steps.at(-1)!.verdict = r.verdict;
      lastReview = { round, verdict: r.verdict, p0: r.p0, p1: r.p1, p2: r.p2, text: "审查意见", ts: at };
      deliveredAt = null;
    }
    if (from === "live" && to === "verified") push("verify", "agent-pm-a", "线上验证", { result: "pass" });
    push("stage", to === "review" || to === "fix" ? dev : pm, "", { from, to });
    const name = STEP_OF[to];
    if (name) step(name, name === "review" ? reviewer : name === "merge" || name === "verify" ? pm : dev);
  }
  if (plan.stage === "done") for (const s of steps) s.state = "done";
  const last = events.at(-1)!;
  const stageSince = at;
  timeline.push({ stage: plan.stage, from: at, to: plan.stage === "done" ? at : now });
  const stageMs: Partial<Record<Stage, number>> = {};
  for (const t of timeline) stageMs[t.stage] = (stageMs[t.stage] ?? 0) + (t.to - t.from);
  const reviewed = events.filter((e) => e.kind === "review");
  const sum = (k: "p0" | "p1" | "p2") => reviewed.reduce((n, e) => n + Number(e.data[k] ?? 0), 0);
  const settled = plan.stage === "done" || plan.stage === "verified";
  const metrics: TaskMetricsView = { startTs: ctx.start, endTs: settled ? at : null, totalMs: (settled ? at : now) - ctx.start, stageMs,
    reviewRounds: reviewed.length, reviewWaitPendingMs: deliveredAt !== null && plan.stage === "review" ? now - deliveredAt : null,
    p0: sum("p0"), p1: sum("p1"), p2: sum("p2") };
  const active = steps.find((s) => s.state !== "done");
  const stepLine = { steps: steps.map((s) => ({ ...s, executorKind: "agent", headTo: s.step === "write" || s.step === "fix" ? head : null })),
    active: active ? { step: active.step, round: active.round } : null };
  const view: LedgerTaskView = { id, itemId: ctx.itemId, title: ctx.title, kind: "code", stage: plan.stage, round: Math.max(round, 1),
    agent: dev, pm, pr: plan.pr ?? null, spec: `${ctx.title} — 规格摘要`, updatedAt: last.ts, lastEvent: last, stageSince,
    lastReview, metrics, stepLine, extra: { goal: `${ctx.title} — 目标` } };
  const detail: TaskDetail = { task: view, events, timeline, steps: stepLine.steps, stepLine,
    sessions: { author: { agent: dev }, reviewer: plan.path.includes("review") ? { agent: reviewer } : null }, now };
  const row: HomeLedgerRow = { rev: events.length, headSHA: head, steps,
    asks: plan.ask ? [{ kind: "decide", state: "open", blocking: 1, source: "reply" }, { kind: "authorize", state: "answered", blocking: null, source: "permission" }] : [],
    meta: { specSummary: `${ctx.title} — 规格摘要`, specDigest: null, assigneeCode: `m-${String(ctx.member).padStart(2, "0")}` } };
  return { view, detail, row };
}

export function generateHomeFixture(opts: { now?: number } = {}): HomeFixture {
  // 10:00 UTC = 18:00 上海：全部卡都在同一天里开工、完成，今日完成在两个时区都不跨日
  const now = opts.now ?? Date.UTC(2026, 9, 2, 10, 0), project = "claude-orchestrator", seq = { n: 0 };
  const tasks: LedgerTaskView[] = [], details: Record<string, TaskDetail> = {}, rows: Record<string, HomeLedgerRow> = {};
  const features: HomeFeature[] = [], commits: string[] = [];
  PLANS.forEach((plans, f) => {
    const letter = String.fromCharCode(65 + f), fid = `feat-${letter.toLowerCase()}`;
    const nodes: HomeDagNode[] = plans.map((plan, n) => {
      const key = `i28-${letter}${n + 1}`;
      const title = `${SUBJECTS[(f * 3 + n) % SUBJECTS.length]}：${VERBS[(n + f) % VERBS.length]}（第 ${n + 1} 步，long title to wrap）`;
      const deps = n === 0 ? [] : n % 3 === 0 ? [`i28-${letter}${n}`, `i28-${letter}${n - 2}`] : [`i28-${letter}${n}`];
      return { key, oneLine: title, deps, fileGlobs: [`web/features/collab/${key.toLowerCase()}/**`], estimate: `${1 + (n % 4)}h`, taskId: plan ? key : null };
    });
    nodes.forEach((node, n) => {
      const plan = plans[n];
      if (!plan || !node.taskId) return;
      const start = now - (plan.path.length + 1) * STEP_MS - n * 5 * 60_000;
      const b = buildCard(plan, { id: node.taskId, itemId: fid, title: node.oneLine, start, now, seq, member: n % 3 + 1 });
      if (plan.commit && b.row.headSHA) commits.push(b.row.headSHA);
      tasks.push(b.view); details[node.taskId] = b.detail; rows[node.taskId] = b.row;
    });
    const at = now - 6 * 3600_000;
    const v1: VersionMeta = { version: 1, reasonKind: "initial", reasonText: "初版规划", proposedBy: "agent-pm-a", approvedBy: "owner",
      createdAt: at, cancels: [], scopeChange: false, askId: null };
    const v2: VersionMeta = { version: 2, reasonKind: "requirement_change", reasonText: "补上手机详情与提问节点", proposedBy: "agent-pm-a",
      approvedBy: "owner", createdAt: at + 3600_000, cancels: [], scopeChange: true, askId: null };
    const first = nodes.slice(0, -2).map((n, i) => i === nodes.length - 3 ? { ...n, oneLine: `${n.oneLine}（v1 原标题）` } : n);
    features.push({ id: fid, centerId: uuidOf(`center:${fid}`), title: `${SUBJECTS[f]} feature ${f + 1}：${VERBS[f]}`, ownerWords: VERBS[(f + 2) % VERBS.length]!,
      versions: [{ meta: v1, nodes: first }, { meta: v2, nodes }] });
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const deps: LedgerDepView[] = features.flatMap((f) => f.versions.at(-1)!.nodes.flatMap((n) => n.deps
    .filter((p) => byId.has(p) && byId.has(n.key)).map((p): LedgerDepView => {
      const pre = byId.get(p)!.stage, state = pre === "done" || pre === "verified" ? "done" : "active";
      if (state !== "done") (byId.get(n.key)!.blockedBy ??= []).push(p);
      return { from: p, to: n.key, kind: "blocks", when: "verified", state: null, derived: state, effective: state,
        createdBy: "agent-pm-a", createdAt: now - 5 * 3600_000, updatedAt: now - 5 * 3600_000 };
    })));
  const overview: LedgerOverview = { exists: true, now, meta: { pms: ["agent-pm-a"], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: features.map((f) => ({ id: f.id, title: f.title, oneLine: f.ownerWords })), tasks, deps };
  return { team: "team-a", project, now, sourceInstanceId: hex("home-instance", 32), seq: seq.n, commits, overview, details, rows, features };
}

// ---- 本地路由的其余响应：全部从上面这一份推，不另造数据 ----

const SETTLED: ReadonlySet<string> = new Set(["done", "verified"]);
function boardNodes(home: HomeFixture, f: HomeFeature, version: number): BoardNode[] {
  const nodes = f.versions.find((v) => v.meta.version === version)!.nodes, tasks = new Map(home.overview.tasks.map((t) => [t.id, t]));
  return nodes.map((n): BoardNode => {
    const t = n.taskId ? tasks.get(n.taskId) : undefined, d = t ? home.details[t.id] : undefined;
    const phase = !t ? "idle" : SETTLED.has(t.stage) ? "done" : "active";
    const line = d?.stepLine as BoardNode["stepLine"] | undefined;
    return { key: n.key, taskId: t?.id ?? null, oneLine: n.oneLine, deps: n.deps, estimate: n.estimate, fileGlobs: n.fileGlobs,
      inheritedFrom: version > 1 && f.versions[0]!.nodes.some((o) => o.key === n.key) ? 1 : null, status: t?.stage ?? "planned",
      statusAtVersion: t?.stage ?? "planned", title: t?.title ?? null, satisfied: phase === "done", ready: !t?.blockedBy?.length, missing: false,
      phase, round: t ? t.round : null, handler: t && phase === "active" ? { role: t.stage === "review" ? "reviewer" : "executor",
        agent: t.stage === "review" ? "agent-rv-1" : t.agent ?? null, since: t.stageSince ?? t.updatedAt } : null,
      stepLine: line ? { active: line.active, steps: line.steps.map((s) => ({ step: s.step, round: s.round, state: s.state })) } : null,
      since: phase === "active" ? t!.stageSince ?? null : null, pr: t?.pr ?? null, branch: t ? `lend/${t.id}` : null };
  });
}
function featureCard(home: HomeFixture, f: HomeFeature): FeatureCard {
  const cur = f.versions.at(-1)!, nodes = boardNodes(home, f, cur.meta.version);
  return { id: f.id, title: f.title, status: "active", ownerWords: f.ownerWords, currentVersion: cur.meta.version, version: cur.meta, pending: null,
    counts: { total: nodes.length, done: nodes.filter((n) => n.phase === "done").length, active: nodes.filter((n) => n.phase === "active").length,
      idle: nodes.filter((n) => n.phase === "idle").length, missing: 0 },
    lastActivityAt: Math.max(...home.overview.tasks.filter((t) => t.itemId === f.id).map((t) => t.updatedAt)), nodes };
}
export function homeDagBoard(home: HomeFixture): DagBoard {
  const features = home.features.map((f) => featureCard(home, f));
  const busy = home.overview.tasks.filter((t) => !SETTLED.has(t.stage) && t.agent);
  const agents = [...new Set(busy.map((t) => t.agent!))].map((agent) => ({ agent: agent.replace(/^agent-/, ""), pm: false, offGraph: [],
    work: busy.filter((t) => t.agent === agent).map((t) => ({ featureId: t.itemId!, nodeKey: t.id, taskId: t.id, role: "executor",
      step: STEP_OF[t.stage] ?? null, round: t.round, since: t.stageSince ?? t.updatedAt })) }));
  return { ok: true, project: home.project, exists: true, now: home.now, asOfSeq: home.seq, features, agents };
}
function diffOf(a: HomeDagNode[], b: HomeDagNode[]) {
  const before = new Map(a.map((n) => [n.key, n]));
  return { added: b.filter((n) => !before.has(n.key)).map((n) => n.key), removed: a.filter((n) => !b.some((x) => x.key === n.key)).map((n) => n.key),
    carried: b.filter((n) => before.has(n.key)).map((n) => ({ key: n.key, changed: before.get(n.key)!.oneLine !== n.oneLine })), cancelled: [] };
}
export function homeDagFeature(home: HomeFixture, id: string, version?: number): DagFeatureDetail | null {
  const f = home.features.find((x) => x.id === id);
  if (!f) return null;
  const card = featureCard(home, f), feature: Omit<FeatureCard, "nodes"> = { ...card };
  delete (feature as Partial<FeatureCard>).nodes; // 详情响应的 feature 不带节点（节点在 snapshot 里）
  const v = version ?? feature.currentVersion, snap = f.versions.find((x) => x.meta.version === v);
  const versions = f.versions.map((x, i) => {
    const d = i ? diffOf(f.versions[i - 1]!.nodes, x.nodes) : null;
    return { ...x.meta, delta: d && { added: d.added.length, removed: d.removed.length, changed: d.carried.filter((c) => c.changed).length, cancelled: 0 } };
  });
  return { ok: true, project: home.project, now: home.now, feature, versions,
    snapshot: snap ? { version: v, meta: snap.meta, nodes: boardNodes(home, f, v) } : null };
}
export function homeDagDiff(home: HomeFixture, id: string, from: number, to: number): DagDiffResponse | null {
  const f = home.features.find((x) => x.id === id), a = f?.versions.find((x) => x.meta.version === from), b = f?.versions.find((x) => x.meta.version === to);
  if (!f || !a || !b) return null;
  const phaseNow = Object.fromEntries(boardNodes(home, f, to).map((n) => [n.key, n.phase]));
  return { ok: true, project: home.project, featureId: id, now: home.now, from, to, diff: diffOf(a.nodes, b.nodes), phaseNow, rewrittenDone: [] };
}
export function homeProductBoard(home: HomeFixture): ProductBoard {
  const board = homeDagBoard(home);
  return { features: board.features.map((f) => ({ id: f.id, title: f.title, status: f.status, hasDag: true, version: f.currentVersion,
    counts: { total: f.counts.total, completed: f.counts.done, active: f.counts.active, blocked: f.nodes.filter((n) => !n.ready && n.phase !== "done").length,
      ready: f.nodes.filter((n) => n.ready && n.phase === "idle").length },
    eta: { at: home.now + 3 * 3600_000 } })),
  deps: board.features.length > 1 ? [{ from: board.features[0]!.id, to: board.features[1]!.id, note: "共享契约先行" }] : [] };
}
export function homeWorkBoard(home: HomeFixture): WorkBoard {
  const row = (t: LedgerTaskView): WorkRow => ({ taskId: t.id, featureId: t.itemId ?? null, nodeKey: t.id, title: t.title, who: t.agent?.replace(/^agent-/, "") ?? null,
    machine: "local", step: (STEP_OF[t.stage] as WorkRow["step"]) ?? null, round: t.round, since: t.stageSince ?? t.updatedAt,
    normalMinutes: 120, remainingMinutes: 40, overMinutes: 0, reason: null, code: null, estimate: "2h" });
  const live = home.overview.tasks.filter((t) => !SETTLED.has(t.stage));
  return { now: home.now, asOfSeq: home.seq, working: live.filter((t) => t.stage === "build" || t.stage === "fix").map(row),
    waiting: live.filter((t) => t.stage === "review" || t.stage === "merge" || t.stage === "restate").map(row), todo: { ready: [], blocked: [] },
    machines: { local: 3 }, completionHours: 6, availableSlots: 1 };
}
