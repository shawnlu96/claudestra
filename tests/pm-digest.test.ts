import { expect, test } from "bun:test";
import { classifyPmPush, digestText, type DigestEntry, type DigestInput } from "../src/lib/pm-digest.js";

const agent = (sender: string, body: string, oneShot = true): DigestInput =>
  ({ fromKind: "local", sender, intent: "request", triggerKind: "agent_tool", oneShot, body });
const bridge = (label: string, body: string): DigestInput =>
  ({ fromKind: "bridge", sender: label, intent: "notification", triggerKind: "bridge_synth", oneShot: false, body });

test("mergeable: scheduler post-verify reminder, audit new findings, agent pure status sync", () => {
  const pv = classifyPmPush(agent("scheduler", "[上线后待办] agents-X1 已上线，规格要求 PM 接着做：\n- 跑 observe"));
  expect(pv).toMatchObject({ send: "digest", kind: "post-verify", source: "scheduler", card: "agents-X1" });
  const overdue = classifyPmPush(agent("scheduler", "[上线后待办] agents-X1 上线后 PM 步骤 72 小时未结，之后不再提醒"));
  expect(overdue).toMatchObject({ send: "digest", card: "agents-X1" });
  const audit = classifyPmPush(bridge("ledger-audit", "[🔎 台账巡检] 新发现 2 条可能漏了的事（只报新出现的）：\n1. T1 · 等额度"));
  expect(audit).toMatchObject({ send: "digest", kind: "audit", source: "ledger-audit" });
  const sync = classifyPmPush(agent("agent-worker", "agents-PMDIG1 进度：分类函数写完，在补测试"));
  expect(sync).toMatchObject({ send: "digest", kind: "sync", source: "agent-worker", card: "agents-PMDIG1" });
  const declared = classifyPmPush(agent("agent-worker", "【只同步】今天跑完了 observe 统计", false));
  expect(declared).toMatchObject({ send: "digest", kind: "sync", reason: "agent 写明只同步" });
});

test("immediate: owner, card answers, executor question / delivery, merge / deploy failure, freeze, incidents, asks for PM", () => {
  const now: [string, DigestInput][] = [
    ["owner discord", { fromKind: "user", intent: "request", triggerKind: "user_discord", oneShot: false, body: "进度？" }],
    ["owner api", { fromKind: "api", sender: "owner", intent: "request", triggerKind: "agent_tool", oneShot: false, body: "看下" }],
    ["peer", { fromKind: "api", sender: "remote", intent: "request", triggerKind: "agent_tool", oneShot: false, body: "只同步：好了" }],
    ["card answer", { fromKind: "local", sender: "agent-x", intent: "request", triggerKind: "ask_answer", oneShot: true, body: "选 1" }],
    ["executor question", bridge("ledger", "【执行者提问】T1 · 单号 o1 · 来自 agent-task-1")],
    ["ledger delivery", bridge("ledger", "[台账] T1 已交付 PR #12")],
    ["scheduler other", agent("scheduler", "[调度引擎] T1 退回人工，请接手：合并失败")],
    ["scheduler freeze", agent("scheduler", "[合并队列] 冻结队列：main 红")],
    ["agent delivery", agent("agent-task-1", "T1 已交付，PR #33")],
    ["merge failure", agent("agent-task-1", "合并失败：冲突")],
    ["deploy failure", agent("agent-ops", "部署失败，回滚中")],
    ["incident", agent("agent-ops", "生产事故告警：5xx 飙升")],
    ["asks PM", agent("agent-peerpm", "这个要你拍板吗？")],
    ["request expecting reply", agent("agent-task-1", "进度更新", false)],
    ["master", agent("master", "大总管通知")],
    ["unknown bridge", bridge("quota-wall", "额度")],
    ["audit without header", bridge("ledger-audit", "其他巡检格式")],
  ];
  for (const [name, input] of now) expect([name, classifyPmPush(input).send]).toEqual([name, "now"]);
});

test("urgent words anywhere in the body (not just the first line) go out immediately", () => {
  for (const body of ["agents-X1 进度更新\n部署失败,需要你拍板?", "agents-X1 进度\n顺便：T1 已交付 PR #9", "进度同步\n\n合并失败：冲突", "只同步\n有个问题想问你"])
    expect([body, classifyPmPush(agent("agent-ops", body)).send]).toEqual([body, "now"]);
  expect(classifyPmPush(agent("agent-ops", "【只同步】进度\n部署失败", false)).send).toBe("now");
});

test("the bridge's own digest envelope is always immediate (never re-queued)", () => {
  expect(classifyPmPush(bridge("pm-digest", "")).send).toBe("now");
  expect(classifyPmPush({ ...bridge("pm-digest", "[📨 PM 摘要] 1 条"), oneShot: true }).send).toBe("now");
});

test("uncertain samples go out immediately", () => {
  expect(classifyPmPush(agent("agent-x", "请看一下这个")).send).toBe("now"); // 像在要人动手
  expect(classifyPmPush(agent("agent-x", "卡住了")).send).toBe("now");
  expect(classifyPmPush(agent("", "", false)).send).toBe("now");
  expect(classifyPmPush({ ...agent("agent-x", "进度"), fromKind: "user" }).send).toBe("now");
});

test("digest lines: source · card · first line, repeats of the same card and source merged with a count", () => {
  const e = (id: string, source: string, firstLine: string, card?: string): DigestEntry =>
    ({ id, project: "p", kind: "sync", source, firstLine, at: 0, ...(card ? { card } : {}) });
  const text = digestText([
    e("1", "scheduler", "[上线后待办] T1 已上线", "T1"), e("2", "ledger-audit", "[🔎 台账巡检] 新发现 1 条"),
    e("3", "scheduler", "[上线后待办] T1 已上线", "T1"), e("4", "scheduler", "[上线后待办] T2 已上线", "T2"),
    e("5", "agent-w", "x".repeat(300)),
  ]);
  const lines = text.split("\n");
  expect(lines[0]).toContain("5 条");
  expect(lines[1]).toBe("1. scheduler · T1 · [上线后待办] T1 已上线（×2）");
  expect(lines[2]).toBe("2. ledger-audit · [🔎 台账巡检] 新发现 1 条");
  expect(lines[3]).toBe("3. scheduler · T2 · [上线后待办] T2 已上线");
  expect(lines[4]!.length).toBeLessThan(140);
  expect(lines).toHaveLength(5);
});

test("classifier-body: a sender waiting for a reply with a request below a「只同步」header goes out immediately", () => {
  expect(classifyPmPush(agent("agent-ops", "只同步:agents-X1 进度\n请给出下一步方案", false)).send).toBe("now");
  // 等回复的消息：首行以下还有内容，摘要只留首行会把它截掉，拿不准就立即送
  expect(classifyPmPush(agent("agent-ops", "【只同步】agents-X1 进度\n附：明天继续", false)).send).toBe("now");
  // oneShot 正文里的请求措辞同样不进摘要
  expect(classifyPmPush(agent("agent-ops", "agents-X1 进度\n下一步方案怎么定，给个意见")).send).toBe("now");
});
