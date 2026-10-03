/**
 * 团队视图截图 / 测试的默认夹具（i28-TV1 验收 4）：由生成器造、形状对齐生产——长标题、中英混排、UUID 形式的 id、
 * 20+ 节点、长依赖链、多个 feature。生产快照（含真实标题、peer 名）不进 git：测试从 TEAM_VIEW_SNAPSHOT 指向的
 * 仓库外文件读（形状同 TeamFixture）。纯模块，tests/ 可以直接 import。
 */
import type { FeatureDetail, FeatureList, PlanNode, TaskProjection } from "@/lib/api/shared-ledger";
import type { LedgerOverview, LedgerTaskView, Stage } from "../collab-model";

export interface TeamFixture {
  team: string;
  project: string;
  now: number;
  list: FeatureList;
  details: FeatureDetail[];
  /** 同一项目在主场本机台账里的总览（本地视图吃的那份） */
  local: LedgerOverview;
}

/** 确定性的伪随机：同一个 seed 永远造出同一份夹具（截图可对比） */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
function uuid(r: () => number): string {
  const h = () => Math.floor(r() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, h).join("");
  return `${part(8)}-${part(4)}-4${part(3)}-a${part(3)}-${part(12)}`;
}

const SUBJECTS = ["团队视图", "共享台账 shared-ledger", "出借池 lend worker", "合并闸 merge gate", "中继 relay", "子 DAG 画布", "审批 approval", "执行镜像 projection"];
const VERBS = ["复用本地协作视图的组件并接上中心数据源", "补齐 409 冲突重放与回执查询", "把卡片标题和连线文字的重叠彻底修掉", "手机端列表与全屏详情对齐",
  "生产形状夹具与截图自动检查", "按 CAS 提交规划新版本", "绑卡后节点锁定、改阶段与审批入口"];
const STAGES: Stage[] = ["done", "done", "verified", "merge", "review", "fix", "build", "build", "restate", "spec"];

export function generateTeamFixture(opts: { seed?: number; features?: number; nodes?: number; now?: number } = {}): TeamFixture {
  const r = rng(opts.seed ?? 7), now = opts.now ?? Date.UTC(2026, 9, 2, 16, 0), team = "team-a", project = "claude-orchestrator";
  const featureCount = opts.features ?? 3, perFeature = opts.nodes ?? 9;
  const caps = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
    "task.new": { enabled: false, reason: "V1 仅共享规划，执行操作仍在主场" }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };
  const details: FeatureDetail[] = [];
  const localTasks: LedgerTaskView[] = [];
  for (let f = 0; f < featureCount; f++) {
    const fid = uuid(r), home = uuid(r).replace(/-/g, "");
    const nodes: PlanNode[] = [], tasks: TaskProjection[] = [], bindings: { nodeKey: string; taskId: string }[] = [];
    for (let n = 0; n < perFeature; n++) {
      const key = `i28-${String.fromCharCode(65 + f)}${n + 1}`;
      const title = `${SUBJECTS[(f * 3 + n) % SUBJECTS.length]}：${VERBS[(n + f) % VERBS.length]}（第 ${n + 1} 步，long title to wrap）`;
      // 长依赖链：每个节点依赖前一个，隔几个再多挂一条跨两级的边
      const deps = n === 0 ? [] : n % 3 === 0 ? [nodes[n - 1]!.key, nodes[n - 3]!.key] : [nodes[n - 1]!.key];
      nodes.push({ key, oneLine: title, deps, fileGlobs: [`web/features/collab/${key.toLowerCase()}/**`], estimate: `${1 + (n % 4)}h` });
      const stage = STAGES[Math.min(STAGES.length - 1, Math.floor((n / perFeature) * STAGES.length + f))]!;
      if (stage === "spec") continue; // 没开卡的计划节点：中心只有规划，没有执行镜像
      const taskId = uuid(r);
      bindings.push({ nodeKey: key, taskId });
      tasks.push({ taskId, sourceTaskId: key, sourceRev: 3, sourceSeq: 30 + n, stage, assigneeCode: `peer-${uuid(r).slice(0, 8)}`,
        executorInstanceId: home, pr: 400 + f * 20 + n, head: null, deps, specSummary: `${title} — 规格摘要`, specDigest: null,
        fullText: "home_only", steps: [], asks: [] });
      localTasks.push({ id: key, itemId: fid, title, kind: "code", stage, round: 1, agent: null, pm: null, pr: null,
        updatedAt: now - n * 60_000, stageSince: now - n * 60_000, metrics: {} });
    }
    const feature = { id: fid, projectId: project, title: `${SUBJECTS[f % SUBJECTS.length]} feature ${f + 1}：${VERBS[f % VERBS.length]}`,
      description: VERBS[(f + 2) % VERBS.length]!, rev: 3 + f, version: 2, authorityMode: "planning" as const, homeInstanceId: home,
      executorInstanceIds: [home], status: "active" as const, counts: { total: perFeature, completed: tasks.filter((t) => t.stage === "done").length, blocked: 0, missing: 0 },
      updatedBy: "person-a", updatedAt: now, projection: { sourceInstanceId: home, sourceSeq: 40, observedAt: now, receivedAt: now } };
    details.push({ schemaVersion: 1, teamId: team, serverSeq: 40, capabilities: caps, feature, dag: { version: 2, nodes, bindings }, tasks });
  }
  const list: FeatureList = { schemaVersion: 1, teamId: team, serverSeq: 40, capabilities: caps, features: details.map((d) => d.feature) };
  const items = details.map((d) => ({ id: d.feature.id, title: d.feature.title, oneLine: d.feature.description }));
  const deps = details.flatMap((d) => d.dag.nodes.flatMap((n) => n.deps.filter((p) => localTasks.some((t) => t.id === p) && localTasks.some((t) => t.id === n.key))
    .map((p) => ({ from: p, to: n.key, kind: "blocks" as const, when: "", state: null, derived: "done" as const, effective: "done" as const,
      createdBy: "pm", createdAt: now, updatedAt: now }))));
  const local: LedgerOverview = { exists: true, now, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } }, items, tasks: localTasks, deps };
  return { team, project, now, list, details, local };
}
