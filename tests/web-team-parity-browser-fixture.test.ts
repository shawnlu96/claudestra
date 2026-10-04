/**
 * team-parity-C 的纯逻辑部分（常跑，不开浏览器）：
 * ① 本机夹具是全量的（审查 pass / changes / block 各一、事件 data 完整、DAG 有两版）；
 * ② home-to-team-fixture.ts 的卡投影规则和真投影器 mirrorTaskProjections 逐字段一致（临时台账上跑 pushSharedLedgerMirror 对拍）；
 * ③ 旧「本机由团队模型生成」的喂法让 T3 / T5 / T7 的消费者全空，本机数据下都有内容（数据层旧红新绿）；
 * ④ 矩阵比对器的受控变异：缺口修好 → stale_gap，退回 → fail，期望只能往 present 走。
 * 浏览器对照见 tests/web-team-parity-browser.test.ts（opt-in）。
 */
import { expect, test } from "bun:test";
import { createTask, moveStage, setTask } from "../src/lib/ledger-write.js";
import { bindNode } from "../src/lib/ledger-dag-write.js";
import { addDep } from "../src/lib/ledger-deps-write.js";
import { getTask, listDeps, listTasks } from "../src/lib/ledger-store.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import type { SharedLedgerProjection } from "../src/lib/shared-ledger-contract.js";
import { pushSharedLedgerMirror } from "../src/lib/shared-ledger-projector.js";
import { integrationFixture } from "./shared-ledger-integration-fixture.test.js";
import { globalSeq, mirrorEntry, SCRUB } from "./shared-ledger-mirror-fixture.test.js";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { homeToTeam, mirrorTaskRows } from "@/features/collab/shared/home-to-team-fixture";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { recentThree, reviewRows, stageSegments } from "@/features/collab/collab-detail-model";
import { compareMatrix, MATRIX, ratchetViolations, type Observed } from "./helpers/team-parity-matrix";

test("home fixture is a full home ledger: complete event data, every review verdict, two DAG versions", () => {
  const home = generateHomeFixture();
  const events = Object.values(home.details).flatMap((d) => d.events);
  expect(new Set(events.filter((e) => e.kind === "review").map((e) => e.data.verdict))).toEqual(new Set(["pass", "changes", "block"]));
  for (const e of events.filter((e) => e.kind === "stage")) expect(typeof e.data.from === "string" && typeof e.data.to === "string").toBe(true);
  for (const e of events.filter((e) => e.kind === "review")) for (const k of ["round", "p0", "p1", "p2"]) expect(typeof e.data[k]).toBe("number");
  for (const e of events.filter((e) => e.kind === "verify")) expect(e.data.result).toBe("pass");
  expect(home.features.every((f) => f.versions.length === 2)).toBe(true);
  // 每张卡的事件 seq 全局递增且不超过台账 seq；总览里的卡和详情一一对应
  expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual(events.map((_, i) => i + 1));
  expect(Math.max(...events.map((e) => e.seq))).toBe(home.seq);
  expect(home.overview.tasks.map((t) => t.id).sort()).toEqual(Object.keys(home.details).sort());
  // 确定性：同参数同输出（截图可比）
  expect(JSON.stringify(generateHomeFixture())).toBe(JSON.stringify(home));
});

test("team side is derived from the same home data: titles, stages, deps and bindings line up", () => {
  const home = generateHomeFixture(), team = homeToTeam(home);
  const ov = teamOverview(team.list, new Map(team.details.map((d) => [d.feature.id, d])), home.now).ov;
  for (const t of home.overview.tasks) {
    const v = ov.tasks.find((x) => x.id === t.id)!;
    expect({ id: v.id, title: v.title, stage: v.stage }).toEqual({ id: t.id, title: t.title, stage: t.stage });
  }
  // 没开卡的计划节点只在团队这边以 spec 出现（中心只有规划）
  expect(ov.tasks.filter((t) => !home.details[t.id]).map((t) => t.stage)).toEqual(["spec", "spec"]);
  expect(ov.deps!.map((d) => `${d.from}>${d.to}`).filter((e) => home.overview.deps!.some((x) => `${x.from}>${x.to}` === e)).length)
    .toBe(home.overview.deps!.length);
  // URL 形式的 PR、不在提交集里的 head 按投影规则变 null；成员只有代号，不带本机 agent 名
  const tasks = team.details.flatMap((d) => d.tasks);
  expect(tasks.find((t) => t.sourceTaskId === "i28-A3")!.pr).toBeNull();
  expect(tasks.find((t) => t.sourceTaskId === "i28-A1")!.head).toBe(home.rows["i28-A1"]!.headSHA);
  expect(tasks.find((t) => t.sourceTaskId === "i28-A4")!.head).toBeNull();
  expect(JSON.stringify(team)).not.toContain("agent-dev");
  expect(tasks.find((t) => t.sourceTaskId === "i28-A7")!.asks).toEqual([{ kind: "decide", state: "open", blocking: true }]);
});

