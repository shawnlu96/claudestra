/**
 * team-project-UXWHO1：「谁在干活」显示真名、动作、时长，合并排队单独一栏。
 * 对照基准 A（团队键）：本机实例是 3 张卡的执行实例、1 张在 peer、1 张实例未知，其中 2 张在合并阶段；另有一张主场本机、卡号带 `~2` 的。
 * 成员代号与实例 id 都是 24 位十六进制（中心投影原样）。本机 /work 看板对应 3 张行带执行者名 / 步骤 / 轮次 / 已持续。
 * 对照基准 B（本机项目没绑团队）：看板里 2 行合并排队、1 行等 CI、1 行正在合并。走真实的 teamOverview / teamDagBoard / teamWorkBoard。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homeView, stageLabel, type LedgerOverview, type LedgerTaskView } from "@/features/collab/collab-model";
import { peerInstanceNames } from "@/features/collab/team-instance-names";
import { teamOverview } from "@/features/collab/team-source-adapter";
import { teamDagBoard } from "@/features/collab/team-source-dag";
import { teamWorkBoard } from "@/features/collab/team-work-model";
import { jumpToNode } from "@/features/collab/dag/dag-progress";
import { COLUMNS, localColumns, mergeTeamWork, needsLocalBoard, needsNames } from "@/features/collab/work/team-work-merge";
import type { TeamBoardRow, TeamWorkBoard, WorkBoard, WorkRow } from "@/features/collab/work/work-types";
import type { FeatureDetail, FeatureList, PlanNode, TaskProjection } from "@/lib/api/shared-ledger";
import { testChildEnv } from "./test-env";

const now = Date.UTC(2026, 9, 13, 12, 0), MIN = 60_000;
const LOCAL = "a1b2c3d4e5f60718293a4b5c", PEER = "0f1e2d3c4b5a69788796a5b4", UNKNOWN = "ffeeddccbbaa998877665544";
const HEX = /[0-9a-f]{16,}/i;
const NAMES = peerInstanceNames([{ id: "peer-mac", name: "peer-mac", instanceId: PEER }, { id: "old", name: "old-peer" }]);

/** [卡号, 阶段, 执行实例] ；L1 在两个 feature 里都有，第二张去重成 L1~2 */
const F1: [string, string, string][] = [["L1", "build", LOCAL], ["L2", "review", LOCAL], ["L3", "merge", LOCAL], ["P1", "fix", PEER], ["U1", "merge", UNKNOWN]];
const F2: [string, string, string][] = [["L1", "build", LOCAL]];

function feature(id: string, cards: [string, string, string][]) {
  const nodes: PlanNode[] = cards.map(([key]) => ({ key, oneLine: `${key} 一句话`, deps: [], fileGlobs: [], estimate: "2h" }));
  const tasks: TaskProjection[] = cards.map(([key, stage, exec], i) => ({ taskId: `${id}-t${i}`, sourceTaskId: key, sourceRev: 1, sourceSeq: 10, stage,
    assigneeCode: `${i}c0de1234567890abcdef12345`.slice(0, 24), executorInstanceId: exec, pr: null, head: null, deps: [], specSummary: `${key} 规格摘要`,
    specDigest: null, fullText: "home_only", steps: [], asks: [] }));
  const f: FeatureList["features"][number] = { id, projectId: "p", title: id, description: "", rev: 1, version: 1, authorityMode: "planning",
    homeInstanceId: LOCAL, executorInstanceIds: [LOCAL, PEER, UNKNOWN], status: "active", counts: { total: nodes.length, completed: 0, blocked: 0, missing: 0 },
    updatedBy: "pm", updatedAt: now, projection: { sourceInstanceId: LOCAL, sourceSeq: 10, observedAt: now - MIN, receivedAt: now - MIN } };
  const detail: FeatureDetail = { schemaVersion: 1, teamId: "team-a", serverSeq: 5, capabilities: {}, feature: f,
    dag: { version: 1, nodes, bindings: tasks.map((t) => ({ nodeKey: t.sourceTaskId, taskId: t.taskId })) }, tasks };
  return { f, detail };
}

