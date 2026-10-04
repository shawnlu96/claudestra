/**
 * 主场台账（home-fixture-gen.ts）→ 中心读到的 FeatureList / FeatureDetail：团队视图吃的那份只能从这里推，不准另造。
 * 卡级字段规则和 src/lib/shared-ledger-projector.ts mirrorTaskProjections 一致（web 不能 import src，所以照规则写成纯函数）；
 * tests/web-team-parity-browser-fixture.test.ts 在临时台账上跑真正的投影器、把同一批行喂给 mirrorTaskRows，逐字段比对，规则漂了就红。
 * feature 级的 counts / status 照中心 refreshFeatureState（src/shared-ledger/feature-state.ts）：只有显式的 done / verified 算完成。
 */
import type { Feature, FeatureDetail, FeatureList, TaskProjection } from "../../../lib/api/shared-ledger";
import { uuidOf, type HomeFixture, type HomeLedgerRow } from "./home-fixture-gen";

export type MirrorTask = Omit<TaskProjection, "taskId">;
/** mirrorTaskProjections 读的台账行：tasks / steps / asks / deps / 每卡最后一条事件 seq */
export interface MirrorRowsInput {
  featureId: string;
  tasks: readonly { id: string; rev: number; stage: string; pr: string | null; headSHA: string | null; featureId: string | null }[];
  /** 任一版本 DAG 上绑过的卡 */
  bound: ReadonlySet<string>;
  lastSeq: ReadonlyMap<string, number>;
  deps: readonly { from: string; to: string }[];
  /** 台账行的 derived 可缺省（库里的行都不是推导出来的） */
  steps: (taskId: string) => readonly { step: string; round: number; rev: number; state: string; derived?: boolean }[];
  asks: (taskId: string) => readonly HomeLedgerRow["asks"][number][];
  meta: Readonly<Record<string, HomeLedgerRow["meta"]>>;
  sourceInstanceId: string;
  seq: number;
  commits: ReadonlySet<string>;
}

const byBinary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const HIDDEN_ASKS: ReadonlySet<string> = new Set(["auq", "permission", "codex"]);

/** 一个 feature 的全量卡投影（mirrorTaskProjections 的字段规则；顺序同它的 SQL：卡按 id，步骤按 step、round） */
export function mirrorTaskRows(input: MirrorRowsInput): MirrorTask[] {
  const tasks = input.tasks.filter((t) => t.featureId === input.featureId || input.bound.has(t.id)).sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.map((task) => {
    const meta = input.meta[task.id] ?? { specSummary: "", specDigest: null, assigneeCode: null };
    return {
      sourceTaskId: task.id, sourceRev: task.rev, sourceSeq: Math.min(input.lastSeq.get(task.id) ?? 0, input.seq), stage: task.stage,
      assigneeCode: meta.assigneeCode, executorInstanceId: input.sourceInstanceId,
      pr: task.pr && /^\d+$/.test(task.pr) && Number(task.pr) > 0 ? Number(task.pr) : null,
      head: task.headSHA && input.commits.has(task.headSHA.toLowerCase()) ? task.headSHA : null,
      deps: input.deps.filter((d) => d.to === task.id && ids.has(d.from)).map((d) => d.from).sort(),
      specSummary: meta.specSummary, specDigest: meta.specDigest, fullText: "home_only" as const,
      steps: [...input.steps(task.id)].sort((a, b) => byBinary(a.step, b.step) || a.round - b.round).filter((s) => !s.derived)
        .map((s) => ({ sourceStepId: `${s.step}:${s.round}`, sourceRev: s.rev, sourceSeq: input.seq, state: s.state })),
      asks: input.asks(task.id).filter((a) => !HIDDEN_ASKS.has(a.source)).map((a) => ({ kind: a.kind, state: a.state, blocking: a.blocking === 1 })),
    };
  });
}

