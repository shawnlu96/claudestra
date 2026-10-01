/** i28-M4b：唤醒派单 + 领单留痕 + 未领单报警 + ACP 回合失败交 PM。每个 describe 对应规格验收线的一条 P1。 */
import { describe, expect, test } from "bun:test";
import { openAsk } from "../src/lib/ledger-asks.js";
import { getWorkflow, type IntentStatus, type SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import { getEventByDedup, listEvents } from "../src/lib/ledger-store.js";
import { markingTakes, recordTaken, takenKey, UNCLAIMED_ALARM_MS, unclaimedKey, unclaimedSentKey } from "../src/lib/order-mark.js";
import { fitFindings } from "../src/lib/order-findings.js";
import { unpullableReason } from "../src/lib/order-pullable.js";
import { currentOrders, orderWireFor } from "../src/lib/order-take.js";
import { routeOrderTool, type OrderToolHandler } from "../src/lib/order-tool-route.js";
import { codexFailure } from "../src/lib/scheduler-auto-ports.js";
import { boundRef } from "../src/lib/scheduler-auto-tick.js";
import { CLAIM_LEASE_MS, driveDispatch, type SchedulerLedgerOps } from "../src/lib/scheduler-dispatch.js";
import { ledgerResult } from "../src/lib/scheduler-work-order.js";
import { createAcpWorker } from "../src/lib/worker-acp.js";
import { createChannelWorker, createTmuxFallbackWorker } from "../src/lib/worker-message.js";
import { parseVerdictWire, WIRE_MAX_BYTES } from "../src/lib/order-wire.js";
import { renderWorkOrder } from "../src/lib/worker-order.js";
import type { AdapterDeps } from "../src/lib/worker-ports.js";
import { deliveryFor, sentAsWake, type SessionRef, type WorkOrder } from "../src/lib/worker-session.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

type F = ReturnType<typeof autoFixture>;
const author = (f: F) => ({ agent: "agent-task-one", sessionId: "s-one", family: "claude-code", channelId: "ch-one" });
const lastIntent = (f: F) => f.db.query("SELECT * FROM scheduler_intents ORDER BY eventSeq DESC LIMIT 1").get() as SchedulerIntent;
const adapter = (f: F): AdapterDeps => ({
  sessions: { bound: (t, role) => boundRef(f.db, t, role), create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
  ledger: { result: (ref, probe) => ledgerResult(f.db, ref, probe) },
});

describe("派单方式：认领前定死，唤醒只一句、单在台账；回退文字写明原因", () => {
  test("deliveryFor：频道 / ACP 唤醒；Codex tmux 与复述单退回文字并带原因", () => {
    expect(deliveryFor("channel", "write")).toEqual({ mode: "wake" });
    expect(deliveryFor("acp", "review")).toEqual({ mode: "wake" });
    expect(deliveryFor("tmux", "fix")).toEqual({ mode: "text", reason: expect.stringContaining("tmux") });
    expect(deliveryFor("acp", "restate")).toEqual({ mode: "text", reason: expect.stringContaining("复述单") });
  });

  test("复述单发全文（回执 delivery=text 带原因）；写单只发唤醒，take_order 领到的正是这条意图", async () => {
    const f = autoFixture();
    try {
      await f.tick(); // author session
      await f.tick(); // restate
      expect(f.sent[0].text).toContain("完成后回写");
      expect(lastIntent(f).receipt).toMatch(/^delivery=text（复述单没有领单工具/);
      expect(sentAsWake(lastIntent(f).receipt)).toBe(false);
      await f.cli("agent-task-one", "stage", "T1", "--from", "spec", "--to", "restate", "--text", "复述");
      await f.cli("pm", "restate-approve", "T1");
      await f.tick(); // restate → build
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      const write = lastIntent(f);
      expect(f.sent.at(-1)?.text).toBe(`【调度派单】有新单 ${write.id}（T1 · write · 第 0 轮）：调用 take_order 领取，按单子做，完成用 deliver 回写。`);
      expect(f.sent.at(-1)?.text).not.toContain("完成后回写");
      expect(sentAsWake(write.receipt)).toBe(true);
      const claim = listEvents(f.db, { project: "p", target: "T1" }).find((e) => e.dedupKey === `scheduler:${write.id}:submitted`);
      expect(claim?.data.receipt).toContain("delivery=wake");
      const [cur] = currentOrders(f.db, author(f));
      expect(cur.orderId).toBe(write.id);
      const wire = orderWireFor(f.db, cur);
      expect(wire.ok && wire.order).toMatchObject({ orderId: write.id, taskId: "T1", step: "write", fallback: "再不行退到：只报错不修" });
    } finally { f.close(); }
  });

  test("回退文字时同一意图只发一次：重放、租约过期对账都不补发，也不改发唤醒", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      const codexTui: SessionRef = { ...boundRef(f.db, "T1", "author")! };
      const sent: string[] = [];
      const port = { send: async (_a: string, _s: string, text: string) => { sent.push(text); return { ok: true as const, messageId: "m" }; },
        status: async () => "idle" as const, interrupt: async () => ({ ok: true as const, evidence: "i" }) };
      const tmux = createTmuxFallbackWorker({ ...adapter(f), port, reason: "tmux 兼容回退：测试" });
      // 真实流水线里 tmux 只驱动 codex 宿主；这里只看驱动器：同一张单按 text 发一次，之后的轮次都不再发
      const order = (d = deliveryFor("tmux", "write")): WorkOrder => ({ taskId: "T1", specRev: 1, head: null, round: 0, node: "write", step: "write",
        dedupKey: "k1", inputs: ["spec"], outputs: ["x"], acceptance: ["y"], writeBack: "deliver", delivery: d });
      expect(renderWorkOrder(order())).toContain("完成后回写");
      const state = { status: "pending" as IntentStatus, updatedAt: 0, receipt: null as string | null };
      const ops: SchedulerLedgerOps = {
        intent: () => ({ id: "k1", taskId: "T1", project: "p", node: "write", action: "dispatch", recipient: codexTui.agent, causalSeq: 1, eventSeq: 1, taskRev: 1,
          specRev: 1, head: null, templateVersion: 2, attempts: 0, reason: "", createdAt: 0, ...state }),
        current: () => ({ specRev: 1, head: null, round: 0, bound: codexTui }),
        settle: async (_id, from, to, receipt) => { if (state.status !== from) return false; Object.assign(state, { status: to, receipt, updatedAt: 1 }); return true; },
        taken: () => null,
        now: () => CLAIM_LEASE_MS * 3,
      };
      const w = { ...tmux, submit: (ref: SessionRef, id: string, o: WorkOrder) => tmux.submit({ ...ref, family: "codex" }, id, o) };
      expect(await driveDispatch(ops, w, codexTui, order())).toMatchObject({ kind: "sent" });
      expect(state.receipt).toMatch(/^delivery=text（Codex tmux 会话没有派单工具）; route=tmux/);
      expect(await driveDispatch(ops, w, codexTui, order({ mode: "wake" }))).toEqual({ kind: "settled", status: "done" });
      Object.assign(state, { status: "submitted" });
      expect(await driveDispatch(ops, w, codexTui, order({ mode: "wake" }))).toMatchObject({ kind: "held", reason: "claimed_without_receipt" });
      expect(sent).toHaveLength(1);
    } finally { f.close(); }
  });
});