function teamDag(f1 = F1) {
  const a = feature("fa", f1), b = feature("fb", F2);
  const list: FeatureList = { schemaVersion: 1, teamId: "team-a", serverSeq: 5, capabilities: {}, features: [a.f, b.f] };
  const details = new Map([["fa", a.detail], ["fb", b.detail]]);
  const team = teamOverview(list, details, now);
  const dag = teamDagBoard("p", list, details, team);
  return { dag, board: teamWorkBoard(dag, team.ov, now) };
}
const teamA = (): TeamWorkBoard => teamDag().board;

const row = (id: string, patch: Partial<WorkRow> = {}): WorkRow => ({ taskId: id, featureId: "local-f", nodeKey: id, title: `${id} 本机标题`,
  who: `agent-${id.toLowerCase()}`, machine: "local", step: "write", round: 1, since: now - 25 * MIN, normalMinutes: 60, remainingMinutes: 35, overMinutes: 0,
  reason: null, code: null, estimate: "2h", ...patch });
const localA: WorkBoard = { now, asOfSeq: 1, machines: { local: 2 }, completionHours: 3, availableSlots: 2,
  working: [row("L1"), row("L2", { who: "agent-rv-2", step: "review", round: 2, since: now - 10 * MIN })],
  waiting: [row("L3", { step: "merge", reason: "合并排队：前面是 X9", code: "merge_queue", since: now - 5 * MIN })],
  todo: { ready: [], blocked: [] } };

const ids = (rows: readonly TeamBoardRow[]) => rows.map((r) => r.taskId);
const at = (b: TeamWorkBoard, id: string) => COLUMNS.flatMap((c) => b[c]).find((r) => r.taskId === id)!;
const isLocal = (r: TeamBoardRow): r is WorkRow => "since" in r;

test("[验收线 1] 本机 3 张换成本机看板行；peer 写 peer 名、未知写其他成员的机器；~2 保留团队行；合并进在等合并，在干活只有写 / 审 / 修", () => {
  const raw = teamA();
  expect(ids([...raw.working, ...raw.merging]).sort()).toEqual(["L1", "L1~2", "L2", "L3", "P1", "U1"]);
  const b = mergeTeamWork(raw, localA, LOCAL, NAMES);
  expect(ids(b.working).sort()).toEqual(["L1", "L1~2", "L2", "P1"]);
  expect(ids(b.merging).sort()).toEqual(["L3", "U1"]);
  expect(b.waiting).toEqual([]);
  // 本机主场的三张：执行者、步骤、轮次、已持续、等待原因、机器全照本机看板
  expect(at(b, "L1")).toMatchObject({ who: "agent-l1", step: "write", round: 1, since: now - 25 * MIN, machine: "本机" });
  expect(at(b, "L2")).toMatchObject({ who: "agent-rv-2", step: "review", round: 2, since: now - 10 * MIN, machine: "本机" });
  expect(at(b, "L3")).toMatchObject({ who: "agent-l3", reason: "合并排队：前面是 X9", code: "merge_queue", machine: "本机" });
  // 别的成员机器上的：peer 名 / 其他成员的机器，实例 id 只在 instance（title 提示）
  expect(at(b, "P1")).toMatchObject({ machine: "peer-mac", instance: PEER, stage: "fix" });
  expect(at(b, "U1")).toMatchObject({ machine: "其他成员的机器", instance: UNKNOWN, reason: "等合并" });
  // 卡号带 ~2 的对不上本机卡号：保留团队行（主场在本机，机器写本机），不拿 L1 的本机行去猜
  expect(isLocal(at(b, "L1~2"))).toBe(false);
  expect(at(b, "L1~2")).toMatchObject({ machine: "本机", stage: "build" });
  // 在干活只有写 / 审 / 修
  for (const r of b.working) expect(isLocal(r) ? ["write", "review", "fix"] : ["build", "review", "fix"]).toContain(isLocal(r) ? r.step! : r.stage!);
  expect(b.machines).toEqual({ 本机: 3, "peer-mac": 1 });
  // 所有给人看的字符串（不含 instance / 镜像事实）没有 16 位以上十六进制：团队成员代号像 id 的不显示
  for (const r of [...COLUMNS.flatMap((c) => b[c]), ...b.todo.ready, ...b.todo.blocked]) {
    for (const v of [r.who, r.machine, r.title, r.reason, r.taskId, r.nodeKey]) expect(HEX.test(v ?? "")).toBe(false);
  }
  for (const k of Object.keys(b.machines)) expect(HEX.test(k)).toBe(false);
});

