/**
 * team-project-N8B1：团队产品卡的完成 / 进行中 / 受阻与本机产品板 nodeCounts 同一套规则（PAGEOK r11 F3）。
 * 夹具 A 照「会话列表」（main 上显示 6 进行中 · 3 受阻，本机 3 / 8）；夹具 B 照「直连优先」（main 上受阻 0，本机 19）。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { sharedProductBoard } from "@/features/collab/dag/shared-product-model";
import { teamOverview } from "@/features/collab/team-source-adapter";
import type { FeatureDetail, FeatureList, TaskProjection } from "@/lib/api/shared-ledger";
import { nodeCounts } from "../src/lib/ledger-product-board.js";
import type { EtaNode } from "../src/lib/ledger-product-board-eta.js";
import type { LedgerTask, Stage } from "../src/lib/ledger-stages.js";

const warns: string[] = [];
const realWarn = console.warn;
beforeEach(() => { warns.length = 0; console.warn = (...a: unknown[]) => void warns.push(a.join(" ")); });
afterEach(() => { console.warn = realWarn; });

const now = 1_791_600_000_000;
/** stage：null = 没绑卡；"missing" = 绑了卡但中心详情里没有这张卡 */
interface N { key: string; stage: Stage | null | "missing"; deps: string[]; oneLine?: string }
const n = (key: string, stage: N["stage"], deps: string[] = [], oneLine?: string): N => ({ key, stage, deps, oneLine });
const proj = (key: string, stage: string): TaskProjection => ({ taskId: `t-${key}`, sourceTaskId: `C-${key}`, sourceRev: 1, sourceSeq: 1, stage,
  assigneeCode: null, executorInstanceId: null, pr: null, head: null, deps: [], specSummary: key, specDigest: null, fullText: "home_only", steps: [], asks: [] });

function fixture(nodes: N[], center: { completed: number; blocked: number }, loose: TaskProjection[] = []) {
  const feature: FeatureList["features"][number] = { id: "f1", projectId: "p", title: "会话列表", description: "", rev: 1, version: 1,
    authorityMode: "source", homeInstanceId: "home", executorInstanceIds: [], status: "active",
    counts: { total: nodes.length, ...center, missing: 0 }, updatedBy: "x", updatedAt: now - 1000, projection: null };
  const snap = { schemaVersion: 1 as const, teamId: "team", serverSeq: 1, capabilities: {} };
  const detail: FeatureDetail = { ...snap, feature,
    dag: { version: 1, nodes: nodes.map((x) => ({ key: x.key, oneLine: x.oneLine ?? x.key, deps: x.deps, fileGlobs: [], estimate: "" })),
      bindings: nodes.filter((x) => x.stage).map((x) => ({ nodeKey: x.key, taskId: `t-${x.key}` })) },
    tasks: [...nodes.flatMap((x) => x.stage && x.stage !== "missing" ? [proj(x.key, x.stage)] : []), ...loose] };
  const list: FeatureList = { ...snap, features: [feature] };
  const details = new Map([[feature.id, detail]]);
  const team = sharedProductBoard(list, now, teamOverview(list, details, now).ov.tasks, details).features[0]!.counts;
  const local = nodeCounts(nodes.map((x): EtaNode => ({ key: x.key, taskId: x.stage ? `t-${x.key}` : null, oneLine: x.oneLine ?? x.key, deps: x.deps,
    estimate: "", status: "planned", inheritedFrom: null,
    task: x.stage && x.stage !== "missing" ? ({ id: `t-${x.key}`, stage: x.stage, project: "p", kind: "code", updatedAt: 1 } as LedgerTask) : null })));
  return { team, local };
}

const range = (p: string, k: number) => Array.from({ length: k }, (_, i) => `${p}${i}`);

test("夹具 A（会话列表，33 节点）：14 / 33 · 3 进行中 · 8 受阻，与本机 nodeCounts 相同（main 上 6 / 3）", () => {
  const done = range("d", 14);
  const nodes = [...done.map((k) => n(k, "verified")), ...range("b", 3).map((k) => n(k, "blocked", [done[0]!])),
    n("fix", "fix", done), n("live", "live", done), n("merge", "merge", done),
    ...range("r", 8).map((k) => n(k, null, [done[1]!])), ...range("w", 5).map((k) => n(k, null, ["fix"]))];
  // 游离卡（没挂在节点上）不计数
  const { team, local } = fixture(nodes, { completed: 14, blocked: 3 }, [proj("loose", "build")]);
  expect(nodes.length).toBe(33);
  expect(local).toMatchObject({ total: 33, completed: 14, active: 3, blocked: 8, ready: 8 });
  expect(team).toMatchObject({ total: 33, completed: 14, active: local.active, blocked: local.blocked });
  expect(team.activeUnknown).toBeUndefined();
  expect(warns).toEqual([]);
});

test("夹具 B（直连优先，23 节点）：3 完成、19 等依赖、1 可开工 → 团队受阻 19，与本机相同（main 上 0）", () => {
  const nodes = [...range("d", 3).map((k) => n(k, "done")), n("next", null, ["d0"]), ...range("w", 19).map((k) => n(k, null, ["next"]))];
  const { team, local } = fixture(nodes, { completed: 3, blocked: 0 });
  expect(local).toMatchObject({ total: 23, completed: 3, active: 0, ready: 1, blocked: 19 });
  expect(team).toMatchObject({ total: 23, completed: 3, active: local.active, blocked: 19 });
  expect(warns).toEqual([]);
});

test("远期 / 取消 / 卡缺失 / 没绑卡 spec / 游离卡混合：团队进行中、受阻与本机一致", () => {
  const nodes = [n("ok", "verified"), n("x", "cancelled"), n("lost", "missing"), n("plan", null, ["x"]), n("spec", "spec", ["lost"]),
    n("go", "build", ["ok"]), n("far", null, ["go"], "（远期）以后再说")];
  const { team, local } = fixture(nodes, { completed: 2, blocked: 0 }, [proj("loose", "blocked")]);
  expect(local).toMatchObject({ completed: 2, active: 1, ready: 1, blocked: 2, deferred: 1 });
  expect(team).toMatchObject({ completed: 2, active: local.active, blocked: local.blocked });
  expect(warns).toEqual([]);
});

test("绑卡已取消的节点计完成；中心还不算它时以中心为准并 warn，显示不变（留给 N8B3）", () => {
  const { team, local } = fixture([n("ok", "verified"), n("x", "cancelled"), n("next", null, ["x"])], { completed: 1, blocked: 0 });
  expect(local.completed).toBe(2);
  expect(team.completed).toBe(1);
  expect(team.active).toBe(local.active);
  expect(team.blocked).toBe(local.blocked);
  expect(warns.some((w) => w.includes("f1") && w.includes("以中心为准"))).toBe(true);
});
