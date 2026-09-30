/** 「待你处理」库的生命周期（lib/ledger-asks.ts）：建 → 答 → 再答被拒；到期；撤销；事件只追加；v1 库升级 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  answerAsk, ASK_TTL_MS, closeAsk, dueAsks, findAskByDiscordMessage, getAsk, hasAsksTable, listAsks, openAsk, openAskFull, patchAsk, type AskAnswer, type NewAsk,
} from "../src/lib/ledger-asks.js";
import { migrateAsksV2 } from "../src/lib/ledger-asks-schema.js";
import { STEPS_SCHEMA } from "../src/lib/ledger-steps.js";
import { SCHEDULER_SCHEMA, SCHEDULER_SESSIONS_SCHEMA, SCHEDULER_MERGES_SCHEMA } from "../src/lib/ledger-scheduler-schema.js";
import { DAG_REWRITE_SCHEMA, FEATURE_SCHEMA } from "../src/lib/ledger-feature-schema.js";
import { LEND_SCHEMA } from "../src/lib/ledger-lend-schema.js";
import { projectView } from "../src/lib/ledger-read.js";
import { closeLedger, LEDGER_MIGRATIONS, LEDGER_SCHEMA_VERSION, LedgerError, listEvents, openLedger, schemaVersion } from "../src/lib/ledger-store.js";
import { appendEvent, createItem, createTask } from "../src/lib/ledger-write.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let path = "";
afterEach(() => closeLedger(path));

const base: NewAsk = { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发 v2.31.0 吗", taskId: "T9" };
const ans = (at: number, extra: Partial<AskAnswer> = {}): AskAnswer => ({ choices: ["[button:go]"], labels: ["发"], text: "", principal: "owner:self", via: "web_card", at, ...extra });

function db() {
  path = tempLedgerPath("ledger-asks-");
  return openLedger(path);
}

describe("ask 生命周期", () => {
  test("建：state open、默认有效期按 kind、blocking 缺省为 null；同时追加一条 ask 事件（actor = 发起方，target = 任务）", () => {
    const d = db();
    const a = openAsk(d, { ...base, options: [{ type: "buttons", buttons: [{ id: "go", label: "发" }] }] }, 1000);
    expect(a).toMatchObject({ state: "open", blocking: null, allowText: true, expiresAt: 1000 + ASK_TTL_MS.decide, answer: null, discordMessageIds: [] });
    expect(a.id).toMatch(/^ask_/);
    expect(a.options).toHaveLength(1);
    const evs = listEvents(d, { project: "p" });
    expect(evs.map((e) => [e.kind, e.actor, e.target, e.data.askId])).toEqual([["ask", "agent-x", "T9", a.id]]);
  });

  test("答：open → answered，同一事务追加 decision 事件（actor = 作答的凭据）；再答一次 → conflict，库里保持第一次的答案", () => {
    const d = db();
    const a = openAsk(d, base, 1000);
    const out = answerAsk(d, a.id, ans(2000, { text: "只做 Codex" }));
    expect(out).toMatchObject({ state: "answered", answer: { choices: ["[button:go]"], text: "只做 Codex", via: "web_card" } });
    const dec = listEvents(d, { project: "p" }).filter((e) => e.kind === "decision");
    expect(dec).toHaveLength(1);
    // decision 记人话（按钮文字 + 原话），wire 原文放在 data 里
    expect(dec[0]).toMatchObject({ actor: "owner:self", target: "T9", text: "发 「只做 Codex」", data: { askId: a.id, ownerWords: "只做 Codex", choices: ["[button:go]"], labels: ["发"] } });
    let err: unknown;
    try {
      answerAsk(d, a.id, ans(3000, { choices: ["[button:no]"], via: "discord" }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LedgerError);
    expect((err as LedgerError).code).toBe("conflict");
    expect((err as LedgerError).current).toMatchObject({ state: "answered" });
    expect(getAsk(d, a.id)?.answer?.via).toBe("web_card");
  });

  test("过期：到点还没扫的，作答时先记 expired（事务提交、事件落下）再报 conflict；扫描能找出到期的", () => {
    const d = db();
    const a = openAsk(d, { ...base, expiresAt: 5000 }, 1000);
    expect(dueAsks(d, 4999)).toHaveLength(0);
    expect(dueAsks(d, 5000).map((x) => x.id)).toEqual([a.id]);
    let err: LedgerError | undefined;
    try {
      answerAsk(d, a.id, ans(6000));
    } catch (e) {
      err = e as LedgerError;
    }
    expect(err?.current).toMatchObject({ state: "expired", expiredNow: true });
    expect(getAsk(d, a.id)?.state).toBe("expired");
    expect(listEvents(d, { project: "p" }).map((e) => e.kind)).toEqual(["ask", "ask_expire"]);
    expect(dueAsks(d, 9999)).toHaveLength(0);
  });

  test("closeAsk：cancelled 带原因记 ask_cancel；已结案的再关返回 null、不重复记事件", () => {
    const d = db();
    const a = openAsk(d, base, 1000);
    expect(closeAsk(d, a.id, "cancelled", "reply 没发出去", 1500)?.state).toBe("cancelled");
    expect(closeAsk(d, a.id, "expired", "", 1600)).toBeNull();
    const kinds = listEvents(d, { project: "p" }).map((e) => [e.kind, e.data.reason ?? null]);
    expect(kinds).toEqual([["ask", null], ["ask_cancel", "reply 没发出去"]]);
  });

  test("patchAsk 补记 Discord 消息 id；按任意一条消息 id 都能找回", () => {
    const d = db();
    const a = openAsk(d, base, 1000);
    patchAsk(d, a.id, { discordMessageIds: ["m1", "m2"], outboxMessageId: "ask_1" }, 1100);
    expect(findAskByDiscordMessage(d, "m2")?.id).toBe(a.id);
    expect(findAskByDiscordMessage(d, "m3")).toBeNull();
    expect(getAsk(d, a.id)?.outboxMessageId).toBe("ask_1");
  });

  test("listAsks：开着的按等待时长在前，已结案的按最近处理在后；closedSince 只留最近处理过的", () => {
    const d = db();
    const old = openAsk(d, base, 1000);
    const newer = openAsk(d, base, 2000);
    const done = openAsk(d, base, 500);
    answerAsk(d, done.id, ans(3000));
    const stale = openAsk(d, base, 100);
    closeAsk(d, stale.id, "cancelled", "", 200);
    expect(listAsks(d, { project: "p" }).map((a) => a.id)).toEqual([old.id, newer.id, done.id, stale.id]);
    expect(listAsks(d, { project: "p", closedSince: 1000 }).map((a) => a.id)).toEqual([old.id, newer.id, done.id]);
    expect(listAsks(d, { project: "q" })).toEqual([]);
  });
});

describe("多行 reply：逐行作答", () => {
  const rows = [
    { type: "select", id: "model", options: [{ label: "Opus", value: "opus" }, { label: "Sonnet", value: "sonnet" }] },
    { type: "select", id: "effort", options: [{ label: "high", value: "high" }] },
    { type: "buttons", buttons: [{ id: "go", label: "开干" }] },
    { type: "buttons", buttons: [{ id: "later", label: "再说" }] },
  ];
  const row = (at: number, w: string, l: string, extra: Partial<AskAnswer> = {}) => ans(at, { choices: [w], labels: [l], ...extra });

  test("每组答一次：部分答案累积、状态仍 open；所有组答完才 answered；同一组再答 → conflict(dup)；两行按钮各算一组", () => {
    const d = db();
    const a = openAsk(d, { ...base, options: rows }, 1000);
    expect(answerAsk(d, a.id, row(2000, "[select:model:opus]", "Opus")).state).toBe("open");
    let err: LedgerError | undefined;
    try {
      answerAsk(d, a.id, row(2100, "[select:model:sonnet]", "Sonnet"));
    } catch (e) {
      err = e as LedgerError;
    }
    expect(err?.current).toMatchObject({ dup: true, state: "open" });
    expect(answerAsk(d, a.id, row(2200, "[button:later]", "再说")).state).toBe("open");
    expect(answerAsk(d, a.id, row(2250, "[select:effort:high]", "high", { text: "先这样" })).state).toBe("open");
    const done = answerAsk(d, a.id, row(2300, "[button:go]", "开干"));
    expect(done).toMatchObject({ state: "answered", answer: { choices: ["[select:model:opus]", "[button:later]", "[select:effort:high]", "[button:go]"], text: "先这样" } });
    const dec = listEvents(d, { project: "p" }).filter((e) => e.kind === "decision");
    expect(dec.map((e) => e.data.partial)).toEqual([true, true, true, false]);
    // decision 的 actor 是作答的凭据，不写死 owner
    expect(dec[0].actor).toBe("owner:self");
  });

  test("卡片一次提交（final）或只写了话：不管还有没有没答的组都结案", () => {
    const d = db();
    const a = openAsk(d, { ...base, options: rows }, 1000);
    expect(answerAsk(d, a.id, row(2000, "[button:go]", "开干", { final: true })).state).toBe("answered");
    const b = openAsk(d, { ...base, options: rows }, 1000);
    expect(answerAsk(d, b.id, ans(2000, { choices: [], labels: [], text: "都不要，换个思路" })).state).toBe("answered");
  });
});

describe("台账读侧不被 ask 事件盖掉", () => {
  test("挂在任务上的 ask / 撤销 / 作答不算任务的最近一条；没挂任务的 ask 不挤进项目级事件", () => {
    const d = db();
    createItem(d, { actor: "owner", now: 1 }, { project: "p", id: "i1", title: "x", status: "doing" });
    createTask(d, { actor: "owner", now: 2 }, { project: "p", id: "T9", title: "t", kind: "code", itemId: "i1", agent: "agent-x" });
    appendEvent(d, { actor: "owner", now: 3 }, { project: "p", target: "T9", kind: "note", text: "任务上的最近一条" });
    appendEvent(d, { actor: "owner", now: 4 }, { project: "p", target: "", kind: "note", text: "项目级" });
    const onTask = openAsk(d, base, 5);
    answerAsk(d, onTask.id, ans(6));
    closeAsk(d, openAsk(d, base, 7).id, "cancelled", "", 8);
    for (let i = 0; i < 25; i++) openAsk(d, { ...base, taskId: undefined, title: `q${i}` }, 10 + i);
    const v = projectView(d, "p", 100);
    expect(v.tasks[0].lastEvent).toMatchObject({ kind: "note", text: "任务上的最近一条" });
    expect(v.projectEvents.map((e) => e.kind)).toEqual(["note"]);
  });
});

/** 按 v1 的建表语句逐条建（迁移一律单条语句，见 tests/ledger-migrate.test.ts） */
function makeV1(raw: Database): void {
  for (const sql of LEDGER_MIGRATIONS[0] as readonly string[]) raw.prepare(sql).run();
}