/** WorkBoardContent 在子进程里 SSR（同 web-team-work-model.test.ts），React 不进根测试进程 */
function render(board: unknown, team: boolean): string {
  const script = `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { WorkBoardContent } from './features/collab/work/work-board-content.tsx';
    const tr = (s, v = {}) => s.replace(/\\{(\\w+)\\}/g, (_, k) => String(v[k]));
    console.log(renderToStaticMarkup(createElement(WorkBoardContent, { team: ${team}, board: ${JSON.stringify(board)}, retrying: false, tr, onNode() {}, onTask() {} })));
  `;
  const p = Bun.spawnSync([process.execPath, "--no-env-file", "-e", script], { cwd: resolve(import.meta.dir, "../web"), env: testChildEnv(), stdout: "pipe", stderr: "pipe" });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  return p.stdout.toString();
}
const visible = (html: string) => html.replace(/\s(title|d)="[^"]*"/g, "").replace(/<[^>]+>/g, " ");

test("[验收线 1] 页面上：本机行有 agent 名 · 本机、步骤与已持续；实例 id 只在 title，可见文字没有长十六进制", () => {
  const html = render(mergeTeamWork(teamA(), localA, LOCAL, NAMES), true);
  const text = visible(html);
  expect(text).toContain("agent-l1 · 本机");
  expect(text).toContain("25m");
  expect(text).toContain("peer-mac");
  expect(text).toContain("其他成员的机器");
  expect(text).toContain("合并排队：前面是 X9");
  expect(text).toMatch(/在等合并\s*<?\S*\s*2/);
  expect(HEX.test(text)).toBe(false);
  expect(html).toContain(`title="${UNKNOWN}"`);
  expect(text).not.toContain("队列第");
});

test("[验收线 2] 主场全在别的机器（或团队键没有本机实例）：不需要本机看板；需要名字只看有没有非本机执行实例", () => {
  const raw = teamA();
  expect(needsLocalBoard(raw, LOCAL)).toBe(true);
  expect(needsLocalBoard(raw, null)).toBe(false);
  expect(needsLocalBoard(raw, "some-other-instance")).toBe(false);
  expect(needsLocalBoard(null, LOCAL)).toBe(false);
  const onlyLocal = { ...raw, working: raw.working.filter((r) => !isLocal(r) && r.instance === LOCAL), merging: [] };
  expect(needsNames(onlyLocal, LOCAL)).toBe(false);
  expect(needsNames(raw, LOCAL)).toBe(true);
  // 本机看板还没回来：团队行原样（命名后）显示，不丢卡
  const pending = mergeTeamWork(raw, null, LOCAL, NAMES);
  expect(ids([...pending.working, ...pending.merging]).sort()).toEqual(["L1", "L1~2", "L2", "L3", "P1", "U1"]);
  expect(at(pending, "L1")).toMatchObject({ machine: "本机" });
});

const task = (id: string, stage: LedgerTaskView["stage"], extra: Partial<LedgerTaskView> = {}): LedgerTaskView =>
  ({ id, itemId: "F1", title: id, kind: "code", stage, round: 1, agent: `agent-${id}`, pm: null, updatedAt: now, metrics: {}, ...extra });

test("[验收线 3] 没有进入合并时刻的团队卡写「等合并」，不出现队列第 1 位；本机卡照旧按进入先后排位", () => {
  const team = [task("T1", "merge", { team: { assigneeCode: null, executorInstanceId: LOCAL, head: null, blockingAsks: 0, mirror: "fresh", freshUntil: now + MIN } }),
    task("T2", "merge")];
  for (const t of team) expect(stageLabel(t, team, null)).toBe("等合并");
  const local = [task("M1", "merge", { stageSince: now - 42 * MIN }), task("M2", "merge", { stageSince: now - 10 * MIN }), task("M0", "merge")];
  expect(stageLabel(local[0]!, local, null)).toBe("等合并 · 队列第 1 位");
  expect(stageLabel(local[1]!, local, null)).toBe("等合并 · 队列第 2 位");
  expect(stageLabel(local[2]!, local, null)).toBe("等合并");
  expect(stageLabel(local[0]!, local, "冻结")).toBe("合并队列冻结");
  const ov: LedgerOverview = { exists: true, now, meta: { pms: [], docsDir: null, queueFrozen: { frozen: false, reason: "", since: null } },
    items: [{ id: "F1", title: "F1", oneLine: "" }], tasks: team, deps: [] };
  expect(homeView(ov, now).lines.map((l) => l.stageLabel)).toEqual(["等合并", "等合并"]);
});

