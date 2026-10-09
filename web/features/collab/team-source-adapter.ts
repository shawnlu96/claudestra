/**
 * 中心共享台账（/api/v1/shared-ledger/*）→ 协作视图已经在吃的形状（i28-TV1）。纯函数，不碰网络。
 * 事项 = feature；任务 = feature 规划里的每个节点（绑了卡的用它的执行镜像，没绑的是「规格」阶段的计划节点）
 * 加上没挂在节点上的执行镜像；依赖边 = 节点的 deps。
 * 标题一律卡号 + 标题：卡号取主场的卡号（sourceTaskId），不像卡号（UUID / 长十六进制）就用节点代号；
 * 中心没有的字段（事件、阶段时间线、审查、指标、执行者会话）不编，留给视图现有的「暂无」。
 * 读口已经给的（P1-B）：成员代号、执行实例、head 原值和开着的阻塞提问数、镜像新鲜度证据（显示时随时间重判）→ team（collab-model.ts TeamTaskFacts）；
 * agent 仍是 null——成员代号不是本机 agent 名，不能开会话 / 对它说。steps → stepLine（team-source-steps.ts）。
 * 边没有建立者 / 时间：三项给 null，边页显示「未记录」，不拿 feature 的 updatedBy / updatedAt 冒充。
 */
import type { FeatureDetail, FeatureList, TaskProjection } from "@/lib/api/shared-ledger";
import type { LedgerDepView, LedgerOverview, LedgerTaskView, MirrorFact, Stage } from "./collab-model";
import type { TaskDetail } from "./collab-detail-model";
import { stale } from "./shared/shared-model";
import { MIRROR_FRESH_MS } from "./mirror-fresh";
import { DETAIL_BEHIND_MS } from "./team-source-shared";
import { teamStepLine } from "./team-source-steps";

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{16,}$/i;
/** 像原始 id（UUID、长十六进制、带前缀的 UUID）：不能拿来当标题 */
export function looksLikeId(s: string): boolean {
  const t = s.trim();
  return UUID.test(t) || HEX.test(t) || UUID.test(t.replace(/^[a-z]+[-_:]/i, ""));
}

const STAGES: ReadonlySet<string> = new Set(["spec", "restate", "build", "review", "fix", "merge", "live", "verified", "done", "blocked", "cancelled"]);
/** 主场台账的阶段原样带过来；步骤名（v2 的 write / verify）折到本地的阶段上；认不出的按在开发 */
const ALIAS: Record<string, Stage> = { write: "build", verify: "verified", approve: "review", planned: "spec" };
export function stageOf(raw: string): Stage {
  return STAGES.has(raw) ? (raw as Stage) : ALIAS[raw] ?? "build";
}
const SETTLED: ReadonlySet<Stage> = new Set(["done", "verified"]);

const card = (s: string | null | undefined) => (s && s.trim() && !looksLikeId(s) ? s.trim() : null);

/** 阻塞提问 = blocking 且还开着的；答完 / 过期 / 取消的不算 */
export const blockingAsks = (t: Pick<TaskProjection, "asks">): number => t.asks.filter((a) => a.blocking && a.state === "open").length;

/**
 * 镜像证据取实际显示的那份详情（读新详情失败、回退缓存时就是旧详情），不借列表的新时间。
 * 水位是本机全局事件号，列表每轮都比详情新；落后在 DETAIL_BEHIND_MS 内是有意的重拉间隔，按详情自己的 observedAt 判新鲜；
 * 超过了（读失败回退旧缓存等）说明显示的不是中心现在的那份，算过期。没读到详情的 feature 只显示列表上的东西，按列表判。
 * waiting = 到期了但因每轮重拉上限还在排队、没发过请求（不是读失败）：不按落后判，仍按详情自己的 observedAt 判。
 */
export function mirrorFact(f: FeatureList["features"][number], d: FeatureDetail | undefined, now: number, waiting = false): MirrorFact {
  const shown = d?.feature ?? f;
  const p = shown.projection;
  if (!p) return { mirror: null, freshUntil: null, observedAt: null };
  const behind = !!d && !waiting && !!f.projection && f.projection.observedAt - p.observedAt > DETAIL_BEHIND_MS;
  return behind || stale(shown, now) ? { mirror: "stale", freshUntil: null, observedAt: p.observedAt }
    : { mirror: "fresh", freshUntil: p.observedAt + MIRROR_FRESH_MS, observedAt: p.observedAt };
}

interface Row { featureId: string; key: string | null; task: TaskProjection | null; title: string; deps: string[] }

