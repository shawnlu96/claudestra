/**
 * 统一派单（T48，src/manager/ledger-step-dispatch.ts）：通道选择、对方项目 PM 目录、两种首行、派单记账、回执 / 超时提醒 / 失败重试、
 * 修的单子附本轮报告、常设授权、注入头认出「回报」
 */
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { getMeta, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { appendEvent, createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { recordAccept } from "../src/lib/ledger-steps-write.js";
import { getDispatch, listDispatches, retryDelayMs, sweepAction, ACK_TIMEOUT_MS } from "../src/lib/ledger-dispatch-log.js";
import { answerAsk, openAsk } from "../src/lib/ledger-asks.js";
import { bindHash } from "../src/lib/ask-bind.js";
import { isTaskDelegatedToPeer } from "../src/lib/peer-delegated.js";
import { checkAcceptAsk } from "../src/manager/peer-ledger-cli.js";
import { runLedger } from "../src/manager/ledger.js";
import { sendKeyOf } from "../src/manager/ledger-step-dispatch.js";
import { dispatchToAgent } from "../src/bridge/dispatch-route.js";
import { withDeliveryDedup } from "../src/bridge/api-dedup.js";
import { isWriteInvocation } from "../src/manager/write-commands.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "proj";
let db: Database;
let now: number;
let sent: { channel: string; target: string; text: string }[];
let keys: string[];
let sendOk: boolean;

function run(actor: string, ...args: string[]) {
  return runLedger(args, {
    db, actor, actorProject: P, projectIds: [P], now: () => now,
    loadRegistry: async () => ({ socket: "s", agents: {} }), saveRegistry: async () => {},
    dispatchSend: async (row, text) => {
      sent.push({ channel: row.channel, target: row.target, text });
      keys.push(sendKeyOf(row));
      return sendOk ? { ok: true } : { ok: false, error: "对方离线" };
    },
  }) as Promise<Record<string, any>>;
}

beforeEach(() => {
  db = openLedger(tempLedgerPath("ledger-step-dispatch-"));
  now = 10_000;
  sent = [];
  keys = [];
  sendOk = true;
  const o = { actor: "owner", now: 1 };
  setMeta(db, o, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, o, { project: P, id: "T1", title: "派单", kind: "code", agent: "agent-exec", branch: "task/t1" });
});

describe("派单与通道", () => {
  test("本机 agent：派人 + dispatch 事件 + 投递行，当场投一次；首行是步骤单", async () => {
    const r = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    expect(r).toMatchObject({ ok: true, delivered: true, redactions: 0 });
    expect(sent).toEqual([{ channel: "local", target: "agent-exec", text: r.text }]);
    expect(r.text.split("\n")[0]).toBe("[协作 T1/restate]");
    expect(getDispatch(db, r.event.seq)).toMatchObject({ step: "restate", executor: "agent-exec", channel: "local", attempts: 1, deliveredAt: 10_000, ackAt: null });
    const steps = await run("agent-pm", "steps", "T1");
    expect(steps.steps.find((s: any) => s.step === "restate" && !s.derived)).toMatchObject({ executor: "agent-exec", state: "assigned" });
    expect(isWriteInvocation("ledger", ["dispatch-log", "T1"])).toBe(false);
  });

  test("只有 PM / master / owner 能派；人、合并、核对不出任务单", async () => {
    expect((await run("agent-exec", "dispatch", "T1", "--step", "write", "--to", "agent-exec")).code).toBe("forbidden");
    expect((await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", "local:owner:self")).error).toContain("人不收步骤单");
    expect((await run("agent-pm", "dispatch", "T1", "--step", "merge", "--to", "agent-exec")).error).toContain("合并部署、核对不出任务单");
    expect(sent).toEqual([]);
  });

  test("peer：没登记对方项目 PM 就拒；登记后只发给那个 PM，未接受是新委托、接受后是步骤单，正文脱敏", async () => {
    expect((await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", "agent-codex@Shawn", "--kind", "peer")).error).toContain("team-set --peer-pm Shawn=");
    expect((await run("agent-exec", "team-set", "--peer-pm", "Shawn=agent-claudestra-dev")).code).toBe("forbidden");
    const set = await run("agent-pm", "team-set", "--peer-pm", "Shawn=agent-claudestra-dev", "--concurrency", "2");
    expect(set.peerPms).toEqual({ Shawn: { agent: "agent-claudestra-dev", concurrency: 2 } });
    expect(getMeta(db, P).peerPms.Shawn!.concurrency).toBe(2);
    const a = await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", "agent-codex@Shawn", "--kind", "peer");
    expect(sent.at(-1)).toMatchObject({ channel: "peer", target: "agent-claudestra-dev@Shawn" });
    expect(a.text.split("\n")[0]).toBe("[协作 T1]");
    expect(a.text).toContain("bun src/manager.ts peer-ledger <发起方> pr T1");
    expect(a.text).toEndWith(`本单脱敏 ${a.redactions} 处。`);
    recordAccept(db, { actor: "peer:Shawn", now: 11_000 }, { taskId: "T1", peer: "Shawn" });
    // 同一步同一人重派是重复（P2-2）；接受之后派下一步（修）才是步骤单
    expect((await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", "agent-codex@Shawn", "--kind", "peer")).duplicate).toBe(true);
    const b = await run("agent-pm", "dispatch", "T1", "--step", "fix", "--to", "agent-codex@Shawn", "--kind", "peer");
    expect(b.text.split("\n")[0]).toBe("[协作 T1/fix]");
    expect((await run("agent-pm", "team-set", "--peer-pm", "Shawn=")).peerPms).toEqual({});
  });

  test("修的单子附本轮审查报告全文：review 事件正文 + 同一审查方这一轮写的 note（peer 写的也收）", async () => {
    moveStage(db, { actor: "owner", now: 2 }, { taskId: "T1", from: "spec", to: "restate" });
    moveStage(db, { actor: "owner", now: 3 }, { taskId: "T1", from: "restate", to: "build" });
    deliver(db, { actor: "agent-exec", now: 4 }, { taskId: "T1", headSHA: "abc1234", moveFrom: "build" });
    appendEvent(db, { actor: "agent-rev", now: 5 }, { project: P, target: "T1", kind: "note", text: "完整报告：P1 drain 没期限，复现见下" });
    recordReview(db, { actor: "agent-rev", now: 6 }, { taskId: "T1", reviewer: "agent-rev", verdict: "changes", p0: 0, p1: 1, p2: 0, text: "一条 P1" });
    const r = await run("agent-pm", "dispatch", "T1", "--step", "fix", "--to", "agent-exec");
    expect(r.text).toContain("本轮审查报告（全文）：");
    expect(r.text).toContain("│ 结论：changes（P0 0 / P1 1 / P2 0），审查方 agent-rev");
    expect(r.text).toContain("│ 完整报告：P1 drain 没期限，复现见下");
    expect(listEvents(db, { project: P, target: "T1" }).at(-1)).toMatchObject({ kind: "dispatch", data: { step: "fix", to: "agent-exec" } });
  });
});

describe("回执、重试、超时提醒", () => {
  const sweep = () => run("owner", "dispatch-sweep");

  test("回执 = 执行者在卡上写了任何事件；送达 15 分钟没回执提醒 PM 一次；dispatch-sweep 只有 owner / master 能跑", async () => {
    const r = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    expect((await run("agent-pm", "dispatch-sweep")).code).toBe("forbidden");
    now += ACK_TIMEOUT_MS - 1;
    expect((await sweep()).notices).toEqual([]);
    now += 1;
    const s = await sweep();
    expect(s.notices).toEqual([{ taskId: "T1", project: P, pm: "agent-pm", text: expect.stringContaining("【派单没回执】T1/restate → agent-exec") }]);
    expect(listEvents(db, { project: P, target: "T1" }).at(-1)).toMatchObject({ kind: "note", actor: "bridge-rule" });
    expect((await sweep()).notices).toEqual([]); // 只提醒一次
    appendEvent(db, { actor: "agent-exec", now: now + 5 }, { project: P, target: "T1", kind: "note", text: "收到" });
    expect(await sweep()).toMatchObject({ acked: 1 });
    expect(getDispatch(db, r.event.seq)!.ackAt).toBe(now + 5);
    expect(listDispatches(db)).toEqual([]);
  });

  test("peer 执行者写卡（actor peer:<实例>）也算回执", async () => {
    await run("agent-pm", "team-set", "--peer-pm", "Shawn=agent-x");
    const r = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-codex@Shawn", "--kind", "peer");
    appendEvent(db, { actor: "peer:Other", now: now + 1 }, { project: P, target: "T1", kind: "note", text: "不是它" });
    expect(await sweep()).toMatchObject({ acked: 0 });
    appendEvent(db, { actor: "peer:Shawn", now: now + 2 }, { project: P, target: "T1", kind: "note", text: "复述在写" });
    expect(await sweep()).toMatchObject({ acked: 1 });
    expect(getDispatch(db, r.event.seq)!.ackAt).toBe(now + 2);
  });

  test("投递失败按 1、2、4、8 分钟退避重发，原样重发同一份正文；连着失败 4 次提醒 PM 一次；送达后才开始算 15 分钟", async () => {
    sendOk = false;
    const r = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    expect(r).toMatchObject({ delivered: false, error: "对方离线" });
    expect(getDispatch(db, r.event.seq)).toMatchObject({ attempts: 1, nextAt: now + 60_000, lastError: "对方离线" });
    for (const n of [1, 2, 3]) {
      now += retryDelayMs(n) - 1;
      expect(await sweep()).toMatchObject({ sent: 0, failed: 0 }); // 还没到点
      now += 1;
      expect(await sweep()).toMatchObject({ failed: 1 });
    }
    expect(sent.every((x) => x.text === r.text)).toBe(true);
    const alert = await sweep();
    expect(alert.notices[0].text).toContain("【派单送不出去】");
    expect((await sweep()).notices).toEqual([]);
    sendOk = true;
    now += retryDelayMs(4);
    expect(await sweep()).toMatchObject({ sent: 1 });
    expect(getDispatch(db, r.event.seq)!.deliveredAt).toBe(now);
    now += ACK_TIMEOUT_MS;
    expect((await sweep()).notices[0].text).toContain("【派单没回执】");
  });

  test("同一步又派了别人：旧单停止重试和提醒；卡结束也停", async () => {
    sendOk = false;
    const old = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    sendOk = true;
    await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-other");
    now += 60_000;
    expect(await sweep()).toMatchObject({ stopped: 1, sent: 0 });
    expect(getDispatch(db, old.event.seq)!.stoppedAt).toBe(now);
  });

  test("sweepAction：已回执 / 已停不动；超时只在送达之后算", () => {
    const row = { seq: 1, taskId: "T1", project: P, step: "write", round: 0, executor: "a", channel: "local" as const, target: "a", text: "", attempts: 1,
      nextAt: null, deliveredAt: 0, ackAt: null, remindedAt: null, failAlertAt: null, stoppedAt: null, lastError: null, createdAt: 0, updatedAt: 0 };
    expect(sweepAction(row, ACK_TIMEOUT_MS, null, false, false)).toEqual({ kind: "remind" });
    expect(sweepAction({ ...row, ackAt: 5 }, ACK_TIMEOUT_MS, null, false, false)).toEqual({ kind: "wait" });
    expect(sweepAction({ ...row, deliveredAt: null, nextAt: 10 }, ACK_TIMEOUT_MS * 9, null, false, false)).toEqual({ kind: "send" });
    expect(sweepAction(row, ACK_TIMEOUT_MS, null, false, true)).toEqual({ kind: "stop" });
  });
});

describe("常设授权与注入头", () => {
  const OWN = "agent-outer";
  const standing = { action: "peer_accept_standing", params: { peer: "Shawn", project: "claude-orchestrator" }, approve: ["yes"] };
  const signed = () => {
    const a = openAsk(db, {
      project: P, fromAgent: OWN, fromChannelId: "1", source: "reply", kind: "authorize", title: "常设授权",
      options: [{ type: "buttons", buttons: [{ id: "yes", label: "同意" }, { id: "no", label: "不" }] }],
      bind: { ...standing, paramsHash: bindHash(standing, OWN) }, askKey: "standing",
    }, 1_000);
    return a;
  };
  const answer = (id: string, b: string) => answerAsk(db, id, { choices: [`[button:${b}]`], labels: [b], text: "", principal: "owner:self", via: "web_card", at: 2_000 });

  test("只比 peer 与对方卡上的项目，不比任务号；没答 / 点了不 / peer 或项目不对 / 读不到项目：拒", () => {
    const a = signed();
    const check = (task: string, peer = "Shawn", project: string | null = "claude-orchestrator") => checkAcceptAsk(db, a.id, peer, task, OWN, 3_000, project ?? undefined);
    expect(check("T48").ok).toBe(false); // 还没答
    answer(a.id, "yes");
    expect(check("T48")).toEqual({ ok: true });
    expect(check("T59")).toEqual({ ok: true });
    expect(check("T48", "He").ok).toBe(false);
    expect(check("T48", "Shawn", "other-project").ok).toBe(false);
    expect(check("T48", "Shawn", null)).toMatchObject({ ok: false, reason: expect.stringContaining("读不到对方卡上的项目") });
    expect(checkAcceptAsk(db, a.id, "Shawn", "T48", "agent-someone", 3_000, "claude-orchestrator").ok).toBe(false);
    const no = openAsk(db, {
      project: P, fromAgent: OWN, fromChannelId: "1", source: "reply", kind: "authorize", title: "常设授权 2",
      options: [{ type: "buttons", buttons: [{ id: "yes", label: "同意" }, { id: "no", label: "不" }] }],
      bind: { ...standing, paramsHash: bindHash(standing, OWN) }, askKey: "standing-2",
    }, 1_000);
    answer(no.id, "no");
    expect(checkAcceptAsk(db, no.id, "Shawn", "T48", OWN, 3_000, "claude-orchestrator").ok).toBe(false);
  });

  test("本方委托给这个 peer 的卡：认得出（按步骤，含老卡的 extra.delegate）；别的 peer、没有的卡：认不出", () => {
    createTask(db, { actor: "owner", now: 1 }, { project: P, id: "T2", title: "委托", kind: "code", extra: { delegate: "agent-d@Shawn" } });
    expect(isTaskDelegatedToPeer("Shawn", "T2", db)).toBe(true);
    expect(isTaskDelegatedToPeer("He", "T2", db)).toBe(false);
    expect(isTaskDelegatedToPeer("Shawn", "T404", db)).toBe(false);
    expect(isTaskDelegatedToPeer("Shawn", "T2", null)).toBe(false);
  });
});

describe("复审修复（T48 round 1）", () => {
  test("P1-1：kind=agent 的执行者带 @ 或 peer: 一律拒，不经本机通道发到远端", async () => {
    for (const to of ["agent-codex@Shawn", "peer:Shawn.agent-codex"]) {
      const r = await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", to, "--kind", "agent");
      expect(r).toMatchObject({ ok: false, code: "invalid" });
      expect(r.error).toContain("--kind peer");
    }
    expect(sent).toEqual([]);
    expect(listEvents(db, { project: P, target: "T1" }).some((e) => e.kind === "dispatch" || e.kind === "step")).toBe(false);
  });

  test("P1-1：本机派单入口不认 x@peer / peer:，也不做远程转换", async () => {
    let delivered = 0;
    const deliver = async () => (delivered++, { outcome: { kind: "sent" } });
    const deps = { clients: new Map([["c1", { ws: {} as never }]]), deliver, lastMessageSource: { set: () => {} }, channelOf: () => "c1" };
    for (const name of ["agent-x@Shawn", "peer:Shawn.agent-x"]) {
      expect(await dispatchToAgent({ targetName: name, text: "x" }, {} as never, deps)).toMatchObject({ error: expect.stringContaining("本机派单只收本机 agent 名") });
    }
    expect(delivered).toBe(0);
  });

  test("P2-1：发送标识 = 派单编号 + 轮次，重发不变；本机入口与 messages API 按它只投一次", async () => {
    sendOk = false;
    const r = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    now += 60_000;
    await run("owner", "dispatch-sweep");
    expect(keys).toEqual([`dispatch:D${r.event.seq}:r0`, `dispatch:D${r.event.seq}:r0`]);

    let delivered = 0;
    const deliver = async () => (delivered++, { outcome: { kind: "sent" } });
    const deps = { clients: new Map([["c1", { ws: {} as never }]]), deliver, lastMessageSource: { set: () => {} }, channelOf: () => "c1" };
    const a = await dispatchToAgent({ targetName: "agent-exec", text: "单子", dedup: "dispatch:D9:r0" }, {} as never, deps);
    const b = await dispatchToAgent({ targetName: "agent-exec", text: "单子", dedup: "dispatch:D9:r0" }, {} as never, deps);
    expect(delivered).toBe(1);
    expect(b).toEqual({ result: { targetName: "agent-exec", threadId: (a as { result: { threadId: string } }).result.threadId, duplicate: true } });

    let handled = 0;
    const handler = async () => (handled++, Response.json({ ok: true, accepted: true, threadId: `thr_${handled}` }, { status: 202 }));
    const headers = (bearer: string) => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" });
    const post = (bearer: string, dedup?: string) => withDeliveryDedup(
      new Request("http://x/api/v1/agents/agent-pm/messages", { method: "POST", headers: headers(bearer), body: JSON.stringify({ text: "单子", ...(dedup ? { dedup } : {}) }) }),
      new URL("http://x/api/v1/agents/agent-pm/messages"), handler,
    );
    expect(await (await post("peer-tok", "dispatch:D9:r0")).json()).toMatchObject({ threadId: "thr_1" });
    expect(await (await post("peer-tok", "dispatch:D9:r0")).json()).toMatchObject({ duplicate: true, threadId: "thr_1" });
    expect(await (await post("other-tok", "dispatch:D9:r0")).json()).toMatchObject({ threadId: "thr_2" }); // 别的发送方不串
    await post("peer-tok");
    await post("peer-tok");
    expect(handled).toBe(4); // 没带 dedup 的照常每次都投
  });

  test("P2-2：同卡 / 步骤 / 执行者 / 轮次重跑默认去重，判在派人之前，不重置步骤结果、不再发；改派别人再改回来算新的一次", async () => {
    const first = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    db.run("UPDATE task_steps SET state = 'delivered', headTo = 'abc1234' WHERE taskId = 'T1' AND step = 'restate'");
    const again = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    expect(again).toMatchObject({ ok: true, duplicate: true, event: { seq: first.event.seq } });
    expect(sent.length).toBe(1);
    const row = db.query("SELECT state, headTo FROM task_steps WHERE taskId = 'T1' AND step = 'restate'").get();
    expect(row).toEqual({ state: "delivered", headTo: "abc1234" });
    await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-other");
    const back = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec");
    expect(back.duplicate).toBeUndefined();
    expect(sent.length).toBe(3);
    const explicit = await run("agent-pm", "dispatch", "T1", "--step", "restate", "--to", "agent-exec", "--dedup", "k1");
    expect((await run("agent-pm", "dispatch", "T1", "--step", "write", "--to", "agent-exec", "--dedup", "k1")).event.seq).toBe(explicit.event.seq);
  });
});
