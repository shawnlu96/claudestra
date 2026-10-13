import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { deliverPmLocal } from "../src/bridge/local-api/project-pm-delivery.js";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { pmDigest } from "../src/bridge/pm-digest.js";
import { PmDigestStore } from "../src/lib/pm-digest-store.js";
import { classifyPmPush, PM_DIGEST_WINDOW_MS } from "../src/lib/pm-digest.js";
import { pmDigestStats } from "../src/manager/pm-digest-cmds.js";
import { auditNoticeText } from "../src/lib/ledger-audit.js";
import { trainSlots } from "../src/lib/ledger-audit-train.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import type { Delivery, Envelope, LocalEndpoint } from "../src/bridge/router.js";
import { A, B, P, pmFixture } from "./pm-role-fixture.test.js";

const fixtures: ReturnType<typeof pmFixture>[] = [], defaults = { ...pmDigest.deps };
afterEach(() => { pmDigest.stop(); Object.assign(pmDigest.deps, defaults); for (const f of fixtures.splice(0)) f.close(); });
const ws = { send: () => {} } as unknown as LocalEndpoint["ws"];
const target: LocalEndpoint = { kind: "local", agentName: A, channelId: "channel-a", ws };
const scheduler: Envelope["from"] = { kind: "local", agentName: "scheduler", channelId: "scheduler", ws };
const audit: Envelope["from"] = { kind: "bridge", label: "ledger-audit" };
let seq = 0;
function envelope(from: Envelope["from"], content: string, id = `route-${++seq}`): Envelope {
  return { from, to: target, content, intent: "notification", meta: {
    messageId: id, threadId: "route-thread", ts: "2026-10-10T00:00:00Z", triggerKind: "agent_tool", skipInterAgentWatchdog: true,
  } };
}
async function world(routeMode: "on" | "observe" | "off", digestMode: "on" | "observe" | "off" = "on", redirect = false, movingClock = false) {
  const f = pmFixture(); fixtures.push(f);
  if (redirect) await switchProjectPm(f.db, P, B, { actor: "owner" }, f.deps);
  const store = new PmDigestStore(join(f.dir, "pm-digest.json"), join(f.dir, "pm-digest-mode.json"));
  writeFileSync(store.modePath, JSON.stringify({ projects: { [P]: digestMode }, routeProjects: { [P]: routeMode } }));
  const state = await f.deps.read(), clients = new Map([["channel-a", { ws }], ["channel-b", { ws }]]);
  let clock = 1_000_000;
  Object.assign(pmDigest.deps, { store, db: () => f.db, now: () => movingClock ? clock++ : clock, agents: () => state.agents, heldCarriers: () => new Set() });
  const sent: { to: string | undefined; content: string; meta: Envelope["meta"] }[] = [];
  const send = async (e: Envelope, to: LocalEndpoint): Promise<Delivery> => {
    sent.push({ to: to.agentName, content: e.content, meta: { ...e.meta } }); return { envelope: e, outcome: { kind: "sent" } };
  };
  const book = new AgentCallBook(null), receipts = new Map();
  const deliver = (e: Envelope) => deliverPmLocal(e, e.to as LocalEndpoint, clients, book, receipts, send, { db: f.db, agents: state.agents });
  pmDigest.start({ clients, deliver }, false);
  return { f, store, sent, deliver, advance: (n: number) => { clock += n; } };
}
const train = (text: string) => `[合并列车] 第 3 辆车 3-abc12：${text}`;
const queued = "（排队中：列车在合 agents-T2，await_ci）";
const finding = (taskId: string | null, detail: string, suggestion: string) => ({ project: P, taskId, detail, suggestion });
const ship = finding("agents-T1", `agents-T1 在 merge 已 31 分钟没推进${queued}`, "补做合并部署，做完推阶段");
const ready = finding("agents-T2", "agents-T2 在 merge，审查 #3 已 PASS、当前 head abcdef012345 CI 全绿，已 31 分钟没动；"
  + "实际阻塞：排队中：列车在合 agents-T3，await_ci；mainCarry=observe", "列车排队中，等列车轮到它；列车本身停滞看 ship_stalled");
const orphan = (note: string) => finding(null, `agent-worker 属于本项目，台账里没有它的任务${note}`, "补建任务或回收执行者");
const notice = (...items: ReturnType<typeof finding>[]) => auditNoticeText(items, "bun /synthetic/manager.ts ledger audit --dry-run");