const localB: WorkBoard = { now, asOfSeq: 1, machines: { local: 2, "peer-box": 1 }, completionHours: 4, availableSlots: 2,
  working: [row("W1"), row("W2", { who: "peer:peer-box · codex", machine: "peer-box", step: "fix" }), row("G1", { step: "merge" })],
  waiting: [row("Q1", { step: "merge", reason: "合并排队：前面是 G1", code: "merge_queue" }), row("Q2", { step: "merge", reason: "合并排队：前面是 G1、Q1", code: "merge_queue" }),
    row("C1", { step: "merge", reason: "等 CI", code: "ci" }), row("A1", { reason: "等 owner", code: "owner" })],
  todo: { ready: [row("R1", { step: null })], blocked: [] } };

test("[验收线 4] 本机项目看板四栏：合并排队 / 等 CI / 正在合并在「在等合并」；机器名原样，没有硬编码人名", () => {
  const c = localColumns(localB);
  expect(ids(c.working)).toEqual(["W1", "W2"]);
  expect(ids(c.merging)).toEqual(["G1", "Q1", "Q2", "C1"]);
  expect(c.merging[0]!.reason).toBe("正在合并");
  expect(ids(c.waiting)).toEqual(["A1"]);
  const text = visible(render(localB, false));
  for (const [label, n] of [["在干活", 2], ["在等合并", 4], ["在等", 1], ["待做", 1]] as const) expect(text).toMatch(new RegExp(`${label}\\s+${n}\\b`));
  expect(text).toContain("本机 2 / peer-box 1");
  const src = readFileSync(resolve(import.meta.dir, "../web/features/collab/work/work-board-content.tsx"), "utf8");
  for (const name of ["Sekai", "HedeMacBook", "孟总", "'He'"]) expect(src).not.toContain(name);
});

test("[回归] 换成本机工作事实后，点卡仍跳团队 DAG：坐标与标题留团队的（本机 feature id / 节点键与中心不同）", () => {
  const { dag, board } = teamDag();
  const b = mergeTeamWork(board, localA, LOCAL, NAMES);
  for (const id of ["L1", "L2", "L3"]) {
    const r = at(b, id), orig = at(board, id);
    expect(isLocal(r)).toBe(true);
    expect(r).toMatchObject({ featureId: "fa", nodeKey: id, title: orig.title });
    expect(jumpToNode(dag.features, [], r.featureId!, r.nodeKey!)).not.toBeNull();
  }
  expect(jumpToNode(dag.features, [], "local-f", "L1")).toBeNull();
});

test("[回归] 团队阶段约束换行后的栏：上线 / 等 PM 放行 / 合并不会因本机轮询被拉回在干活；本机步骤已上线的不算在干活", () => {
  const cards: [string, string, string][] = [["L1", "live", LOCAL], ["L2", "restate", LOCAL], ["L3", "merge", LOCAL], ["L4", "build", LOCAL], ["L5", "build", LOCAL]];
  const { board } = teamDag(cards);
  const local: WorkBoard = { ...localA, waiting: [],
    working: [row("L1", { step: "deploy" }), row("L2", { step: "restate" }), row("L3", { step: "write" }), row("L4", { step: "deploy" }), row("L5", { step: "publishing" })] };
  const b = mergeTeamWork(board, local, LOCAL, NAMES);
  expect(ids(b.working)).toEqual(["L5", "L1~2"]);
  expect(ids(b.merging)).toEqual(["L3"]);
  expect(ids(b.waiting).sort()).toEqual(["L1", "L2", "L4"]);
  expect(at(b, "L1")).toMatchObject({ step: "deploy", reason: "已上线 · 等验证", machine: "本机" });
  expect(at(b, "L2")).toMatchObject({ reason: "等 PM 放行" });
  expect(at(b, "L3")).toMatchObject({ who: "agent-l3", reason: "等合并" });
  for (const r of b.working) expect(["write", "review", "fix", "publishing", "build"]).toContain(isLocal(r) ? r.step! : r.stage!);
  expect(b.machines).toEqual({ 本机: 2 });
});