function rowsOf(d: FeatureDetail): Row[] {
  const byTask = new Map(d.tasks.map((t) => [t.taskId, t]));
  const used = new Set<string>();
  const rows: Row[] = d.dag.nodes.map((n) => {
    const bound = d.dag.bindings.find((b) => b.nodeKey === n.key)?.taskId;
    const task = bound ? byTask.get(bound) ?? null : null;
    if (task) used.add(task.taskId);
    return { featureId: d.feature.id, key: n.key, task, title: n.oneLine, deps: n.deps };
  });
  for (const t of d.tasks) if (!used.has(t.taskId)) rows.push({ featureId: d.feature.id, key: null, task: t, title: t.specSummary, deps: [] });
  return rows;
}

export interface TeamOverview {
  ov: LedgerOverview;
  /** 视图里的卡号 → 中心的 feature / 节点 / 执行镜像（任务详情和团队操作按它找回去） */
  index: Map<string, { featureId: string; key: string | null; taskId: string | null }>;
}

/** details 缺某个 feature（读失败）：事项照列，底下没有任务；waiting = 到期还在重拉队列里排队的 feature */
export function teamOverview(list: FeatureList, details: ReadonlyMap<string, FeatureDetail>, now: number, waiting: ReadonlySet<string> = new Set()): TeamOverview {
  const tasks: LedgerTaskView[] = [];
  const deps: LedgerDepView[] = [];
  const index: TeamOverview["index"] = new Map();
  const taken = new Set<string>();
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}~${n}`;
    taken.add(id);
    return id;
  };
  for (const f of list.features) {
    const d = details.get(f.id);
    if (!d) continue;
    const rows = rowsOf(d);
    const ids = rows.map((r, i) => unique(card(r.task?.sourceTaskId) ?? card(r.key) ?? `${f.title || "feature"} #${i + 1}`));
    const idOfKey = new Map(rows.flatMap((r, i) => (r.key ? [[r.key, ids[i]!] as const] : [])));
    const at = f.projection?.observedAt ?? f.updatedAt;
    const { mirror, freshUntil, observedAt } = mirrorFact(f, d, now, waiting.has(f.id));
    const views = rows.map((r, i): LedgerTaskView => {
      index.set(ids[i]!, { featureId: f.id, key: r.key, taskId: r.task?.taskId ?? null });
      const summary = r.task?.specSummary ?? "";
      const title = [r.title, summary].find((t) => t && !looksLikeId(t)) ?? ids[i]!;
      const stage = r.task ? stageOf(r.task.stage) : "spec";
      const view: LedgerTaskView = {
        id: ids[i]!, itemId: f.id, title, kind: "code", stage, round: 0,
        agent: null, pm: null, pr: r.task?.pr ? `#${r.task.pr}` : null, spec: summary || null,
        extra: summary && summary !== title ? { goal: summary } : {}, updatedAt: at, stageSince: null, metrics: {},
      };
      if (!r.task) return view;
      const line = teamStepLine(r.task.steps, stage);
      if (line) view.stepLine = line;
      const t = r.task;
      view.team = { assigneeCode: t.assigneeCode, executorInstanceId: t.executorInstanceId, head: t.head, blockingAsks: blockingAsks(t), mirror, freshUntil, observedAt };
      return view;
    });
    rows.forEach((r, i) => {
      const to = views[i]!;
      for (const dep of r.deps) {
        const from = idOfKey.get(dep);
        const pre = from ? views[ids.indexOf(from)] : undefined;
        if (!from || !pre) continue;
        const state = SETTLED.has(pre.stage) ? "done" : pre.stage === "spec" ? "waiting" : "active";
        if (state !== "done") (to.blockedBy ??= []).push(from);
        // 契约里没有边级元数据：建立者 / 时间不知道就是 null（feature 的 updatedBy / updatedAt 是改规划的人，不是建这条边的）
        deps.push({ from, to: to.id, kind: "blocks", when: "", state: null, derived: state, effective: state,
          createdBy: null, createdAt: null, updatedAt: null });
      }
    });
    tasks.push(...views);
  }
  const ov: LedgerOverview = {
    exists: true, now,
    meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: list.features.map((f) => ({ id: f.id, title: f.title, oneLine: f.description })),
    tasks, deps,
    mirror: list.features.map((f) => mirrorFact(f, details.get(f.id), now, waiting.has(f.id))),
  };
  return { ov, index };
}

export function teamTaskDetail(team: TeamOverview, id: string, now: number): TaskDetail | null {
  const task = team.ov.tasks.find((t) => t.id === id);
  if (!task) return null;
  return task.stepLine ? { task, events: [], timeline: [], stepLine: task.stepLine, now } : { task, events: [], timeline: [], now };
}