describe("对账：认领后没回执，只认收件人本人的领单记录", () => {
  test("有 order_taken → done、不重发；没有 → unknown 交 PM", async () => {
    for (const took of [7, null]) {
      const state = { status: "submitted" as IntentStatus, updatedAt: 0, receipt: "claimed" as string | null };
      const ref: SessionRef = { taskId: "T1", role: "author", agent: "a", sessionId: "s", family: "claude", transport: "tmux" };
      const sent: string[] = [];
      const w = createChannelWorker({
        sessions: { bound: () => ref, create: async () => ({ ok: false, unknown: false, reason: "n/a" }), archive: async () => ({ ok: true, evidence: "x" }) },
        ledger: { result: () => null },
        port: { send: async (_a, _s, t) => { sent.push(t); return { ok: true, messageId: "m" }; }, status: async () => "idle", interrupt: async () => ({ ok: true, evidence: "i" }) },
      });
      const ops: SchedulerLedgerOps = {
        intent: () => ({ id: "k1", taskId: "T1", project: "p", node: "write", action: "dispatch", recipient: "a", causalSeq: 1, eventSeq: 1, taskRev: 1,
          specRev: 1, head: null, templateVersion: 2, attempts: 0, reason: "", createdAt: 0, ...state }),
        current: () => ({ specRev: 1, head: null, round: 0, bound: ref }),
        settle: async (_id, from, to, receipt) => { if (state.status !== from) return false; Object.assign(state, { status: to, receipt }); return true; },
        taken: () => took,
        now: () => CLAIM_LEASE_MS + 1,
      };
      const order: WorkOrder = { taskId: "T1", specRev: 1, head: null, round: 0, node: "write", step: "write", dedupKey: "k1", inputs: [], outputs: [],
        acceptance: [], writeBack: "", delivery: { mode: "wake" } };
      const r = await driveDispatch(ops, w, ref, order);
      expect(r).toEqual(took ? { kind: "settled", status: "done" } : { kind: "held", reason: "claimed_without_receipt" });
      expect(state.receipt).toContain(took ? "收件人已领单 seq 7" : "交 PM 核对");
      expect(sent).toEqual([]);
    }
  });
});