const cases: [Envelope["from"], string][] = [
  [scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345")],
  [scheduler, train("结束（merged）：合并 agents-T1，退回 （无），串行 （无），CI 2 次")],
  [scheduler, train("作废：组合红，已由代码二分退回；已合并 （无），其余回去重新组车")],
  [audit, notice(ship)], [audit, notice(ready)],
  [audit, notice(orphan("（出借在途：peer 单 lend:agents-T1:s1:r0:a0，对方最近活动 2 分钟前）"))],
  [audit, notice(orphan("（复述会话：agents-T1 出借在途）"))],
];

// [验收线 1]
test("on records routine trusted train and precisely annotated audit items without delivery or digest", async () => {
  const w = await world("on");
  for (const [from, content] of cases) await w.deliver(envelope(from, content));
  await w.deliver(envelope(audit, notice(ship, ready, orphan("（复述会话：agents-T1 出借在途）"))));
  expect(w.sent).toEqual([]);
  expect(w.store.queued(P)).toEqual([]);
  expect(w.store.read().log).toHaveLength(cases.length + 1);
});

// [验收线 2]
test("mixed audit retains failure in full, removes auto rows and rebuilds numbering and count", async () => {
  const w = await world("on");
  const fault = finding("agents-T3", "agents-T3 合并结果不明：收据未知\n故障详情请核对", "核对 PR，失败后再重派");
  // Existing wire rows are single-line; a malformed multiline finding must keep the original whole envelope.
  const malformed = notice(ship, ready, fault), bad = envelope(audit, malformed);
  await w.deliver(bad);
  await w.deliver(envelope(scheduler, "立即送：交付"));
  expect(w.sent.at(-1)!.content).toContain("故障详情请核对");
  const fullFault = "agents-T3 合并结果不明：收据未知，故障详情请核对";
  await w.deliver(envelope(audit, notice(ship, ready, finding("agents-T3", fullFault, "核对 PR，失败后再重派"))));
  expect(w.sent.at(-1)!.content).toContain("新发现 1 条");
  expect(w.sent.at(-1)!.content).toContain(`1. agents-T3 · 核对 PR，失败后再重派 — ${fullFault}`);
  expect(w.sent.at(-1)!.content).not.toContain(ship.detail);
  expect(w.sent.at(-1)!.content).not.toContain(ready.detail);
});

// [验收线 1]
test("owner and ordinary agents cannot acquire auto routing by repeating trusted wire text", async () => {
  const w = await world("on");
  for (const [, body] of cases) {
    for (const from of [{ kind: "user", userId: "owner", channelId: "channel-a" } as const,
      { kind: "local", agentName: "agent-worker-1", channelId: "worker", ws } as const]) {
      const e = envelope(from, body), before = w.sent.length;
      await w.deliver(e);
      expect(w.store.read().log.at(-1)!.route!.tags.some((t) => t.route === "auto")).toBe(false);
      expect(w.sent.length > before || w.store.queued(P).some((q) => q.id === e.meta.messageId)).toBe(true);
    }
  }
});

// [验收线 3]
test("questions, deliveries, freeze, unknown, cancelled orders, alarm and PM release always reach PM", async () => {
  const w = await world("on");
  for (const text of ["问题怎么处理？", "交付 PR #2", "队列冻结", "出借单结果不明", "worker 已停，撤单重派", "请回应",
    train("hold：需要 PM 放行"), train("作废：组合红，alarm 未知；已合并 （无），其余回去重新组车"),
    train("作废：车厢 3-abc12 CI 超时；已合并 （无），其余回去重新组车")]) {
    const before = w.sent.length;
    await w.deliver(envelope(scheduler, text));
    expect(w.sent).toHaveLength(before + 1);
    expect(w.sent.at(-1)!.content).toBe(text);
  }
  const answer = envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345"));
  answer.meta.triggerKind = "ask_answer";
  await w.deliver(answer);
  expect(w.sent.at(-1)!.content).toBe(answer.content);
});

// [验收线 3]
test("exact hold and bisect use digest; own window digest is delivered only once and never reclassified", async () => {
  const w = await world("on");
  for (const text of ["agents-T1 等第 3 辆列车 3-abc12 结束（拼车 / 跑 CI）再申请合并槽，不 update-branch、不合并",
    "第 1 层二分：[agents-T1] / [agents-T2]", "车厢 3-abc12a（agents-T1）CI 红：tests；tests failed：断言失败"]) {
    await w.deliver(envelope(scheduler, train(text)));
  }
  expect(w.sent).toEqual([]);
  expect(w.store.queued(P)).toHaveLength(3);
  const records = w.store.read().log.length;
  w.advance(PM_DIGEST_WINDOW_MS);
  await pmDigest.tick(); await pmDigest.tick();
  expect(w.sent).toHaveLength(1);
  expect(w.store.read().log).toHaveLength(records);
  expect(w.store.queued(P)).toEqual([]);
});

// [验收线 4]
test("off and observe preserve bytes, order, queues and window across every existing PMDIG mode", async () => {
  for (const digestMode of ["off", "observe", "on"] as const) {
    const results: unknown[] = [];
    for (const mode of ["off", "observe"] as const) {
      const w = await world(mode, digestMode, false, digestMode !== "off");
      const inputs = [envelope(audit, notice(ship), "audit-compat"),
        envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345"), "train-compat"),
        envelope(scheduler, "[上线后待办] agents-T1 已上线", "sync-compat")];
      const outcomes = [];
      for (const e of inputs) {
        const before = JSON.stringify(e.meta);
        outcomes.push((await w.deliver(e)).outcome);
        expect(JSON.stringify(e.meta)).toBe(before);
      }
      const queue = w.store.read().queue;
      w.advance(PM_DIGEST_WINDOW_MS - 1); await pmDigest.tick();
      const beforeWindow = JSON.stringify(w.sent.map(({ to, content }) => ({ to, content })));
      w.advance(1); await pmDigest.tick();
      results.push({ queue, sent: w.sent.map(({ to, content }) => ({ to, content })), beforeWindow, outcomes });
      if (mode === "off") expect(w.store.read().log.some((r) => r.route)).toBe(false);
      else expect(w.store.read().log.filter((r) => r.route)).toHaveLength(inputs.length);
    }
    expect(results[1]).toEqual(results[0]);
  }
});

// [验收线 4]
test("missing routeMode observes without suppressing, while legacy PMDIG off retains empty log", async () => {
  for (const digestMode of ["off", "on"] as const) {
    const w = await world("on", digestMode);
    writeFileSync(w.store.modePath, JSON.stringify({ projects: { [P]: digestMode } }));
    await w.deliver(envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345")));
    expect(w.sent).toHaveLength(1);
    expect(w.store.read().log).toHaveLength(digestMode === "off" ? 0 : 1);
  }
});

// [验收线 4]
test("non PM stays unchanged; redirect classifies against the final active PM and keeps mixed transfer header", async () => {
  const w = await world("on", "on", true);
  const ordinary = envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345"));
  ordinary.to = { ...target, agentName: "agent-worker-1", channelId: "channel-worker", ws: { send: () => {} } as unknown as LocalEndpoint["ws"] };
  const before = JSON.stringify(ordinary);
  await w.deliver(ordinary);
  expect(JSON.stringify(ordinary)).toBe(before);
  expect(w.store.read().log).toEqual([]);
  await w.deliver(envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345")));
  expect(w.sent).toHaveLength(1);
  await w.deliver(envelope(audit, notice(ship, finding("agents-T3", "合并结果不明，故障全文", "请核对"))));
  expect(w.sent.at(-1)!.to).toBe(B);
  expect(w.sent.at(-1)!.content).toContain(`原收件人 ${A}；当班 PM ${B}`);
  expect(w.sent.at(-1)!.content).toContain("新发现 1 条");
  expect(w.sent.at(-1)!.content).toContain("合并结果不明，故障全文");
  expect(w.sent.at(-1)!.content).not.toContain(ship.detail);
});

// [验收线 5]
test("repeat messageId counts once after restart; tags carry no body and old queue is retained", async () => {
  const w = await world("on");
  const body = train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345");
  await w.deliver(envelope(scheduler, "[上线后待办] agents-OLD 已上线", "old-queue"));
  await w.deliver(envelope(scheduler, body, "duplicate"));
  Object.assign(pmDigest.deps, { store: new PmDigestStore(w.store.path, w.store.modePath) });
  await w.deliver(envelope(scheduler, body, "duplicate"));
  const rows = w.store.read().log.filter((r) => r.route?.messageId === "duplicate");
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0]!.route)).not.toContain("agents-T1");
  expect(w.store.queued(P).map((e) => e.id)).toEqual(["old-queue"]);
  const stats = pmDigestStats(w.store, P, 1_000_000);
  expect(stats.route.auto).toBe(1); expect(stats.route.digest).toBe(1);
  expect(JSON.stringify(stats)).not.toContain(body);
});

