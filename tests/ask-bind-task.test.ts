/**
 * i28-ASKID1：授权卡挂的是 bind 里写明的任务，不是发起方当前在做的卡。真走 deliverReplyWithAsk → 台账 → 卡面 / 投出去的那条 → ask-check；
 * 临时库 + 假投递，不发真实授权。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deliverReplyWithAsk } from "../src/bridge/ask-reply.js";
import { setAsksForTest, type AsksDeps } from "../src/bridge/asks.js";
import type { Delivery, Envelope } from "../src/bridge/router.js";
import { bindHash, checkAsk } from "../src/lib/ask-bind.js";
import { renderBindSummary } from "../src/lib/ask-bind-render.js";
import { answerAsk, getAsk, listAsks, openAskFull, type Ask } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createItem, createTask } from "../src/lib/ledger-write.js";
import type { RegistryAgent } from "../src/lib/registry.js";
import { at } from "./asks-test-kit.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const ws = { tag: "ws" } as never;
const BUTTONS = [{ type: "buttons", buttons: [{ id: "go", label: "批准" }, { id: "no", label: "不批" }] }];
const grant = (params: Record<string, unknown>) => ({ kind: "authorize", bind: { action: "task_start", params, approve: ["go"] } });

let path = "";
let sent: string[] = [];
beforeEach(() => {
  path = tempLedgerPath("ask-bind-task-");
  const db = openLedger(path);
  const ctx = { actor: "owner", now: 1 };
  createItem(db, ctx, { project: "p", id: "i1", title: "x", status: "doing" });
  createItem(db, ctx, { project: "q", id: "j1", title: "x", status: "doing" });
  createTask(db, ctx, { project: "p", id: "TA", title: "A", kind: "code", itemId: "i1", agent: "agent-pm", stage: "build" }); // PM 本轮当前在做的卡
  createTask(db, ctx, { project: "p", id: "TB", title: "B", kind: "code", itemId: "i1", stage: "spec" });
  createTask(db, ctx, { project: "q", id: "TQ", title: "Q", kind: "code", itemId: "j1", stage: "spec" });
  const deps: AsksDeps = { clients: new Map([["111", { ws }]]), controlChannelId: "999", deliver: async (env) => ({ envelope: env, outcome: { kind: "sent" } }), hold: () => {} };
  setAsksForTest({ path, deps, registry: [{ name: "agent-pm", channelId: "111", status: "active", projectId: "p" } as RegistryAgent], ownerChats: ["api:owner:self"] });
  sent = [];
});
afterEach(() => {
  setAsksForTest(undefined);
  closeLedger(path);
});

async function reply(text: string, ask?: unknown): Promise<{ a: Ask | null; d: Delivery; env: Envelope }> {
  const env: Envelope = {
    from: { kind: "local", channelId: "111", ws }, to: { kind: "user", userId: "", channelId: "api:owner:self" }, intent: "response", content: text,
    meta: { messageId: `reply_${Math.random()}`, triggerKind: "agent_tool", ts: at, threadId: `thr_${Math.random()}`, components: BUTTONS },
  };
  const d = await deliverReplyWithAsk(env, "api:owner:self", "111", async (e) => (sent.push(e.content), { envelope: e, outcome: { kind: "sent", discordMessageIds: [] } }), ask);
  return { a: env.meta.askId ? getAsk(openLedger(path), env.meta.askId) : null, d, env };
}
const asks = () => listAsks(openLedger(path), { project: "p" }).length + listAsks(openLedger(path), { project: "q" }).length;
const pick = (a: Ask, id: string, now = Date.now()) =>
  answerAsk(openLedger(path), a.id, { choices: [`[button:${id}]`], labels: [id], text: "", principal: "owner:self", via: "web_card", at: now })!;

describe("任务型授权挂实际目标", () => {
  test("PM 当前在做 TA，先后授权 TA、TB：TB 卡台账 taskId / 卡面 / 投出去的那条都是 TB（旧行为挂成 TA）", async () => {
    const { a: a1 } = await reply("开 A 吗", { ...grant({ task: "TA" }), key: "start-a" });
    const { a: b, env } = await reply("开 B 吗", { ...grant({ task: "TB" }), key: "start-b" });
    expect(a1!.taskId).toBe("TA");
    expect(b!.taskId).toBe("TB");
    expect(b!.context.split("\n")[0]).toBe(`批准的就是这个 → ${renderBindSummary({ action: "task_start", params: { task: "TB" } })}`);
    expect(sent[1]).toContain("task=TB");
    expect(sent[1]).not.toContain("TA");
    expect(env.meta.askHash).toBe(bindHash({ action: "task_start", params: { task: "TB" } }, "agent-pm"));
    expect(getAsk(openLedger(path), a1!.id)!.state).toBe("open"); // 不同 key 互不取代
  });

  test("taskId 键同样认；task 与 taskId 写同一张也行", async () => {
    expect((await reply("x", grant({ taskId: "TB" }))).a!.taskId).toBe("TB");
    expect((await reply("x", { ...grant({ task: "TB", taskId: "TB" }), key: "k2" })).a!.taskId).toBe("TB");
  });

  test("没写任务的授权不挂卡、不猜成当前卡；peer 的卡（peer_accept）也不挂本机卡", async () => {
    expect((await reply("发版吗", grant({ tag: "v2" }))).a!.taskId).toBeNull();
    expect((await reply("接 D12 吗", { kind: "authorize", bind: { action: "peer_accept", params: { peer: "P", task: "D12" }, approve: ["go"] } })).a!.taskId).toBeNull();
  });

  test("冲突 / 跨项目 / 台账里没有 / 写法不对：整条退回，不建卡、不投递、不挑一个", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ task: "TA", taskId: "TB" }, /different tasks/],
      [{ task: "TQ" }, /belongs to project q, not p/],
      [{ task: "T404" }, /not in this ledger/],
      [{ task: 7 }, /must be a task id string/],
    ];
    for (const [params, re] of cases) {
      const { a, d } = await reply("批吗", grant(params));
      expect(a).toBeNull();
      expect(d.outcome).toMatchObject({ kind: "dropped" });
      expect((d.outcome as { reason: string }).reason).toMatch(re);
    }
    expect(sent).toEqual([]);
    expect(asks()).toBe(0);
  });

  test("普通非授权询问照旧挂当前在做的卡", async () => {
    expect((await reply("选哪个？", { kind: "decide" })).a!.taskId).toBe("TA");
    expect((await reply("选哪个？")).a!.taskId).toBe("TA"); // 隐式
  });
});

describe("点击 / ask-check 指向同一张卡", () => {
  const hashOf = (task: string) => bindHash({ action: "task_start", params: { task } }, "agent-pm");

  test("批 TB：TB 的参数过；拿 TA 的参数、点不批、过期、别的 agent 都拒", async () => {
    const { a } = await reply("开 B 吗", grant({ task: "TB" }));
    expect(checkAsk(getAsk(openLedger(path), a!.id), hashOf("TB"), "agent-pm").ok).toBe(false); // 没答
    const done = pick(a!, "go");
    expect(checkAsk(done, hashOf("TB"), "agent-pm")).toEqual({ ok: true });
    expect(checkAsk(done, hashOf("TA"), "agent-pm")).toMatchObject({ ok: false, reason: expect.stringMatching(/hash mismatch/) });
    expect(checkAsk(done, hashOf("TB"), "agent-x")).toMatchObject({ ok: false });
    expect(checkAsk(done, hashOf("TB"), "agent-pm", done.expiresAt + 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/window ended/) });
    const { a: n } = await reply("开 B 吗", { ...grant({ task: "TB" }), key: "nb" });
    expect(checkAsk(pick(n!, "no"), hashOf("TB"), "agent-pm")).toMatchObject({ ok: false, reason: expect.stringMatching(/without approving/) });
  });

  test("修复前错挂的卡（台账挂 TA、bind 批 TB）：点了批准 ask-check 也不认", () => {
    const bind = { action: "task_start", params: { task: "TB" }, approve: ["go"] };
    const { ask } = openAskFull(openLedger(path), {
      project: "p", taskId: "TA", fromAgent: "agent-pm", fromChannelId: "111", source: "reply", kind: "authorize", title: "开 B 吗", options: BUTTONS as never,
      bind: { ...bind, paramsHash: bindHash(bind, "agent-pm") }, askKey: "task_start",
    }, Date.now());
    expect(checkAsk(pick(ask, "go"), hashOf("TB"), "agent-pm")).toMatchObject({ ok: false, reason: expect.stringMatching(/linked to task TA/) });
  });
});
