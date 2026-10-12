/**
 * agents-PMJOB1 验收线 4–5：bridge 在排队后 / 运行中 / 草稿已写时重启都能把单和结果找回、没有第二个 worker 同时认领、不靠新流量；
 * 发送后回执丢失标 unknown 并升级、绝不重发；发前撤 ask / 结清单 / 换 PM / 改规格 / 切开关各挡住陈旧直回（本机与远端）；
 * 伪造的来源和单子过不了原有的 PM 回答校验。「重启」= 同一状态目录上新建一个 PmJobBridge。
 */
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { pmJob, PmJobBridge, PM_JOB_DEADLINE_MS } from "../src/bridge/pm-job.js";
import { closeAsk, getAsk } from "../src/lib/ledger-asks.js";
import { recordDefaultPmReply } from "../src/lib/order-ask-default.js";
import { switchProjectPm } from "../src/lib/pm-role-switch.js";
import type { CodexResult } from "../src/lib/codex.js";
import { A, ASKER, B, goodAnswer, jobWorld, lendOrder, P, REMOTE, type JobWorld } from "./pm-job-world.test.js";

let w: JobWorld;
afterEach(() => w?.close());
const Q = "验收线 1 的行数上限是多少？", LEND = "lend:T1:s1:r0:a0";
const restart = () => new PmJobBridge(w.jobDeps);
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

// [验收线 4]
test("restart after queueing, while running and after the draft: the job and its result are found again, answered exactly once", async () => {
  w = await jobWorld("on");
  const { askId } = await w.ask(Q);
  await restart().sweep(); // 排队后重启：单还在，bridge 不跑模型
  expect(w.store.get(askId)?.state).toBe("queued");
  expect(w.runs).toEqual([]);
  let release!: (r: CodexResult) => void;
  const first = w.work(() => new Promise<CodexResult>((r) => (release = r)));
  await until(() => w.runs.length === 1);
  expect(w.store.get(askId)).toMatchObject({ state: "running", lease: { pid: process.pid } });
  await restart().sweep(); // 运行中重启：worker 是独立进程，照常跑完
  expect(await w.work()).toBe(0); // 第二个 worker 领不到同一单
  expect(w.runs).toHaveLength(1);
  release({ ok: true, message: goodAnswer({ specPath: w.specPath }), sessionId: null, elapsedMs: 5 });
  expect(await first).toBe(1);
  expect(w.store.get(askId)).toMatchObject({ state: "drafted", result: { verdict: "answer" } });
  expect(w.asker).toEqual([]);
  restart().start(undefined, false); // 草稿已写时重启：启动就扫，不靠新流量
  await until(() => w.store.get(askId)?.pmNotice === "handed");
  await restart().sweep();
  expect(w.asker).toHaveLength(1);
  expect(w.asker[0]!.content).toContain(`ask ${askId}`);
  expect(w.pm).toEqual([]);
  expect(w.store.get(askId)?.state).toBe("sent");
  expect(getAsk(w.f.db, askId)?.answer?.principal).toBe("system:pm-job");
});

// [验收线 4]
test("a worker that died mid-run is not re-run: the next claim records the interruption and the PM gets the original with the draft", async () => {
  w = await jobWorld("on");
  const { askId } = await w.ask(Q);
  void w.work(() => new Promise<CodexResult>(() => {}), { leaseMs: 1000 }); // 永远不回来的那个 worker
  await until(() => w.runs.length === 1);
  w.advance(5000); // 租约过期
  expect(await w.work()).toBe(0);
  expect(w.runs).toHaveLength(1);
  expect(w.store.get(askId)).toMatchObject({ state: "drafted", result: { verdict: "escalate", reason: expect.stringContaining("中断") } });
  await restart().sweep();
  expect(w.asker).toEqual([]);
  expect(w.pm).toEqual([{ to: A, id: `ledger-ask:${askId}`, content: expect.stringContaining(w.store.draftPath(askId)) }]);
  expect(w.store.get(askId)?.state).toBe("escalated");
});

// [验收线 4]
test("a lost receipt after sending is marked unknown and escalated; nothing is ever sent again and the ask stays unanswered", async () => {
  w = await jobWorld("on");
  const local = await w.ask(Q);
  await w.work();
  // 本机：写了 sending 之后进程没了，回执没回来
  await w.store.update(local.askId, ["drafted"], w.now(), (j) => ({ ...j, state: "sending" }));
  await restart().sweep();
  await restart().sweep();
  expect(w.store.get(local.askId)).toMatchObject({ state: "unknown", pmNotice: "handed" });
  expect(w.asker).toEqual([]);
  expect(w.pm).toHaveLength(1);
  expect(w.pm[0]).toMatchObject({ to: A, id: `ledger-ask:${local.askId}` });
  expect(w.pm[0]!.content).toContain("结果不明");
  expect(getAsk(w.f.db, local.askId)?.state).toBe("open");
  // 远端：对方没明确收下 / 网络出错
  lendOrder(w.f.db, LEND, "write", "claimed");
  for (const tell of [async () => false, async () => { throw new Error("socket hang up"); }]) {
    const r = await w.ask(`${Q}（${w.pm.length}）`, { from: REMOTE, orderId: LEND });
    await w.work();
    let calls = 0;
    const bridge = new PmJobBridge({ ...w.jobDeps, tell: (a, t) => (calls++, tell()) });
    await bridge.sweep();
    await bridge.sweep();
    await restart().sweep();
    expect(calls).toBe(1);
    expect(w.store.get(r.askId)?.state).toBe("unknown");
    expect(getAsk(w.f.db, r.askId)?.state).toBe("open");
    expect(w.pm.at(-1)).toMatchObject({ to: A, id: `ledger-ask:${r.askId}` });
  }
  expect(w.remote).toEqual([]);
});