test("mirrorTaskRows follows the real mirrorTaskProjections field rules on a temp ledger", async () => {
  const f = integrationFixture();
  try {
    const ctx = { actor: f.actor }, now = Date.now();
    moveStage(f.db, ctx, { taskId: "c5-existing", from: "spec", to: "restate" });
    createTask(f.db, ctx, { project: f.project, id: "c5-new", title: "New card", kind: "code" });
    bindNode(f.db, ctx, { id: f.id, rev: f.feature().rev, key: "next", taskId: "c5-new" });
    addDep(f.db, ctx, { from: "c5-existing", to: "c5-new", when: "verified" });
    createTask(f.db, ctx, { project: f.project, id: "c5-loose", title: "Unbound card in another feature", kind: "code" });
    const head = "a".repeat(40), other = "b".repeat(40);
    setTask(f.db, ctx, { id: "c5-existing", rev: getTask(f.db, "c5-existing")!.rev, patch: { pr: "417", headSHA: head } });
    setTask(f.db, ctx, { id: "c5-new", rev: getTask(f.db, "c5-new")!.rev, patch: { pr: "https://github.com/x/y/pull/9", headSHA: other } });
    const step = f.db.prepare("INSERT INTO task_steps (taskId, step, round, executor, executorKind, state, verdict, rev, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)");
    step.run("c5-existing", "write", 1, "agent-dev", "agent", "done", null, 2, now, now);
    step.run("c5-existing", "review", 1, "agent-rv", "agent", "done", "changes", 3, now, now);
    step.run("c5-existing", "fix", 1, "agent-dev", "agent", "assigned", null, 1, now, now);
    step.run("c5-existing", "restate", 1, "agent-dev", "agent", "done", null, 1, now, now);
    const ask = f.db.prepare("INSERT INTO asks (id, project, taskId, fromAgent, fromChannelId, source, kind, blocking, title, expiresAt, state, createdAt, updatedAt)"
      + " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ask.run("ask-1", f.project, "c5-existing", "agent-dev", "c", "reply", "decide", 1, "t", now + 1e6, "open", now, now);
    ask.run("ask-2", f.project, "c5-existing", "agent-dev", "c", "permission", "authorize", 0, "t", now + 1e6, "open", now, now);
    ask.run("ask-3", f.project, "c5-new", "agent-dev", "c", "reply", "owner_action", null, "t", now + 1e6, "answered", now, now);
    const taskMeta = { "c5-existing": { specSummary: "Existing work", specDigest: null, assigneeCode: "m-01" } };
    const sent: SharedLedgerProjection[] = [];
    const entry = mirrorEntry(f, 0, { snapshot: true, taskMeta });
    const r = await pushSharedLedgerMirror(f.db, f.id, entry, { scrub: { ...SCRUB, commits: new Set([head]) }, now, client: { async projection(p) {
      sent.push(structuredClone(p));
      return { schemaVersion: 1, serverSeq: 1, sourceInstanceId: p.sourceInstanceId, sourceSeq: p.sourceSeq, digest: "a".repeat(64) };
    } } });
    expect(r.outcome.kind).toBe("pushed");
    const seq = globalSeq(f), tasks = listTasks(f.db, f.project);
    const lastSeq = new Map((f.db.prepare("SELECT target, MAX(seq) AS seq FROM events WHERE project = ? GROUP BY target").all(f.project) as { target: string; seq: number }[])
      .map((x) => [x.target, x.seq]));
    const ours = mirrorTaskRows({
      featureId: f.id, tasks: tasks.map((t) => ({ id: t.id, rev: t.rev, stage: t.stage, pr: t.pr, headSHA: t.headSHA, featureId: t.featureId ?? null })),
      bound: new Set(["c5-existing", "c5-new"]), lastSeq, deps: listDeps(f.db, f.project),
      steps: (id) => listSteps(f.db, id), sourceInstanceId: entry.sourceInstanceId, seq, commits: new Set([head]), meta: taskMeta,
      asks: (id) => f.db.prepare("SELECT kind, state, blocking, source FROM asks WHERE taskId = ? ORDER BY id").all(id) as never,
    });
    expect(sent[0]!.tasks.length).toBe(2);
    expect(ours).toEqual(sent[0]!.tasks as never);
    // 被测规则确实走到了：数字 PR、URL PR → null、未知 head → null、隐藏来源的提问被滤、步骤按 step 排序
    expect(ours.map((t) => [t.sourceTaskId, t.pr, t.head])).toEqual([["c5-existing", 417, head], ["c5-new", null, null]]);
    expect(ours[0]!.steps.map((s) => s.sourceStepId)).toEqual(["fix:1", "restate:1", "review:1", "write:1"]);
    expect(ours[0]!.asks).toEqual([{ kind: "decide", state: "open", blocking: true }]);
    expect(ours[1]!.deps).toEqual(["c5-existing"]);
  } finally { await f.close(); }
});

test("old red / new green at the data layer: team-model-fed local detail empties T3/T5/T7 consumers", () => {
  const home = generateHomeFixture(), team = homeToTeam(home);
  const tov = teamOverview(team.list, new Map(team.details.map((d) => [d.feature.id, d])), home.now);
  const legacy = teamTaskDetail(tov, "i28-A5", home.now)!, real = home.details["i28-A5"]!;
  const consumers = (d: typeof real) => ({
    T3: stageSegments(d).some((g) => g.ms > 0), T5: recentThree(d.events).length > 0, T7: reviewRows(d.events).length > 0,
  });
  expect(consumers(legacy)).toEqual({ T3: false, T5: false, T7: false });
  expect(consumers(real)).toEqual({ T3: true, T5: true, T7: true });
  expect(reviewRows(real.events).map((r) => r.verdict)).toEqual(["block"]);
  expect(recentThree(real.events).some((r) => r.text.includes("undefined"))).toBe(false);
});

test("matrix comparator: expectation hit, known gap, fixed gap and regressions are told apart", () => {
  const team: Observed = Object.fromEntries(MATRIX.map((r) => [r.section, r.gap?.team ?? r.team]));
  expect(compareMatrix("team", team).filter((r) => r.verdict !== "pass" && r.verdict !== "known_gap")).toEqual([]);
  // 受控变异 1：P1-I 修好了「审查」（home_only）→ 登记的缺口变 stale_gap，逼着删 gap
  expect(compareMatrix("team", { ...team, "审查": "home_only" }).find((r) => r.section === "审查")!.verdict).toBe("stale_gap");
  // 受控变异 2：A 类区块在团队里没了 → fail；假 0 换成另一种错误（absent）→ fail，不算已知缺口
  expect(compareMatrix("team", { ...team, "因果线": "absent" }).find((r) => r.section === "因果线")!.verdict).toBe("fail");
  expect(compareMatrix("team", { ...team, "在场 agent": "absent" }).find((r) => r.section === "在场 agent")!.verdict).toBe("fail");
  // 本机期望没有缺口可言：少了就是 fail
  const local: Observed = Object.fromEntries(MATRIX.map((r) => [r.section, r.local]));
  expect(compareMatrix("local", { ...local, "最近 3 件事": "absent" }).find((r) => r.section === "最近 3 件事")!.verdict).toBe("fail");
  // 矩阵只许往 present 走：删行、放宽本机、团队期望退到别的状态都算违规
  const moved = MATRIX.map((r) => (r.section === "审查" ? { ...r, team: "present" as const, gap: undefined } : r));
  expect(ratchetViolations(MATRIX, moved)).toEqual([]);
  expect(ratchetViolations(MATRIX, MATRIX.filter((r) => r.section !== "审查"))).toEqual(["审查: removed"]);
  expect(ratchetViolations(MATRIX, MATRIX.map((r) => (r.section === "审查" ? { ...r, team: "absent" as const } : r)))).toEqual(["审查: team home_only→absent"]);
  expect(ratchetViolations(MATRIX, MATRIX.map((r) => (r.section === "阶段用时" ? { ...r, local: "absent" as const } : r)))).toEqual(["阶段用时: local present→absent"]);
  // A 类（§3 一致项）两边都必须 present
  for (const r of MATRIX.filter((x) => x.cls === "A")) expect([r.section, r.local, r.team]).toEqual([r.section, "present", "present"]);
});