describe("领单留痕不串卡、不串会话，未验证身份到不了", () => {
  test("order-taken 只认收件人本人、台账绑定的会话、已派出的单；按单去重", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const id = lastIntent(f).id;
      expect(await f.cli("agent-rv-t1", "order-taken", id, "--session", "s-rv")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", "order-taken", id, "--session", "s-other")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", "order-taken", "no-such-intent", "--session", "s-one")).toMatchObject({ ok: false, code: "not_found" });
      expect(await f.cli("scheduler", "order-taken", id, "--session", "s-one")).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("agent-task-one", "scheduler-unclaimed", id, "--text", "x")).toMatchObject({ ok: false, code: "forbidden" });
      const first = await f.cli("agent-task-one", "order-taken", id, "--session", "s-one");
      expect(first).toMatchObject({ ok: true, duplicate: false, event: { actor: "agent-task-one", data: { op: "order_taken", id, sessionId: "s-one" } } });
      expect(await f.cli("agent-task-one", "order-taken", id, "--session", "s-one")).toMatchObject({ ok: true, duplicate: true });
      // 已被领的单不再报警
      expect(await f.cli("scheduler", "scheduler-unclaimed", id, "--text", "x")).toMatchObject({ ok: false, code: "conflict" });
      const plan = f.db.query("SELECT id FROM scheduler_intents WHERE action = 'ensure_session' LIMIT 1").get() as { id: string };
      expect(await f.cli("agent-task-one", "order-taken", plan.id, "--session", "s-one")).toMatchObject({ ok: false, code: "invalid" });
    } finally { f.close(); }
  });

  test("没派出（pending）或已作废的单记不上", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      f.setSend("refuse");
      expect(await f.tick()).toMatchObject({ step: "replan" });
      const cancelled = lastIntent(f);
      expect(cancelled.status).toBe("cancelled");
      expect(await f.cli("agent-task-one", "order-taken", cancelled.id, "--session", "s-one")).toMatchObject({ ok: false, code: "conflict" });
    } finally { f.close(); }
  });

  test("recordTaken：只记调度意图、已记的跳过、写失败只记日志；身份门拒掉的调用 handler 与留痕都不跑", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const id = lastIntent(f).id;
      const runs: string[][] = [], logs: string[] = [];
      const run = async (args: string[], channelId: string) => { runs.push([...args, channelId]); return f.cli("agent-task-one", ...args.slice(1)); };
      expect(await recordTaken(f.db, author(f), ["T1:write:r0", id], run, (m) => logs.push(m))).toEqual([id]);
      expect(runs).toEqual([["ledger", "order-taken", id, "--session=s-one", "ch-one"]]);
      expect(getEventByDedup(f.db, takenKey(id))).not.toBeNull();
      expect(await recordTaken(f.db, author(f), [id], run)).toEqual([]);
      expect(runs).toHaveLength(1);
      expect(await recordTaken(f.db, { ...author(f), sessionId: null }, [id], run)).toEqual([]);
      const g = autoFixture();
      try {
        await toBuild(g);
        await g.tick();
        const boom = async () => { throw new Error("manager 超时"); };
        expect(await recordTaken(g.db, author(g), [lastIntent(g).id], boom, (m) => logs.push(m))).toEqual([]);
        expect(logs.at(-1)).toContain("manager 超时");
      } finally { g.close(); }

      let handled = 0, marked = 0;
      const handler: OrderToolHandler = async () => { handled++; return { ok: true, order: { orderId: id } }; };
      const tool = markingTakes(handler, (r) => [String((r.order as { orderId: string }).orderId)], async () => { marked++; });
      const handlers = { take_order: tool };
      const unverified = await routeOrderTool("take_order", { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", verified: false }, "ch-one", {}, handlers);
      expect(unverified).toMatchObject({ ok: false, code: "identity_unverified" });
      expect([handled, marked]).toEqual([0, 0]);
      expect(await routeOrderTool("take_order", { agent: "agent-task-one", sessionId: "s-one", family: "claude-code", verified: true }, "ch-one", {}, handlers))
        .toMatchObject({ ok: true });
      await Promise.resolve();
      expect([handled, marked]).toEqual([1, 1]);
    } finally { f.close(); }
  });
});

