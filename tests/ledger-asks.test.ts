/** 「待你处理」库的生命周期（lib/ledger-asks.ts）：建 → 答 → 再答被拒；到期；撤销；事件只追加；v1 库升级 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { answerAsk, ASK_TTL_MS, closeAsk, dueAsks, findAskByDiscordMessage, getAsk, hasAsksTable, listAsks, openAsk, patchAsk, type AskAnswer, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, LEDGER_SCHEMA_VERSION, LedgerError, listEvents, openLedger, schemaVersion } from "../src/lib/ledger-store.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let path = "";
afterEach(() => closeLedger(path));

const base: NewAsk = { project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发 v2.31.0 吗", taskId: "T9" };
const ans = (at: number, extra: Partial<AskAnswer> = {}): AskAnswer => ({ choices: ["[button:go]"], text: "", principal: "owner:self", via: "web_card", at, ...extra });

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

  test("答：open → answered，同一事务追加 decision 事件（actor owner）；再答一次 → conflict，库里保持第一次的答案", () => {
    const d = db();
    const a = openAsk(d, base, 1000);
    const out = answerAsk(d, a.id, ans(2000, { text: "只做 Codex" }));
    expect(out).toMatchObject({ state: "answered", answer: { choices: ["[button:go]"], text: "只做 Codex", via: "web_card" } });
    const dec = listEvents(d, { project: "p" }).filter((e) => e.kind === "decision");
    expect(dec).toHaveLength(1);
    expect(dec[0]).toMatchObject({ actor: "owner", target: "T9", data: { askId: a.id, ownerWords: "只做 Codex" } });
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
    expect(() => answerAsk(d, a.id, ans(6000))).toThrow(LedgerError);
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

describe("迁移", () => {
  test("v1 的库（CLI 旧版建的）打开后补上 asks 表，已有数据不动", () => {
    path = tempLedgerPath("ledger-asks-v1-");
    const raw = new Database(path);
    raw.exec("CREATE TABLE items (project TEXT, id TEXT); INSERT INTO items VALUES ('p', 'i1'); PRAGMA user_version = 1");
    expect(hasAsksTable(raw)).toBe(false);
    raw.close();
    const d = openLedger(path);
    expect(schemaVersion(d)).toBe(LEDGER_SCHEMA_VERSION);
    expect(hasAsksTable(d)).toBe(true);
    expect(d.query("SELECT count(*) AS n FROM items").get()).toEqual({ n: 1 });
  });
});