/** 主场本机数据 → 投影器的输入行（featureId 用卡的 itemId：夹具里事项就是 feature） */
export function homeMirrorInput(home: HomeFixture, featureId: string): MirrorRowsInput {
  const lastSeq = new Map<string, number>();
  for (const d of Object.values(home.details)) for (const e of d.events) lastSeq.set(e.target, Math.max(lastSeq.get(e.target) ?? 0, e.seq));
  const f = home.features.find((x) => x.id === featureId);
  return {
    featureId, lastSeq, sourceInstanceId: home.sourceInstanceId, seq: home.seq, commits: new Set(home.commits.map((c) => c.toLowerCase())),
    tasks: home.overview.tasks.map((t) => ({ id: t.id, rev: home.rows[t.id]!.rev, stage: t.stage, pr: t.pr ?? null, headSHA: home.rows[t.id]!.headSHA, featureId: t.itemId ?? null })),
    bound: new Set((f?.versions ?? []).flatMap((v) => v.nodes.flatMap((n) => (n.taskId ? [n.taskId] : [])))),
    deps: home.overview.deps ?? [], steps: (id) => home.rows[id]?.steps ?? [], asks: (id) => home.rows[id]?.asks ?? [],
    meta: Object.fromEntries(Object.entries(home.rows).map(([id, r]) => [id, r.meta])),
  };
}

/** 中心给的 taskId 是它自己的 UUID，不是主场卡号（团队适配器要能区分） */
export const centerTaskId = (home: HomeFixture, sourceTaskId: string) => uuidOf(`center-task:${home.team}:${sourceTaskId}`);

const CAPS = { "feature.new": { enabled: true }, "dag.init": { enabled: true }, "dag.rewrite": { enabled: true },
  "task.new": { enabled: false, reason: "V1 仅共享规划，执行操作仍在主场" }, "dag.bind": { enabled: false }, stage: { enabled: false }, approval: { enabled: false } };

export interface TeamFromHome { list: FeatureList; details: FeatureDetail[] }

/** authorityMode 缺省 planning：导入时开了共享规划（sharedPlanning）的 feature，团队可以改规划；source 是只读镜像 */
export function homeToTeam(home: HomeFixture, opts: { observedAt?: number; serverSeq?: number; authorityMode?: Feature["authorityMode"] } = {}): TeamFromHome {
  const observedAt = opts.observedAt ?? home.now, serverSeq = opts.serverSeq ?? 40;
  const details = home.features.map((f): FeatureDetail => {
    const cur = f.versions.at(-1)!;
    const tasks = mirrorTaskRows(homeMirrorInput(home, f.id)).map((t) => ({ taskId: centerTaskId(home, t.sourceTaskId), ...t }));
    const bindings = cur.nodes.flatMap((n) => (n.taskId ? [{ nodeKey: n.key, taskId: centerTaskId(home, n.taskId) }] : []));
    const bound = bindings.map((b) => tasks.find((t) => t.taskId === b.taskId)).filter((t) => t !== undefined);
    const counts = { total: cur.nodes.length, completed: bound.filter((t) => t.stage === "done" || t.stage === "verified").length,
      blocked: bound.filter((t) => t.stage === "blocked").length, missing: bindings.length - bound.length };
    const status: Feature["status"] = counts.total > 0 && counts.completed === counts.total ? "done" : counts.blocked ? "blocked" : tasks.length ? "active" : "planned";
    const feature: Feature = { id: f.centerId, projectId: home.project, title: f.title, description: f.ownerWords, rev: 3, version: cur.meta.version,
      authorityMode: opts.authorityMode ?? "planning", homeInstanceId: home.sourceInstanceId,
      executorInstanceIds: [...new Set(tasks.flatMap((t) => (t.executorInstanceId ? [t.executorInstanceId] : [])))],
      status, counts, updatedBy: "person-a", updatedAt: cur.meta.createdAt,
      projection: { sourceInstanceId: home.sourceInstanceId, sourceSeq: home.seq, observedAt, receivedAt: observedAt } };
    return { schemaVersion: 1, teamId: home.team, serverSeq, capabilities: CAPS, feature,
      dag: { version: cur.meta.version, nodes: cur.nodes.map((n) => ({ key: n.key, oneLine: n.oneLine, deps: n.deps, fileGlobs: n.fileGlobs, estimate: n.estimate })), bindings }, tasks };
  });
  return { list: { schemaVersion: 1, teamId: home.team, serverSeq, capabilities: CAPS, features: details.map((d) => d.feature) }, details };
}
