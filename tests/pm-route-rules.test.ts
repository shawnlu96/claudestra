import { expect, test } from "bun:test";
import { classifyPmRoute } from "../src/lib/pm-route.js";
import { auditNoticeText } from "../src/lib/ledger-audit.js";
import type { DigestInput } from "../src/lib/pm-digest.js";

const train = (body: string): DigestInput => ({ fromKind: "local", sender: "scheduler", intent: "notification",
  oneShot: true, triggerKind: "agent_tool", body: `[合并列车] 第 1 辆车 1-abc12：${body}` });
const audit = (body: string): DigestInput => ({ fromKind: "bridge", sender: "ledger-audit", intent: "notification",
  oneShot: true, triggerKind: "bridge_synth", body });
const queued = "（排队中：列车在合 agents-T2，testing）";
const ship = { project: "p", taskId: "agents-T1", suggestion: "补做合并部署，做完推阶段", detail: `agents-T1 在 merge 已 30 分钟没推进${queued}` };
const notice = (detail = ship.detail) => auditNoticeText([{ ...ship, detail }], "ledger audit --dry-run");

// [验收线 1]
test("exact wire infers audit types; declared rule must agree with the complete detail and suggestion", () => {
  for (const body of [notice(), notice().replace("1. agents-T1", "1. [ship_stalled] agents-T1")]) {
    expect(classifyPmRoute(audit(body)).tags).toEqual([{ route: "auto", rule: "audit.ship-queued",
      reason: "合并停滞是列车排队事实", item: 1, type: "ship_stalled" }]);
  }
  const mismatched = notice().replace("1. agents-T1", "1. [orphan_executor] agents-T1");
  expect(classifyPmRoute(audit(mismatched)).tags[0]!.route).toBe("judge");
  for (const detail of [ship.detail + "，附加要求", ship.detail.replace("agents-T1", "agents-OTHER"),
    ship.detail.replace("merge 已", "live 已"), ship.detail.replace("排队中：列车在合", "排队中：")]) {
    expect(classifyPmRoute(audit(notice(detail))).tags[0]!.route).toBe("judge");
  }
});

// [验收线 1]
test("train shape alone is insufficient: source, request semantics and exact template must agree", () => {
  const m = train("组车 2 张：agents-T1、agents-T2，起点 main abcdef01");
  expect(classifyPmRoute(m).tags[0]!.route).toBe("auto");
  for (const changed of [{ ...m, sender: "agent-worker" }, { ...m, fromKind: "bridge" as const },
    { ...m, fromKind: "user" as const }, { ...m, fromKind: "api" as const }, { ...m, oneShot: false },
    { ...m, intent: "response" }, { ...m, triggerKind: "user_discord" }, { ...m, triggerKind: "peer_http" }, { ...m, triggerKind: "ask_answer" }]) {
    expect(classifyPmRoute(changed).tags.some((t) => t.route === "auto")).toBe(false);
  }
  for (const text of ["组车 2 张：agents-T1，起点 main abcdef01", "组车 1 张：agents-T1，起点 main abcdef01"]) {
    expect(classifyPmRoute(train(text)).tags[0]!.route).toBe("judge");
  }
  expect(classifyPmRoute({ ...m, body: m.body + "\n要 PM 回复" }).tags[0]!.route).toBe("judge");
});

// [验收线 2]
test("parser rejects missing tail, extra lines, wrong counts, duplicated ordinals and unknown layouts wholesale", () => {
  const full = notice();
  for (const body of [full.replace("新发现 1 条", "新发现 2 条"), full.replace("1. agents", "2. agents"),
    full.split("\n").slice(0, -1).join("\n"), full + "\nextra", full.replace(" · ", " : "),
    full.replace(" — ", " -> ")]) {
    const plan = classifyPmRoute(audit(body));
    expect(plan.tags[0]).toMatchObject({ route: "judge", rule: "audit.unparsed" });
    expect(plan.body).toBeUndefined();
  }
});

// [验收线 3]
test("queue annotations never override freeze, unknown merge results or unverified blockers", () => {
  const f = { ...ship, suggestion: "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled",
    detail: "agents-T1 在 merge，审查 #4 已 PASS、当前 head abcdef012345 CI 全绿，已 30 分钟没动；"
      + "实际阻塞：排队中：列车在合 agents-T2，testing；mainCarry=observe" };
  expect(classifyPmRoute(audit(auditNoticeText([f], "ledger audit --dry-run"))).tags[0]!.route).toBe("auto");
  for (const blocker of ["合并队列冻结", "合并 journal 结果不明", "owner hold", "台账合并门读取失败，不可核实", "依赖未上线：agents-T3"]) {
    const detail = f.detail.replace("；mainCarry", `；${blocker}；mainCarry`);
    expect(classifyPmRoute(audit(auditNoticeText([{ ...f, detail }], "ledger audit --dry-run"))).tags[0]!.route).toBe("judge");
  }
});

// [验收线 3]
test("only confirmed automatic red void is auto; unresolved void, timeout, alarms and release are judge", () => {
  for (const reason of ["组合红，已由代码二分退回", "组合红，已退回"]) {
    expect(classifyPmRoute(train(`作废：${reason}；已合并 （无），其余回去重新组车`)).tags[0]!.route).toBe("auto");
  }
  for (const reason of ["组合红", "main 已前进", "CI 超时", "组合红，alarm 未知", "需要 PM 放行", "列车超过总时限"]) {
    expect(classifyPmRoute(train(`作废：${reason}；已合并 （无），其余回去重新组车`)).tags[0]!.route).toBe("judge");
  }
  const body = train("结束（merged）：合并 agents-T1，退回 （无），串行 （无），CI 2 次");
  expect(classifyPmRoute({ ...body, body: body.body + "，结果不明" }).immediate).toBe(true);
  expect(classifyPmRoute({ ...body, body: body.body + "，需 owner 决策" }).tags[0]!.route).toBe("owner");
});

// [验收线 5]
test("classification tags for filtered items contain index, type and reason but no raw body", () => {
  const plan = classifyPmRoute(audit(notice()));
  expect(JSON.stringify(plan.tags)).not.toContain(ship.detail);
  expect(JSON.stringify(plan.tags)).not.toContain(ship.taskId);
  expect(plan.body).toBe("");
});

// [验收线 3]
test("approved CI red progress can contain failed logs, while accompanying action or alarms remain protected", () => {
  const progress = train("车厢 1-abc12a（agents-T1）CI 红：tests；tests failed：断言失败");
  expect(classifyPmRoute(progress).tags[0]!.route).toBe("digest");
  for (const suffix of ["；结果不明", "；alarm 未知", "；请 PM 决定", "；冻结"]) {
    expect(classifyPmRoute({ ...progress, body: progress.body + suffix }).tags[0]!.route).toBe("judge");
    expect(classifyPmRoute({ ...progress, body: progress.body + suffix }).immediate).toBe(true);
  }
  expect(classifyPmRoute(train("第 1 层二分：未知布局")).tags[0]!.route).toBe("judge");
});
