/** 「待你处理」库的生命周期（lib/ledger-asks.ts）：建 → 答 → 再答被拒；到期；撤销；事件只追加；v1 库升级 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { answerAsk, ASK_TTL_MS, closeAsk, dueAsks, findAskByDiscordMessage, getAsk, hasAsksTable, listAsks, openAsk, patchAsk, type AskAnswer, type NewAsk } from "../src/lib/ledger-asks.js";
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
    appendEvent(d, { actor: "owner", now: 3 }, { project: "p", target: "T9", kind: "verify", text: "线上验证失败", data: { result: "fail" } });
    appendEvent(d, { actor: "owner", now: 4 }, { project: "p", target: "", kind: "note", text: "项目级" });
    const onTask = openAsk(d, base, 5);
    answerAsk(d, onTask.id, ans(6));
    closeAsk(d, openAsk(d, base, 7).id, "cancelled", "", 8);
    for (let i = 0; i < 25; i++) openAsk(d, { ...base, taskId: undefined, title: `q${i}` }, 10 + i);
    const v = projectView(d, "p", 100);
    expect(v.tasks[0].lastEvent).toMatchObject({ kind: "verify", data: { result: "fail" } });
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