describe("未领单报警：唤醒发出 10 分钟没人领，只报一次", () => {
  test("不到点不报；到点报一次，重复 tick / 再跑一次命令都不重报；领过的、文字派的单不报", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const id = lastIntent(f).id;
      f.advance(UNCLAIMED_ALARM_MS - 60_000);
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(f.notices).toEqual([]);
      f.advance(2 * 60_000);
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: "agent-task-one 未领单，已报警" });
      expect(f.notices).toEqual([expect.stringContaining(`T1 的单 ${id} 唤醒已发给 agent-task-one`)]);
      expect(f.notices[0]).toContain("take_order");
      for (let i = 0; i < 3; i++) await f.tick();
      expect(await f.cli("scheduler", "scheduler-unclaimed", id, "--text", "again")).toMatchObject({ ok: true, duplicate: true });
      expect(f.notices).toHaveLength(1);
      expect(getEventByDedup(f.db, unclaimedKey(id))?.data).toMatchObject({ op: "unclaimed", id, recipient: "agent-task-one" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto"); // 只报警，不退回人工、不重发
      expect(f.sent).toHaveLength(2);
    } finally { f.close(); }

    const taken = autoFixture();
    try {
      await toBuild(taken);
      await taken.tick();
      expect((await taken.cli("agent-task-one", "order-taken", lastIntent(taken).id, "--session", "s-one")).ok).toBe(true);
      taken.advance(UNCLAIMED_ALARM_MS * 2);
      await taken.tick();
      expect(taken.notices).toEqual([]);
    } finally { taken.close(); }

    const text = autoFixture();
    try {
      await text.tick();
      await text.tick(); // 复述单按文字发
      text.advance(UNCLAIMED_ALARM_MS * 2);
      await text.tick();
      expect(text.notices).toEqual([]);
    } finally { text.close(); }
  });
});

