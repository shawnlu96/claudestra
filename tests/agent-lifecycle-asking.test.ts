/**
 * ASKPM2：有未答提问的执行者不按闲置回收。真实台账 schema 的临时台账 + 生产的 askingAgents / ledgerFacts / cardWorkerIndex 接法。
 * 10-07 形状：人工合并卡（merge）的作者有一条问 PM 的 open 提问，swap 84% 超过 70%，闲置 0.5h。
 * 旧代码（没有 asking）：进 memory 候选（红）；新代码：记 kept「有未答提问 <id>，等答复」（绿）。
 * 反例：卡已 verified → 照旧 card_finished；提问已 answered / 已过期 → 照旧按 memory 收；读提问失败 → 本轮不出计划。
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIFECYCLE } from "../src/lib/agent-lifecycle-config.js";
import { askingAgents, ledgerFacts } from "../src/lib/agent-lifecycle-deps.js";
import { cardWorkerIndex, registerWorker } from "../src/lib/agent-lifecycle-store.js";
import { planLifecycle, type AgentFacts, type PlanInput } from "../src/lib/agent-lifecycle.js";
import { answerAsk, openAsk, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";

const H = 3_600_000, NOW = Date.now();
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "askpm2-life-")), path = join(dir, "ledger.sqlite"), db = openLedger(path);
  cleanup.push(() => { closeLedger(path); rmSync(dir, { recursive: true, force: true }); });
  db.query("INSERT INTO meta (project, key, value) VALUES ('p', 'pms', '[\"agent-pm\"]')").run();
  const card = (id: string, stage: string) => {
    createTask(db, { actor: "owner", now: 1000 }, { project: "p", id, title: id, kind: "code" });
    db.query("UPDATE tasks SET stage = ? WHERE id = ?").run(stage, id);
  };
  return { db, card };
}

const agent = (name: string, idleH: number, more: Partial<AgentFacts> = {}): AgentFacts =>
  ({ name, status: "active", sessionId: "s", running: true, idleMs: idleH * H, turnActive: false, ...more });

const ask = (db: ReturnType<typeof ledger>["db"], o: Partial<NewAsk> = {}) => openAsk(db, { project: "p", taskId: "M", source: "reply", kind: "decide",
  fromAgent: "author", title: "需要扩围 1 行", body: "需要扩围 1 行", chatId: "ch", extra: { parent: "agent-pm" }, ...o } as NewAsk, NOW - H / 2);

/** 生产接法：lifecycleSnapshot 里的同一组读法；old = 没有 asking 的旧输入 */
const input = (db: ReturnType<typeof ledger>["db"], agents: AgentFacts[], old = false): PlanInput => ({ now: NOW, policy: { ...DEFAULT_LIFECYCLE },
  agents, index: cardWorkerIndex(db), ...ledgerFacts(db), foreign: new Set(), master: new Set(["master"]), swapPct: 84,
  ...(old ? {} : { asking: askingAgents(db, NOW) }) });

test("old red / new green: a manual card's author with an open ask is kept (not a memory candidate) while swap is over the line", () => {
  const { db, card } = ledger();
  card("M", "merge");
  registerWorker(db, { agent: "author", sessionId: "s", taskId: "M", role: "author", createdBy: "agent-pm", now: 1 });
  const a = ask(db);
  const old = planLifecycle(input(db, [agent("author", 0.5)], true));
  expect(old.memory.map((x) => [x.agent, x.rule])).toEqual([["author", "memory"]]); // 旧代码：10-07 13:13 收掉的就是它
  const plan = planLifecycle(input(db, [agent("author", 0.5)]));
  expect([plan.actions, plan.memory]).toEqual([[], []]);
  expect(plan.kept).toEqual([{ agent: "author", reason: `有未答提问 ${a.id}，等答复` }]);
});

test("author_idle and reviewer_done do not collect an agent waiting on its ask either", () => {
  const { db, card } = ledger();
  card("M", "merge"); card("R", "fix");
  registerWorker(db, { agent: "author", sessionId: "s", taskId: "M", role: "author", createdBy: "agent-pm", now: 1 });
  registerWorker(db, { agent: "rv", sessionId: "s", taskId: "R", role: "reviewer", createdBy: "agent-pm", now: 2 });
  ask(db); ask(db, { taskId: "R", fromAgent: "rv" });
  const agents = [agent("author", 9), agent("rv", 9)];
  expect(planLifecycle(input(db, agents, true)).actions.map((x) => [x.agent, x.rule])).toEqual([["author", "author_idle"], ["rv", "reviewer_done"]]);
  const plan = planLifecycle(input(db, agents));
  expect([plan.actions, plan.memory, plan.kept.map((k) => k.agent)]).toEqual([[], [], ["author", "rv"]]);
});

test("counter-examples: finished card still collected; answered / expired ask, or one on a finished card, does not keep it", () => {
  const { db, card } = ledger();
  card("M", "verified");
  registerWorker(db, { agent: "author", sessionId: "s", taskId: "M", role: "author", createdBy: "agent-pm", now: 1 });
  ask(db);
  expect(planLifecycle(input(db, [agent("author", 0.5)])).actions.map((x) => [x.agent, x.rule])).toEqual([["author", "card_finished"]]);

  const w = ledger();
  w.card("M", "merge"); w.card("D", "done");
  registerWorker(w.db, { agent: "author", sessionId: "s", taskId: "M", role: "author", createdBy: "agent-pm", now: 1 });
  const a = ask(w.db);
  answerAsk(w.db, a.id, { choices: [], labels: ["PM 已回复"], text: `ask ${a.id} 好`, principal: "agent-pm", via: "terminal", at: NOW, final: true });
  ask(w.db, { expiresAt: NOW - 1 }); // 过期没扫的
  ask(w.db, { taskId: "D" }); // 挂在已结束的卡上
  const plan = planLifecycle(input(w.db, [agent("author", 0.5)]));
  expect([plan.kept, plan.memory.map((x) => [x.agent, x.rule])]).toEqual([[], [["author", "memory"]]]);
});

// lifecycleSnapshot builds the plan input with askingAgents(db, now) uncaught (as lendAgents): a throw here rejects the snapshot,
// lifecycleStep reports it as the step's error and carries out nothing
test("asks unreadable: askingAgents throws instead of reading as 'no asks'", () => {
  const { db, card } = ledger();
  card("M", "merge");
  db.exec("DROP TABLE asks; CREATE TABLE asks (id TEXT)");
  expect(() => askingAgents(db, NOW)).toThrow();
});
