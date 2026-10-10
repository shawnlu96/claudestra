/**
 * ASKPM1：执行者用 reply 按钮问本卡 PM 的提问，PM 用 send_to_agent 带 `ask <id>` 回（bridge 投递成功后调 recordDefaultPmReply）就结清，
 * 卡上的人工合并请求不再停在「审批未答」（manual-merge-queue-facts.ts requestRefusal 的同一个查询）。真实台账 + MTR1 世界 + 真实 ledger CLI。
 * 反例逐条保持 open。旧代码：第一条测试红（提问仍 open、合并闸报审批未答）。
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getAsk, openAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { setMeta, setTask } from "../src/lib/ledger-write.js";
import { getTask } from "../src/lib/ledger-store.js";
import { listRequests, requestRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { recordDefaultPmReply } from "../src/lib/order-ask-default.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const PM = "agent-pm", DISP = "agent-disp", AUTHOR = "agent-author";
const pm = { agent: PM, verified: true };
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

async function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [PM, DISP] });
  writePolicy("on");
  return manualCard(w, "M");
}

/** 执行者 reply 带按钮问 PM 的那条（AUTOFAIR1 10-07 的形状） */
const replyAsk = (o: Partial<NewAsk> & { extra?: Record<string, unknown> } = {}) => openAsk(w.db, { project: "p", taskId: "M", source: "reply",
  kind: "decide", fromAgent: AUTHOR, title: "需要扩围 1 行", body: "需要扩围 1 行:tests/scheduler-observe.test.ts", chatId: "ch-author",
  options: [{ type: "buttons", buttons: [{ id: "ok", label: "批准" }, { id: "no", label: "不批" }] }], extra: { parent: PM }, ...o } as NewAsk);

const gate = () => requestRefusal(w.db, listRequests(w.db, "p", "M")[0], Date.now(), false, () => false);

test("PM's send_to_agent with `ask <id>` closes the executor's button ask to PM; the manual merge request no longer waits on it", async () => {
  const m = await setup();
  const a = replyAsk();
  expect(await ledgerAs(w, PM, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/审批未答/) });
  const body = `ask ${a.id}:批准，tests/scheduler-observe.test.ts 加 1 行`;
  expect(recordDefaultPmReply(() => w.db, pm, AUTHOR, body)).toEqual([a.id]);
  expect(getAsk(w.db, a.id)).toMatchObject({ state: "answered", answer: { labels: ["PM 已回复"], text: body, principal: PM } });
  expect(gate()?.why ?? "").not.toMatch(/审批未答/);
  // 卡没写 task.pm 时取项目 PM 名单第一位；写了就认 task.pm
  const t = getTask(w.db, "M")!;
  setTask(w.db, { actor: "owner" }, { id: "M", rev: t.rev, patch: { pm: DISP } });
  const b = replyAsk({ extra: { parent: DISP } });
  expect(recordDefaultPmReply(() => w.db, { agent: DISP, verified: true }, "author", `ask ${b.id} 好`)).toEqual([b.id]);
});

test("everything else stays open and keeps the merge gate waiting", async () => {
  const m = await setup();
  await ledgerAs(w, PM, ...requestArgs(m));
  const cases: [Record<string, unknown>, typeof pm, string, (id: string) => string][] = [
    [{ kind: "authorize" }, pm, AUTHOR, (id) => `ask ${id}`],
    [{ kind: "owner_action" }, pm, AUTHOR, (id) => `ask ${id}`],
    [{ kind: "accept" }, pm, AUTHOR, (id) => `ask ${id}`],
    [{}, { ...pm, verified: false }, AUTHOR, (id) => `ask ${id}`], // 身份没验证
    [{ extra: { parent: DISP } }, { agent: DISP, verified: true }, AUTHOR, (id) => `ask ${id}`], // 发送方是 parent 但不是本卡 PM
    [{}, { agent: DISP, verified: true }, AUTHOR, (id) => `ask ${id}`], // 发送方不是本卡 PM
    [{}, pm, "agent-other", (id) => `ask ${id}`], // 目标不是提问的 agent
    [{ extra: {} }, pm, AUTHOR, (id) => `ask ${id}`], // extra.parent 缺失
    [{ extra: { parent: "agent-other" } }, pm, AUTHOR, (id) => `ask ${id}`], // extra.parent 是别人
    [{}, pm, AUTHOR, () => "批准"], // 正文没带 ask <id>
    [{}, pm, AUTHOR, (id) => id], // 只有 id 没有 ask 前缀
  ];
  for (const [o, who, target, body] of cases) {
    const a = replyAsk(o as Partial<NewAsk>);
    expect(recordDefaultPmReply(() => w.db, who, target, body(a.id))).toEqual([]);
    expect(getAsk(w.db, a.id)?.state).toBe("open");
  }
  // 没挂卡：同样的 PM、同样的目标、同样的正文也不结清
  const loose = replyAsk({ taskId: null });
  expect(recordDefaultPmReply(() => w.db, pm, AUTHOR, `ask ${loose.id}`)).toEqual([]);
  expect(getAsk(w.db, loose.id)?.state).toBe("open");
  expect(gate()).toMatchObject({ kind: "wait", why: expect.stringMatching(/审批未答/) });
});