describe("未领单报警没送到 PM：记着没送到，稍后照原文重发，送到才算报过", () => {
  test("第一次 notifyPm 失败 → 60 秒内不重试 → 之后重发一次成功 → 再也不报", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const id = lastIntent(f).id;
      const tries: string[] = [];
      let down = true;
      f.tickDeps.notifyPm = async (_t, text) => { tries.push(text); if (down) throw new Error("bridge unavailable"); };
      f.advance(UNCLAIMED_ALARM_MS + 1);
      expect(await f.tick()).toMatchObject({ step: "waiting", detail: expect.stringContaining("稍后重发") });
      expect(getEventByDedup(f.db, unclaimedKey(id))).not.toBeNull();
      expect(getEventByDedup(f.db, unclaimedSentKey(id))).toBeNull();
      down = false;
      f.advance(30_000);
      expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("待重发") });
      expect(tries).toHaveLength(1);
      f.advance(31_000);
      expect(await f.tick()).toMatchObject({ detail: "agent-task-one 未领单，已报警" });
      expect(tries).toHaveLength(2);
      expect(tries[1]).toBe(tries[0]); // 同一条报警、同一段文字，不是每次现拼
      expect(getEventByDedup(f.db, unclaimedSentKey(id))?.data).toMatchObject({ op: "unclaimed_sent", id });
      for (let i = 0; i < 3; i++) { f.advance(UNCLAIMED_ALARM_MS); expect(await f.tick()).toMatchObject({ detail: expect.stringContaining("已报警过") }); }
      expect(tries).toHaveLength(2);
    } finally { f.close(); }
  });

  test("报警记上了、通知前进程没了：新进程照原文补发；送达只由调度服务写、要先有报警", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const id = lastIntent(f).id;
      expect(await f.cli("agent-task-one", "scheduler-unclaimed-sent", id)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("scheduler", "scheduler-unclaimed-sent", id)).toMatchObject({ ok: false, code: "conflict" });
      expect((await f.cli("scheduler", "scheduler-unclaimed", id, "--text", "crash 前落的报警")).ok).toBe(true);
      f.advance(UNCLAIMED_ALARM_MS + 1);
      expect(await f.tick()).toMatchObject({ detail: "agent-task-one 未领单，已报警" });
      expect(f.notices).toEqual(["crash 前落的报警"]);
    } finally { f.close(); }
  });
});