describe("迁移", () => {
  test("版本号说到了、asks 表却不在（别的分支的代码先占了号）→ 打开时按表 / 列核对补齐", () => {
    path = tempLedgerPath("ledger-asks-broken-");
    const raw = new Database(path);
    makeV1(raw);
    raw.exec(`PRAGMA user_version = ${LEDGER_MIGRATIONS.length}`);
    raw.close();
    const d = openLedger(path);
    expect(hasAsksTable(d)).toBe(true);
    expect(schemaVersion(d)).toBe(LEDGER_MIGRATIONS.length);
  });

  test("v1 的库（CLI 旧版建的）打开后补上 asks 表，已有数据不动", () => {
    path = tempLedgerPath("ledger-asks-v1-");
    const raw = new Database(path);
    // 用真的 v1 建库语句造旧库：后面的迁移步（别的分支追加的 ALTER TABLE tasks 之类）要有完整的 v1 表才跑得通
    makeV1(raw);
    raw.exec("PRAGMA user_version = 1");
    raw.exec("INSERT INTO items (project, id, title, status, createdAt, updatedAt) VALUES ('p', 'i1', 'x', 'todo', 0, 0)");
    expect(hasAsksTable(raw)).toBe(false);
    raw.close();
    const d = openLedger(path);
    expect(schemaVersion(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(LEDGER_SCHEMA_VERSION).toBe(LEDGER_MIGRATIONS.length);
    expect(hasAsksTable(d)).toBe(true);
    expect(d.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 1 });
  });
});

describe("第二版：人 / 系统发起、指派、按 key 取代、去重", () => {
  test("人发起的指派事项：fromAgent 为空、默认 72 小时、事件 actor 是发起人；作答的 decision actor 是作答的人，答案带附件引用", () => {
    const d = db();
    const a = openAsk(d, { project: "p", source: "human", createdBy: "owner:self", kind: "assigned", title: "画登录页", assignee: "local:guest:aa11", taskId: "T9" }, 1000);
    expect(a).toMatchObject({ fromAgent: null, fromChannelId: null, assignee: "local:guest:aa11", expiresAt: 1000 + 72 * 3600_000 });
    const out = answerAsk(d, a.id, ans(2000, { choices: ["[button:assign_done]"], principal: "guest:aa11", atts: [{ kind: "talk", ref: "att_1", name: "a.png" }] }));
    expect(out.answer?.atts).toEqual([{ kind: "talk", ref: "att_1", name: "a.png" }]);
    const evs = listEvents(d, { project: "p" });
    expect(evs.map((e) => [e.kind, e.actor])).toEqual([["ask", "owner:self"], ["decision", "guest:aa11"]]);
    expect(evs[0].data).toMatchObject({ assignee: "local:guest:aa11" });
    expect(listAsks(d, { assignee: "local:guest:aa11" }).map((x) => x.id)).toEqual([a.id]);
  });

  test("dedupKey：撞上已有的返回那条（existed），不写第二条、不记第二个事件", () => {
    const d = db();
    const first = openAskFull(d, { ...base, dedupKey: "assign:T9:1:1" }, 1000);
    const again = openAskFull(d, { ...base, dedupKey: "assign:T9:1:1", title: "别的标题" }, 1500);
    expect(again).toMatchObject({ existed: true, ask: { id: first.ask.id, title: base.title } });
    expect(listEvents(d, { project: "p" }).filter((e) => e.kind === "ask")).toHaveLength(1);
  });

  test("按 key 取代：同 agent 同 key 再开，旧的记 superseded（ask_cancel 带 supersededBy），新的 supersedes 指旧的；别的 key / agent 不动；旧按钮答不了", () => {
    const d = db();
    const old = openAsk(d, { ...base, askKey: "release" }, 1000);
    const other = openAsk(d, { ...base, askKey: "deploy" }, 1100);
    const otherAgent = openAsk(d, { ...base, fromAgent: "agent-y", askKey: "release" }, 1200);
    const r = openAskFull(d, { ...base, askKey: "release" }, 1300);
    expect(r.superseded.map((x) => x.id)).toEqual([old.id]);
    expect(r.ask.supersedes).toBe(old.id);
    expect([getAsk(d, old.id)?.state, getAsk(d, other.id)?.state, getAsk(d, otherAgent.id)?.state]).toEqual(["superseded", "open", "open"]);
    const cancel = listEvents(d, { project: "p" }).find((e) => e.kind === "ask_cancel");
    expect(cancel?.data).toMatchObject({ askId: old.id, reason: "superseded", supersededBy: r.ask.id });
    expect(() => answerAsk(d, old.id, ans(2000))).toThrow(LedgerError);
  });
});

/** 按合并后的顺序造一个第 n 版的库（SQL 数组逐条 prepare().run()，函数直接调）；steps 可换成别的组合（模拟分支上的库） */
function rawAt(steps: readonly (typeof LEDGER_MIGRATIONS)[number][], version: number): Database {
  path = tempLedgerPath("ledger-asks-v2-");
  const raw = new Database(path);
  for (const step of steps) typeof step === "function" ? step(raw) : step.forEach((sql) => raw.prepare(sql).run());
  raw.exec(`PRAGMA user_version = ${version}`);
  raw.exec(`INSERT INTO asks (id, project, fromAgent, fromChannelId, source, kind, title, expiresAt, state, createdAt, updatedAt)
    VALUES ('ask_old', 'p', 'agent-x', '111', 'reply', 'decide', '老的', 9e12, 'open', 1, 1)`);
  return raw;
}
const tableExists = (d: Database, name: string) => !!d.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

describe("迁移到第二版", () => {
  test("顺序：v1 → asks → 依赖边 → 巡检 → asks v2 → 步骤 → 调度意图 → session → merge → feature → dag → 出借单", () => {
    expect(LEDGER_MIGRATIONS.length).toBe(12);
    expect(LEDGER_MIGRATIONS[4]).toBe(migrateAsksV2);
    expect(LEDGER_MIGRATIONS[5]).toBe(STEPS_SCHEMA);
    expect(LEDGER_MIGRATIONS[6]).toBe(SCHEDULER_SCHEMA);
    expect(LEDGER_MIGRATIONS[7]).toBe(SCHEDULER_SESSIONS_SCHEMA);
    expect(LEDGER_MIGRATIONS[8]).toBe(SCHEDULER_MERGES_SCHEMA);
    expect(LEDGER_MIGRATIONS[9]).toBe(FEATURE_SCHEMA);
    expect(LEDGER_MIGRATIONS[10]).toBe(DAG_REWRITE_SCHEMA);
    expect(LEDGER_MIGRATIONS[11]).toBe(LEND_SCHEMA);
  });

  test("线上的 v3（T8h）、v4（T29，audit_baseline 里有数据）都升到 v5：asks 重建、task_deps / 巡检表 / 任务负责人列都在", () => {
    for (const v of [3, 4]) {
      const raw = rawAt(LEDGER_MIGRATIONS.slice(0, v), v);
      if (v === 4) raw.exec("INSERT INTO audit_baseline (project, rule, since) VALUES ('p', 'review_no_reviewer', 123)");
      raw.close();
      const d = openLedger(path);
      expect([schemaVersion(d), tableExists(d, "task_deps"), tableExists(d, "audit_findings"), getAsk(d, "ask_old")?.assignee]).toEqual([LEDGER_MIGRATIONS.length, true, true, null]);
      if (v === 4) expect(d.query("SELECT since FROM audit_baseline").all()).toEqual([{ since: 123 }]);
      closeLedger(path);
    }
  });

  test("v4 → v5 中途失败（asks 的索引名被占）：打开报错、整笔回滚，库仍是 v4，asks 还是旧表、巡检数据都在", () => {
    const raw = rawAt(LEDGER_MIGRATIONS.slice(0, 4), 4);
    raw.exec("INSERT INTO audit_baseline (project, rule, since) VALUES ('p', 'r', 1)");
    raw.exec("CREATE TABLE asks_key_state (x)");
    raw.close();
    expect(() => openLedger(path)).toThrow(/asks_key_state.*已回滚，库仍是 v4/);
    const check = new Database(path, { readonly: true });
    const cols = (check.query("PRAGMA table_info(asks)").all() as { name: string }[]).map((c) => c.name);
    expect([schemaVersion(check), cols.includes("assignee"), check.query("SELECT COUNT(*) AS n FROM audit_baseline").get()]).toEqual([4, false, { n: 1 }]);
    check.close();
  });

  test("分支上提前开过的库（asks 第二版占了 v3 / v4 的号）：合并后的代码打开会自愈出缺的表，asks 不再重建、数据都在", () => {
    for (const steps of [[...LEDGER_MIGRATIONS.slice(0, 2), migrateAsksV2], [...LEDGER_MIGRATIONS.slice(0, 3), migrateAsksV2]]) {
      rawAt(steps, steps.length).close();
      const d = openLedger(path);
      expect([schemaVersion(d), tableExists(d, "task_deps"), tableExists(d, "audit_findings"), getAsk(d, "ask_old")?.title]).toEqual([LEDGER_MIGRATIONS.length, true, true, "老的"]);
      closeLedger(path);
    }
  });

  test("v2 的库（T11a 线上那版）：重建后旧数据、索引都在，fromAgent 可空、新的 kind / state / source 写得进；重跑不再重建", () => {
    rawAt(LEDGER_MIGRATIONS.slice(0, 2), 2).close();
    const d = openLedger(path);
    expect(schemaVersion(d)).toBe(LEDGER_MIGRATIONS.length);
    expect(getAsk(d, "ask_old")).toMatchObject({ title: "老的", fromAgent: "agent-x", assignee: null, bind: null, dedupKey: null });
    const idx = (d.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'asks' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toEqual(["asks_assignee_state", "asks_from_state", "asks_key_state", "asks_state_project"]);
    const n = openAsk(d, { project: "p", source: "system", createdBy: "system:peer-409", kind: "assigned", title: "转人工", assignee: "local:owner:self" }, 5);
    expect(getAsk(d, n.id)?.fromAgent).toBeNull();
    openAskFull(d, { ...base, askKey: "k" }, 6);
    openAskFull(d, { ...base, askKey: "k" }, 7);
    expect(listAsks(d, { states: ["superseded"] })).toHaveLength(1);
    closeLedger(path);
    const again = openLedger(path);
    expect(getAsk(again, "ask_old")?.title).toBe("老的");
    // 单独少了一个索引：再跑一次只补索引、不重建（r1 P2-3）
    again.prepare("DROP INDEX asks_assignee_state").run();
    migrateAsksV2(again);
    expect(again.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'asks_assignee_state'").get()).toBeTruthy();
    expect(getAsk(again, "ask_old")?.title).toBe("老的");
  });
});
