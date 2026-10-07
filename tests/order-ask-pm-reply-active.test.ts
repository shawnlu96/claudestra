/**
 * ASKPM2：PM 作答按当班 PM 认。卡上 task.pm = A、提问 extra.parent = A，当班 PM 切成 B（meta.activePm，pm-role-switch.ts 写的同一行）：
 * B 用 send_to_agent 带 `ask <id>` 回（bridge 投递成功后调 recordDefaultPmReply）→ answered，合并闸（manual-merge-queue-facts.ts
 * requestRefusal 的同一个查询）不再报「审批未答」。旧代码按字面名字比对：提问保持 open（红）。
 * 反例：发送方是名单里非当班的 PM、parent 不在 PM 名单、task.pm 不在名单、owner 专属的提问、没验证 / 目标不对 / 没带 id → open。
 */
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { getAsk, openAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { getTask } from "../src/lib/ledger-store.js";
import { setMeta, setTask } from "../src/lib/ledger-write.js";
import { listRequests, requestRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { recordDefaultPmReply } from "../src/lib/order-ask-default.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { reclaimWorld, type ReclaimWorld } from "./scheduler-merge-reclaim-world.js";
import { ledgerAs, manualCard, requestArgs, writePolicy } from "./manual-merge-queue-world.test.js";

const A = "agent-claudestra", B = "agent-pm-codex", C = "agent-pm-other", AUTHOR = "agent-author";
let w: ReclaimWorld;
afterEach(() => { w?.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

/** 卡在 A 当班时开出（task.pm = A），之后当班 PM 切成 B */
async function setup() {
  w = reclaimWorld({ store: "memory" });
  setMeta(w.db, { actor: "owner", now: 1 }, { project: "p", key: "pms", value: [A, B, C] });
  writePolicy("on");
  const m = await manualCard(w, "M", A);
  setTask(w.db, { actor: "owner" }, { id: "M", rev: getTask(w.db, "M")!.rev, patch: { pm: A } });
  for (const [key, value] of [["activePm", B], ["pms", [B, A, C]]] as const) {
    w.db.query("INSERT INTO meta(project,key,value) VALUES(?,?,?) ON CONFLICT(project,key) DO UPDATE SET value=excluded.value").run("p", key, JSON.stringify(value));
  }
  return m;
}

const replyAsk = (o: Partial<NewAsk> & { extra?: Record<string, unknown> } = {}) => openAsk(w.db, { project: "p", taskId: "M", source: "reply",
  kind: "decide", fromAgent: AUTHOR, title: "需要扩围 1 行", body: "需要扩围 1 行", chatId: "ch-author",
  options: [{ type: "buttons", buttons: [{ id: "ok", label: "批准" }, { id: "no", label: "不批" }] }], extra: { parent: A }, ...o } as NewAsk);

const gate = () => requestRefusal(w.db, listRequests(w.db, "p", "M")[0], Date.now(), false, () => false);
const as = (agent: string, verified = true) => ({ agent, verified });

test("old red / new green: after the PM switch the on-duty PM B answers an ask the card files under A; the merge gate stops waiting", async () => {
  const m = await setup();
  const a = replyAsk();
  expect(await ledgerAs(w, B, ...requestArgs(m))).toMatchObject({ ok: true, state: "waiting", why: expect.stringMatching(/审批未答/) });
  const body = `ask ${a.id}:批准`;
  expect(recordDefaultPmReply(() => w.db, as(B), AUTHOR, body)).toEqual([a.id]); // 旧代码：[]，提问 open
  expect(getAsk(w.db, a.id)).toMatchObject({ state: "answered", answer: { labels: ["PM 已回复"], text: body, principal: B } });
  expect(gate()?.why ?? "").not.toMatch(/审批未答/);
  // 字面相等照旧成立：A 本人回自己名下的提问
  const b = replyAsk();
  expect(recordDefaultPmReply(() => w.db, as(A), AUTHOR, `ask ${b.id} 好`)).toEqual([b.id]);
});

test("not the on-duty PM, or a name outside the PM list, or anything ASKPM1 refuses: the ask stays open", async () => {
  const m = await setup();
  await ledgerAs(w, B, ...requestArgs(m));
  const cases: [Partial<NewAsk> & { extra?: Record<string, unknown> }, ReturnType<typeof as>, string, (id: string) => string][] = [
    [{}, as(C), AUTHOR, (id) => `ask ${id}`], // 名单里但不当班
    [{ extra: { parent: "agent-somebody" } }, as(B), AUTHOR, (id) => `ask ${id}`], // parent 不在 PM 名单
    [{ extra: { parent: C } }, as(C), AUTHOR, (id) => `ask ${id}`], // parent 是发送方本人，但卡上的 PM 是 A、C 不当班
    [{ kind: "authorize" }, as(B), AUTHOR, (id) => `ask ${id}`],
    [{ kind: "owner_action" }, as(B), AUTHOR, (id) => `ask ${id}`],
    [{ kind: "accept" }, as(B), AUTHOR, (id) => `ask ${id}`],
    [{}, as(B, false), AUTHOR, (id) => `ask ${id}`], // 身份没验证
    [{}, as(B), "agent-other", (id) => `ask ${id}`], // 目标不是提问的 agent
    [{}, as(B), AUTHOR, () => "批准"], // 没带 ask <id>
  ];
  for (const [o, who, target, body] of cases) {
    const a = replyAsk(o);
    expect(recordDefaultPmReply(() => w.db, who, target, body(a.id))).toEqual([]);
    expect(getAsk(w.db, a.id)?.state).toBe("open");
  }
  // 卡上写的 PM 不在名单里：当班 PM 也不认
  setTask(w.db, { actor: "owner" }, { id: "M", rev: getTask(w.db, "M")!.rev, patch: { pm: "agent-gone" } });
  const gone = replyAsk({ extra: { parent: "agent-gone" } });
  expect(recordDefaultPmReply(() => w.db, as(B), AUTHOR, `ask ${gone.id}`)).toEqual([]);
  expect(getAsk(w.db, gone.id)?.state).toBe("open");
  expect(gate()).toMatchObject({ kind: "wait", why: expect.stringMatching(/审批未答/) });
});