type Guard = [name: string, act: (askId: string, orderId: string) => unknown | Promise<unknown>, end: "dropped" | "escalated", pm: string | null];
const GUARDS: Guard[] = [
  ["撤 ask", (id) => closeAsk(w.f.db, id, "cancelled", "执行者撤回"), "dropped", null],
  ["PM 先答了", (id) => recordDefaultPmReply(() => w.f.db, { agent: A, verified: true }, "agent-nobody", `ask ${id}`).length
    || w.f.db.prepare("UPDATE asks SET state = 'answered' WHERE id = ?").run(id), "dropped", null],
  ["结清单", (_, order) => w.f.db.prepare("UPDATE lend_orders SET status = 'done' WHERE orderId = ?").run(order), "escalated", A],
  ["换 PM", () => switchProjectPm(w.f.db, P, B, { actor: "owner" }, w.f.deps), "escalated", B],
  ["改规格", () => writeFileSync(w.specPath, `${readFileSync(w.specPath, "utf8")}\n9. 新加一条\n`), "escalated", A],
  ["切 off", () => w.store.setMode(P, "off"), "escalated", A],
  ["切走又切回 on（模式世代变了）", () => (w.store.setMode(P, "observe"), w.store.setMode(P, "on")), "escalated", A],
];

for (const [side, from] of [["本机", ASKER], ["远端", REMOTE]] as const) {
  for (const [name, act, end, pm] of GUARDS) {
    // [验收线 5]
    test(`${side}：发前${name}，陈旧的代答不发`, async () => {
      w = await jobWorld("on");
      lendOrder(w.f.db, LEND, "write", "claimed");
      const { askId } = await w.ask(Q, { from, orderId: LEND });
      expect(w.store.get(askId)).toMatchObject({ direct: true, target: from });
      await w.work();
      expect(w.store.get(askId)).toMatchObject({ state: "drafted", result: { verdict: "answer" } });
      await act(askId, LEND);
      await pmJob.sweep();
      await restart().sweep();
      expect(w.asker).toEqual([]);
      expect(w.remote).toEqual([]);
      expect(w.store.get(askId)?.state).toBe(end);
      expect(getAsk(w.f.db, askId)?.answer?.principal).not.toBe("system:pm-job");
      expect(w.pm.map((m) => [m.to, m.id])).toEqual(pm ? [[pm, `ledger-ask:${askId}`]] : []);
      if (pm) expect(w.pm[0]!.content).toContain(w.store.draftPath(askId));
    });
  }
}

// [验收线 5]
test("a forged sender or a forged job cannot answer: the PM-reply check and the job's binding to its one ask both hold", async () => {
  w = await jobWorld("on");
  const one = await w.ask(Q), two = await w.ask("src/lib/thing.ts 里 b 在哪一行？");
  await w.work();
  // 冒充处理员 / 未验证身份走原有的 PM 回答口：都不结案
  for (const who of [{ agent: "system:pm-job", verified: true }, { agent: "pm-job", verified: true }, { agent: A, verified: false }, { agent: ASKER, verified: true }]) {
    expect(recordDefaultPmReply(() => w.f.db, who, ASKER, `ask ${one.askId} 处理员代答`)).toEqual([]);
  }
  expect(getAsk(w.f.db, one.askId)?.state).toBe("open");
  // 伪造单子：把 one 的结果搬到 two 的文件名下（编号对不上 = 当没有）；把 two 的提问者改成别人（与台账对不上 = 不发、升级）
  const forged = { ...w.store.get(one.askId)!, target: "agent-intruder" };
  writeFileSync(w.store.path(two.askId), JSON.stringify(forged));
  expect(w.store.get(two.askId)).toBeNull();
  writeFileSync(w.store.path(two.askId), JSON.stringify({ ...forged, askId: two.askId, messageId: `ledger-ask:${two.askId}` }));
  writeFileSync(w.store.path(one.askId), JSON.stringify({ ...w.store.get(one.askId)!, askId: one.askId, card: "T-other" }));
  await pmJob.sweep();
  expect(w.asker).toEqual([]);
  expect(w.store.list().map((j) => j.state)).toEqual(["escalated", "escalated"]);
  expect(w.pm.map((m) => m.to)).toEqual([A, A]);
  for (const id of [one.askId, two.askId]) expect(getAsk(w.f.db, id)).toMatchObject({ state: "open", answer: null });
});

// [验收线 4]
test("a job nobody finished by the deadline is escalated by the bridge alone; a late worker result is discarded", async () => {
  w = await jobWorld("on");
  const { askId } = await w.ask(Q);
  let release!: (r: CodexResult) => void;
  const late = w.work(() => new Promise<CodexResult>((r) => (release = r)));
  await until(() => w.runs.length === 1);
  w.advance(PM_JOB_DEADLINE_MS);
  await restart().sweep();
  expect(w.store.get(askId)).toMatchObject({ state: "escalated", note: expect.stringContaining("超时") });
  expect(w.pm).toHaveLength(1);
  release({ ok: true, message: goodAnswer({ specPath: w.specPath }), sessionId: null, elapsedMs: 5 });
  await late;
  await restart().sweep();
  expect(w.store.get(askId)?.state).toBe("escalated");
  expect(w.asker).toEqual([]);
  expect(w.pm).toHaveLength(1);
});
