/**
 * team-parity-C 的纯逻辑部分（常跑，不开浏览器）：
 * ① 本机夹具是全量的（审查 pass / changes / block 各一、事件 data 完整、DAG 有两版）；
 * ② 团队一侧只经生产导出 → 真中心导入 → 真投影器 → 中心读口得到（web-team-parity-browser-center.test.ts），没有规则副本；
 * ③ 旧「本机由团队模型生成」的喂法让 T3 / T5 / T7 的消费者全空，本机数据下都有内容（数据层旧红新绿）；
 * ④ 矩阵比对器的受控变异：缺口修好 → stale_gap，退回 → fail，期望只能往 present 走。
 * 浏览器对照见 tests/web-team-parity-browser.test.ts（opt-in）。
 */
import { expect, test } from "bun:test";
import { generateHomeFixture } from "@/features/collab/shared/home-fixture-gen";
import { teamFromHome } from "./web-team-parity-browser-center.test";
import { teamOverview, teamTaskDetail } from "@/features/collab/team-source-adapter";
import { recentThree, reviewRows, stageSegments } from "@/features/collab/collab-detail-model";
import { compareMatrix, MATRIX, ratchetViolations, unprobed, type Observed } from "./helpers/team-parity-matrix";

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

test("team side comes from the production export → center import → mirror projector → center reads", async () => {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  expect(team.details.map((d) => team.localFeature[d.feature.id]).sort()).toEqual(home.features.map((f) => f.id).sort());
  const tasks = team.details.flatMap((d) => d.tasks), by = (id: string) => tasks.find((t) => t.sourceTaskId === id)!;
  expect(tasks.map((t) => t.sourceTaskId).sort()).toEqual(home.overview.tasks.map((t) => t.id).sort());
  for (const t of home.overview.tasks) expect([t.id, by(t.id).stage]).toEqual([t.id, t.stage]);
  // 生产规则在起作用（不是这里写的）：URL PR → null、未知提交的 head → null、permission 来源的提问被滤、成员只有代号
  expect(by("i28-A3").pr).toBeNull();
  expect(by("i28-A1").head).toBe(home.rows["i28-A1"]!.headSHA);
  expect(by("i28-A4").head).toBeNull();
  expect(by("i28-A7").asks).toEqual([{ kind: "decide", state: "open", blocking: true }]);
  expect(by("i28-A1").assigneeCode).toBe(home.rows["i28-A1"]!.meta.assigneeCode);
  expect(JSON.stringify(team)).not.toContain("agent-dev");
  // 中心 refreshFeatureState 的 counts：只算显式 done / verified；没开卡的计划节点进 total 不进 missing
  const a = team.details.find((d) => team.localFeature[d.feature.id] === "feat-a")!;
  expect(a.feature.counts).toEqual({ total: 8, completed: 2, blocked: 0, missing: 0 });
  expect(a.feature.status).toBe("active");
  expect(a.dag.version).toBe(2);
  expect(a.feature.projection?.sourceInstanceId).toBe(home.sourceInstanceId);
});

test("team side is derived from the same home data: titles, stages, deps and bindings line up", async () => {
  const home = generateHomeFixture(), team = await teamFromHome(home);
  const ov = teamOverview(team.list, new Map(team.details.map((d) => [d.feature.id, d])), home.now).ov;
  for (const t of home.overview.tasks) {
    const v = ov.tasks.find((x) => x.id === t.id)!;
    expect({ id: v.id, title: v.title, stage: v.stage }).toEqual({ id: t.id, title: t.title, stage: t.stage });
  }
  // 没开卡的计划节点只在团队这边以 spec 出现（中心只有规划）
  expect(ov.tasks.filter((t) => !home.details[t.id]).map((t) => t.stage)).toEqual(["spec", "spec"]);
  expect(ov.deps!.map((d) => `${d.from}>${d.to}`).filter((e) => home.overview.deps!.some((x) => `${x.from}>${x.to}` === e)).length)
    .toBe(home.overview.deps!.length);
  expect(JSON.stringify(team)).not.toContain("agent-dev");
});

test("old red / new green at the data layer: team-model-fed local detail empties T3/T5/T7 consumers", async () => {
  const home = generateHomeFixture(), team = await teamFromHome(home);
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

test("matrix baseline covers every §3 row; added rows really take part; unlisted and unprobed sections are reported", () => {
  const refs = new Set(MATRIX.map((r) => r.ref)), want = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
  expect([...want("G", 12), ...want("T", 14), ...want("E", 3), ...want("M", 9), ...want("W", 4), ...want("N", 5)].filter((r) => !refs.has(r))).toEqual([]);
  // r0 审查探针的反面：改新增行的实测，报告必须跟着变（之前这些区块不在表里，报告逐字不变）
  const team: Observed = Object.fromEntries(MATRIX.map((r) => [r.section, r.gap?.team ?? r.team]));
  const base = JSON.stringify(compareMatrix("team", team));
  for (const sec of ["阻塞提问", "PR", "规格全文", "依赖边·建立者/时间", "节点处理人/步骤", "head", "版本元数据（提出人/时间）", "产品卡·进行中计数", "镜像新鲜度", "进度条 counts"]) {
    const flipped = compareMatrix("team", { ...team, [sec]: team[sec] === "absent" ? "unknown" : "absent" });
    expect([sec, JSON.stringify(flipped) === base]).toEqual([sec, false]);
    // 翻成别的值：要么是回归（fail），要么正好命中修好后的期望（stale_gap，逼着删 gap）；不能还是 pass / known_gap
    expect([sec, ["fail", "stale_gap"].includes(flipped.find((r) => r.section === sec)!.verdict)]).toEqual([sec, true]);
  }
  // 检测器报了表外区块 → unlisted；没写 limit 的行哪个场景都没测到 → unprobed 列出来
  expect(compareMatrix("team", { ...team, "表外区块": "present" }).filter((r) => r.verdict === "unlisted").map((r) => r.section)).toEqual(["表外区块"]);
  expect(unprobed([team])).toEqual([]);
  const { "阻塞提问": _drop, ...missing } = team;
  expect(unprobed([missing, { ...missing, "阻塞提问": "not_run" }])).toEqual(["阻塞提问"]);
  // 写了 limit 的行允许 not_run，且结果带上原因
  const g7 = compareMatrix("team", missing).find((r) => r.section === "历史版本快照")!;
  expect(g7.verdict === "not_run" || g7.verdict === "pass").toBe(true);
  expect(MATRIX.filter((r) => r.limit).every((r) => r.limit!.length >= 8)).toBe(true);
});