describe("结论再长，修复单也领得到（单子整体不超 WIRE_MAX_BYTES）", () => {
  const big = (n: number, severity: "P1" | "P2" = "P1", size = 3950) =>
    Array.from({ length: n }, (_, i) => ({ findingId: `large-${severity}-${i}`, family: "concurrency", severity, probe: "[回归]" + "x".repeat(size - 8) }));

  test("8 条满长 P1（VerdictWire 合法）→ review→fix 后照发唤醒，take_order 拿到装得下的单，注明全文在报告", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
      await f.tick(); await f.tick();
      const rows = big(8);
      const verdict = { v: 1, orderId: lastIntent(f).id, head: H1, verdict: "changes", p0: 0, p1: 8, p2: 0,
        findings: rows.map((r) => ({ ...r, description: "x" })), reportPath: "/r/T1-r1.md" };
      expect(parseVerdictWire(verdict).ok).toBe(true);
      expect((await f.review("changes", H1, rows)).ok).toBe(true);
      await f.tick();
      expect(await f.tick()).toMatchObject({ step: "sent", detail: "channel" });
      expect(lastIntent(f).receipt).toContain("delivery=wake");
      const order = currentOrders(f.db, author(f))[0];
      const wire = orderWireFor(f.db, order);
      if (!wire.ok) throw new Error(wire.error);
      expect(Buffer.byteLength(JSON.stringify(wire.order))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
      expect(wire.order.findings.map((x) => x.findingId)).toEqual(rows.map((r) => r.findingId));
      expect(wire.order.inputs.at(-1)).toContain("全文看审查报告 reviews/T1-r1/report.md");
    } finally { f.close(); }
  });

  test("压到最短还装不下就先丢最轻的项；装得下的单原样不动", () => {
    const small = { inputs: ["a"], findings: big(2, "P1", 10) };
    expect(fitFindings(small, "/r.md")).toBe(small);
    const wire = { inputs: ["x".repeat(16 * 1024)], findings: [...big(60, "P2"), ...big(40, "P1")] };
    const fit = fitFindings(wire, "/r.md");
    expect(Buffer.byteLength(JSON.stringify(fit))).toBeLessThanOrEqual(WIRE_MAX_BYTES);
    expect(fit.findings.length).toBeLessThan(100);
    expect(fit.findings.slice(0, 40).every((x) => x.severity === "P1")).toBe(true);
    expect(fit.inputs.at(-1)).toContain(`只列最严重的 ${fit.findings.length}/100 项`);
  });

  test("领单口径找不到这张单（会话不是台账绑定的那个）→ 不发唤醒，写明原因", async () => {
    const f = autoFixture();
    try {
      await toBuild(f);
      await f.tick();
      const intent = lastIntent(f);
      const ref = boundRef(f.db, "T1", "author")!;
      expect(unpullableReason(f.db, ref, intent)).toBeNull();
      expect(unpullableReason(f.db, { ...ref, sessionId: "s-other" }, intent)).toContain("找不到这张单");
    } finally { f.close(); }
  });
});

describe("ACP 回合失败（cyber_policy 这类）不静默", () => {
  async function reviewSent(openAt: "before" | "after") {
    const f = autoFixture();
    await toBuild(f);
    await f.tick();
    await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
    await f.tick(); // ensure reviewer
    const card = (at: number) => openAsk(f.db, { project: "p", fromAgent: "agent-rv-t1", source: "codex", kind: "owner_action", title: "Codex 回合失败",
      context: "This request was blocked by cyber policy.", extra: { failure: "error" } }, at);
    if (openAt === "before") card(1);
    const send = async () => {
      const claimed = (f.db.query("SELECT updatedAt FROM scheduler_intents WHERE status = 'submitted'").get() as { updatedAt: number }).updatedAt;
      if (openAt === "after") card(claimed + 1);
      return { ok: true as const, messageId: "m" };
    };
    f.tickDeps.worker = () => createAcpWorker({ ...adapter(f),
      port: { prompt: send, turnState: async (a) => ({ live: "idle", lastFailure: codexFailure(f.db, a) }), cancel: async () => ({ ok: true, evidence: "c" }) } });
    expect(await f.tick()).toMatchObject({ step: "sent", detail: "acp" });
    return f;
  }

  test("派审之后的回合失败卡归到本单：退回人工、台账有事件、PM 收到通知", async () => {
    const f = await reviewSent("after");
    try {
      expect(codexFailure(f.db, "agent-rv-t1")).toMatchObject({ failure: { kind: "error" }, afterKey: lastIntent(f).id });
      expect(await f.tick()).toMatchObject({ step: "manual", detail: expect.stringContaining("回合失败") });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      const ev = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "scheduler" && e.data.op === "fallback_manual");
      expect(ev?.text).toContain("cyber policy");
      expect(f.notices).toEqual([expect.stringContaining("cyber policy")]);
    } finally { f.close(); }
  });

  test("派单之前就有的回合失败卡归不到任何单，不连累之后派的单", async () => {
    const f = await reviewSent("before");
    try {
      expect(codexFailure(f.db, "agent-rv-t1")).toBeUndefined();
      expect(await f.tick()).toMatchObject({ step: "waiting" });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });
});