// [验收线 5]
test("record failure sends original whole audit and train rather than suppressing them", async () => {
  for (const [from, body] of [[scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345")],
    [audit, notice(ship, finding("agents-T3", "结果不明：原故障全文", "请核对"))]] as const) {
    const w = await world("on");
    writeFileSync(w.store.path, "{broken");
    await w.deliver(envelope(from, body));
    expect(w.sent.at(-1)!.content).toBe(body);
    expect(readFileSync(w.store.path, "utf8")).toBe("{broken");
  }
});

// [验收线 2]
test("bad audit format preserves the complete envelope through the actual old delivery choice", async () => {
  for (const digestMode of ["off", "observe"] as const) {
    const w = await world("on", digestMode), body = notice(ship).replace("新发现 1 条", "新发现 9 条");
    const e = envelope(audit, body), original = JSON.stringify(e);
    await w.deliver(e);
    expect(JSON.stringify(e)).toBe(original);
    expect(w.sent.at(-1)!.content).toBe(body);
    expect(w.store.queued(P)).toEqual([]);
  }
});

// [验收线 1]
test("all merge-run queue phases from the real annotation helper suppress both audit types", async () => {
  const w = await world("on");
  for (const phase of ["ready", "updating", "await_review", "await_ci", "merging"]) {
    const slot = trainSlots({ project: P, mergeTrain: {
      active: [{ taskId: "agents-HOLDER", phase, createdAt: 0 }], freedAt: null,
    }, trainFacts: { holder: { taskId: "agents-HOLDER", intentId: "i-holder", phase, merged: false },
      cards: { "agents-T1": { stage: "merge", merged: false, phase: null } } } }, () => ({ mode: "observe", manualAfterMs: null, source: "config" }))({ id: "agents-T1", stage: "merge" });
    const shipRow = { ...ship, detail: ship.detail.replace(queued, slot.note) };
    const readyRow = { ...ready, detail: ready.detail.replace("排队中：列车在合 agents-T3，await_ci", slot.note.slice(1, -1)) };
    await w.deliver(envelope(audit, notice(shipRow, readyRow)));
  }
  expect(w.sent).toEqual([]);
  expect(w.store.queued(P)).toEqual([]);
  expect(pmDigestStats(w.store, P, 1_000_000).route.auto).toBe(10);
});

// [验收线 1]
test("without real merge-slot facts the annotation helper stays off and adds no queue note", () => {
  const slot = trainSlots({ project: P, mergeTrain: {
    active: [{ taskId: "agents-HOLDER", phase: "await_ci", createdAt: 0 }], freedAt: null,
  } }, () => ({ mode: "observe", manualAfterMs: null, source: "config" }))({ id: "agents-T1", stage: "merge" });
  expect(slot).toEqual({ parked: false, freedAt: null, note: "" });
});

// [验收线 4]
test("nonqueued ready facts preserve the old digest choice; real blockers remain immediately visible", async () => {
  const w = await world("on");
  const plain = { ...ready, suggestion: "走正式合并入口（preflight 核台账合并门 / 最终 head / main / CI 后钉 head 合并）",
    detail: ready.detail.replace("排队中：列车在合 agents-T3，await_ci", "台账合并门全过（台账外的测量输入等不可核实）") };
  const body = notice(plain);
  await w.deliver(envelope(audit, body));
  expect(w.sent).toEqual([]);
  expect(w.store.queued(P)).toHaveLength(1);
  const baseline = classifyPmPush({ fromKind: "bridge", sender: "ledger-audit", intent: "notification",
    triggerKind: "agent_tool", oneShot: true, body });
  expect(baseline.send).toBe("digest");
  if (baseline.send === "digest") expect(w.store.queued(P)[0]!.detail).toEqual(baseline.detail);
  expect(w.store.read().log[0]!.route!.tags[0]).toMatchObject({ route: "judge", rule: "audit.unknown" });
  for (const blocker of ["合并队列冻结", "合并 journal 结果不明", "CI 失败", "真实阻塞：依赖未上线", "请 PM 核对"]) {
    const fault = { ...plain, detail: plain.detail.replace("台账合并门全过（台账外的测量输入等不可核实）", blocker) };
    await w.deliver(envelope(audit, notice(fault)));
    expect(w.sent.at(-1)!.content).toContain(fault.detail);
  }
});

// [验收线 5]
test("protected deliveries count in PMDIG now and source totals while auto stays route-only", async () => {
  const w = await world("on");
  const inputs = [envelope({ kind: "user", userId: "owner", channelId: "channel-a" }, "人类对话"),
    envelope(scheduler, "卡片答复"), envelope(scheduler, "交付 PR #2"),
    envelope(audit, notice(finding("agents-T3", "结果不明，故障全文", "请核对")))];
  inputs[1]!.meta.triggerKind = "ask_answer";
  for (const e of inputs) await w.deliver(e);
  await w.deliver(envelope(scheduler, train("组车 2 张：agents-T1、agents-T2，起点 main abcdef012345")));
  const stats = pmDigestStats(w.store, P, 1_000_000);
  expect(w.sent).toHaveLength(4);
  expect(stats.now).toBe(4);
  expect(stats.bySource.now).toEqual({ user: 1, scheduler: 2, "ledger-audit": 1 });
  expect(Object.entries(stats.byReason).filter(([k]) => k.startsWith("now:")).reduce((n, [, v]) => n + v, 0)).toBe(4);
  expect(stats.route).toMatchObject({ auto: 1, digest: 0, judge: 3, owner: 1 });
  expect(w.store.read().log.at(-1)!.routeOnly).toBe(true);
});
