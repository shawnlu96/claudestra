/** 决定过期后的再提示（lib/ask-recovery.ts）：真实台账上的状态机——资格、等待、至多一次、重绑定、并发复核、原过期记录不动 */
import { afterEach, describe, expect, test } from "bun:test";
import { bindHash, checkAsk } from "../src/lib/ask-bind.js";
import { markReminderNoticed, noticeBlocker, pendingReminderNotices, reminderDedupKey, remindOne, sweepReminders, type ReminderPorts } from "../src/lib/ask-recovery.js";
import { answerAsk, closeAsk, getAsk, listAsks, openAsk, patchAsk, type Ask, type NewAsk } from "../src/lib/ledger-asks.js";
import { closeLedger, LedgerError, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { tempLedgerPath } from "./ledger-test-helpers.js";

let path = "";
afterEach(() => closeLedger(path));
const db = () => openLedger(path);

const H = 3_600_000;
const BUTTONS = [{ type: "buttons", buttons: [{ id: "go", label: "发" }, { id: "no", label: "不发" }] }];
const BIND = { action: "release", params: { tag: "v2.32.0" }, approve: ["go"] };
const base: NewAsk = {
  project: "p", fromAgent: "agent-x", fromChannelId: "111", source: "reply", kind: "decide", title: "发 v2.32.0 吗", blocking: true, options: BUTTONS,
  askKey: "release", extra: { parent: "agent-pm", parentChannelId: "222", fp: "ignored" },
};
const ON: ReminderPorts = {
  policy: () => ({ mode: "on", manualAfterMs: null }),
  ownerActive: () => ({ active: true, evidence: "heartbeat" }),
  askerLive: () => true,
};
const answer = (at: number, choice = "go") => ({ choices: [`[button:${choice}]`], labels: [choice], text: "", principal: "owner:self", via: "web_card" as const, at, owner: true as const });

/** 开一条、到点、扫成 expired：返回过期后的那条 */
function expired(input: Partial<NewAsk> = {}, createdAt = 1_000): Ask {
  path ||= tempLedgerPath("ask-recovery-");
  const a = openAsk(db(), { ...base, expiresAt: createdAt + 4 * H, ...input }, createdAt);
  return closeAsk(db(), a.id, "expired", "", a.expiresAt)!;
}
const reminders = () => listAsks(db()).filter((a) => typeof a.extra.recoveryOf === "string");

afterEach(() => void (path = ""));

describe("再提示：开卡", () => {
  test("on + owner 活跃 + 发起方在：按原语义开新卡（新 id、同选项 / key / 路由），原过期记录与事件不动", async () => {
    const a = expired();
    const before = { row: getAsk(db(), a.id), events: listEvents(db(), { project: "p" }).length };
    const r = await remindOne(db(), a, ON, a.expiresAt + 60_000);
    expect(r.result).toBe("opened");
    const n = (r as { reminder: Ask }).reminder;
    expect(n.id).not.toBe(a.id);
    expect(n).toMatchObject({ state: "open", kind: "decide", source: "reply", fromAgent: "agent-x", fromChannelId: "111", title: a.title, options: BUTTONS, askKey: "release",
      dedupKey: reminderDedupKey(a.id), supersedes: null, discordMessageIds: [] });
    expect(n.extra).toEqual({ recoveryOf: a.id, parent: "agent-pm", parentChannelId: "222", remindNotice: "pending" });
    expect(n.expiresAt).toBe(a.expiresAt + 60_000 + 4 * H);
    expect(getAsk(db(), a.id)).toEqual(before.row);
    expect(listEvents(db(), { project: "p" }).length).toBe(before.events + 1);
  });

  test("授权类：新卡重绑定出新 hash；原 id 永远不批准，新卡要原发起 agent + 新 hash + approve 按钮", async () => {
    const a = expired({ kind: "authorize", bind: { ...BIND, paramsHash: bindHash(BIND, "agent-x") } });
    const r = await remindOne(db(), a, ON, a.expiresAt + 1);
    const n = (r as { reminder: Ask }).reminder;
    expect(n.bind!.paramsHash).not.toBe(a.bind!.paramsHash);
    expect(n.bind!.paramsHash).toBe(bindHash(n.bind!, "agent-x"));
    expect(() => answerAsk(db(), a.id, answer(a.expiresAt + 2))).toThrow(LedgerError);
    const done = answerAsk(db(), n.id, answer(a.expiresAt + 2));
    const t = a.expiresAt + 3;
    expect(checkAsk(getAsk(db(), a.id), a.bind!.paramsHash, "agent-x", t)).toMatchObject({ ok: false });
    expect(checkAsk(done, a.bind!.paramsHash, "agent-x", t)).toMatchObject({ ok: false, reason: expect.stringContaining("hash mismatch") });
    expect(checkAsk(done, n.bind!.paramsHash, "agent-y", t)).toMatchObject({ ok: false });
    expect(checkAsk(done, n.bind!.paramsHash, "agent-x", t)).toEqual({ ok: true });
    // 拒绝也只是这一张的答案，不会再开第三张
    expect((await remindOne(db(), getAsk(db(), a.id)!, ON, t)).result).toBe("skip");
  });

  test("重复 tick / 重启（换连接）/ 再提示卡自己过期：一轮至多一张", async () => {
    const a = expired();
    const now = a.expiresAt + 1;
    expect((await sweepReminders(db(), ON, now)).map((r) => r.result)).toEqual(["opened"]);
    expect((await sweepReminders(db(), ON, now + 60_000)).map((r) => [r.result, "reason" in r && r.reason])).toEqual([["skip", "reminder already opened"]]);
    closeLedger(path);
    expect((await sweepReminders(db(), ON, now + 120_000)).map((r) => r.result)).toEqual(["skip"]);
    const n = reminders()[0];
    closeAsk(db(), n.id, "expired", "", n.expiresAt);
    await sweepReminders(db(), ON, n.expiresAt + 1);
    expect(reminders().map((x) => x.id)).toEqual([n.id]);
  });

  test("迟到的答复：原卡 conflict；新卡答完再答也 conflict（不会双执行）", async () => {
    const a = expired();
    const n = ((await remindOne(db(), a, ON, a.expiresAt + 1)) as { reminder: Ask }).reminder;
    answerAsk(db(), n.id, answer(a.expiresAt + 2));
    expect(() => answerAsk(db(), n.id, answer(a.expiresAt + 3))).toThrow(LedgerError);
    expect(() => answerAsk(db(), a.id, answer(a.expiresAt + 3))).toThrow(LedgerError);
    expect(getAsk(db(), a.id)!.state).toBe("expired");
  });
});

describe("再提示：等待（不猜在线）", () => {
  test("没有活跃证据 / owner 不在 / 发起方不知在不在 → wait，不消耗那一次；之后活跃了照开", async () => {
    const a = expired();
    const now = a.expiresAt + 1;
    const res = await Promise.all([
      remindOne(db(), a, { ...ON, ownerActive: undefined }, now),
      remindOne(db(), a, { ...ON, ownerActive: () => null }, now),
      remindOne(db(), a, { ...ON, ownerActive: async () => ({ active: false, evidence: "hidden" }) }, now),
      remindOne(db(), a, { ...ON, askerLive: undefined }, now),
      remindOne(db(), a, { ...ON, askerLive: () => false }, now),
    ]);
    expect(res.map((r) => r.result)).toEqual(["wait", "wait", "wait", "wait", "wait"]);
    expect(reminders()).toEqual([]);
    expect((await remindOne(db(), a, ON, now + H)).result).toBe("opened");
  });
});

describe("再提示：开关", () => {
  test("缺策略 port = observe：满足条件也只报 observe，不写库", async () => {
    const a = expired();
    const r = await remindOne(db(), a, { ...ON, policy: undefined }, a.expiresAt + 1);
    expect(r).toEqual({ id: a.id, result: "observe", evidence: "heartbeat" });
    expect(reminders()).toEqual([]);
  });

  test("off、策略读取抛错（按 off）→ skip，连 owner 活跃都不问", async () => {
    const a = expired();
    let asked = 0;
    const ownerActive = () => (asked++, { active: true, evidence: "x" });
    const off = await remindOne(db(), a, { ...ON, ownerActive, policy: () => ({ mode: "off", manualAfterMs: null }) }, a.expiresAt + 1);
    const bad = await remindOne(db(), a, { ...ON, ownerActive, policy: () => { throw new Error("corrupt"); } }, a.expiresAt + 1);
    expect([off.result, bad.result, asked]).toEqual(["skip", "skip", 0]);
    expect(reminders()).toEqual([]);
  });

  test("窗口：manualAfterMs 设了按它；null = owner 没设期限，不拿原卡有效期顶替——4 小时卡过期 5 小时 / 10 天后 owner 回来照开", async () => {
    const a = expired();
    const tight = { ...ON, policy: () => ({ mode: "on" as const, manualAfterMs: 10 * 60_000 }) };
    expect((await remindOne(db(), a, tight, a.expiresAt + 11 * 60_000))).toMatchObject({ result: "skip", reason: "reminder window passed" });
    expect((await remindOne(db(), a, tight, a.expiresAt + 10 * 60_000)).result).toBe("opened");
    const b = expired({ askKey: "b" });
    expect((await remindOne(db(), b, { ...ON, ownerActive: () => null }, b.expiresAt + 5 * H)).result).toBe("wait");
    expect((await remindOne(db(), b, ON, b.expiresAt + 5 * H)).result).toBe("opened");
    const c = expired({ askKey: "c" });
    expect((await sweepReminders(db(), ON, c.expiresAt + 10 * 24 * H)).find((r) => r.id === c.id)?.result).toBe("opened");
  });
});

describe("再提示：不再骚扰", () => {
  test("owner 删过（cancelled）、隐藏了过期卡、答过一部分、暂停了 → 不开", async () => {
    path = tempLedgerPath("ask-recovery-");
    const del = openAsk(db(), { ...base, askKey: "a" }, 1);
    closeAsk(db(), del.id, "cancelled", "owner 删掉", 2, { dismissed: { by: "owner:self", at: 2 } });
    const hid = expired({ askKey: "b" });
    patchAsk(db(), hid.id, { extra: { hidden: { by: "owner:self", at: 3 } } });
    const part = openAsk(db(), { ...base, askKey: "c", options: [...BUTTONS, { type: "buttons", buttons: [{ id: "x", label: "x" }] }] }, 1);
    answerAsk(db(), part.id, answer(2));
    closeAsk(db(), part.id, "expired", "", 3);
    const res = await sweepReminders(db(), ON, 4 * H);
    expect(res.map((r) => [r.id, r.result])).toEqual(expect.arrayContaining([[hid.id, "skip"], [part.id, "skip"]]));
    expect(res.find((r) => r.id === del.id)).toBeUndefined();
    const p = expired({ askKey: "d" });
    expect(await remindOne(db(), p, { ...ON, paused: () => true }, p.expiresAt + 1)).toMatchObject({ result: "skip", reason: "paused by owner" });
    expect(reminders()).toEqual([]);
  });

  test("发起 agent 已用同一个 key 重新问过（不论那张现在什么状态）→ 不开", async () => {
    const a = expired();
    const again = openAsk(db(), { ...base }, a.expiresAt + 10);
    closeAsk(db(), again.id, "cancelled", "owner 删掉", a.expiresAt + 20, { dismissed: { by: "owner:self", at: 1 } });
    expect(await remindOne(db(), a, ON, a.expiresAt + 30)).toMatchObject({ result: "skip", reason: "agent asked again with the same key" });
  });

  test("不在范围的：非阻塞、验收、指派、人发起、运行时弹框", async () => {
    path = tempLedgerPath("ask-recovery-");
    const mk = (x: Partial<NewAsk>) => closeAsk(db(), openAsk(db(), { ...base, expiresAt: 10, ...x }, 1).id, "expired", "", 10);
    mk({ blocking: false, askKey: "1" });
    mk({ blocking: null, askKey: "2" });
    mk({ kind: "accept", askKey: "3" });
    mk({ kind: "assigned", source: "human", fromAgent: null, assignee: "local:g", askKey: "4" });
    mk({ source: "permission", askKey: "5" });
    expect(await sweepReminders(db(), ON, 20)).toEqual([]);
    expect(reminders()).toEqual([]);
  });
});

describe("再提示：检查 + 写入原子", () => {
  test("判定之后、写入之前别的连接开了再提示 / agent 重新问了 → 写锁内复核放弃，全库只有一张", async () => {
    const a = expired();
    const now = a.expiresAt + 1;
    const race: ReminderPorts = { ...ON, askerLive: async () => (await remindOne(openLedger(path), a, ON, now), true) };
    expect(await remindOne(db(), a, race, now)).toMatchObject({ result: "skip" });
    expect(reminders()).toHaveLength(1);

    const b = expired({ askKey: "other" });
    const reask: ReminderPorts = { ...ON, askerLive: () => (openAsk(db(), { ...base, askKey: "other" }, now), true) };
    expect(await remindOne(db(), b, reask, now)).toMatchObject({ result: "skip", reason: "agent asked again with the same key" });
    expect(reminders()).toHaveLength(1);
  });

  test("等 owner 活跃 / 发起方查询期间 owner 暂停了、或策略改成 observe / off → 写锁内复核放弃，不开", async () => {
    const a = expired();
    let paused = false;
    const pauseRace: ReminderPorts = { ...ON, paused: () => paused, ownerActive: async () => ((paused = true), { active: true, evidence: "heartbeat" }) };
    expect(await remindOne(db(), a, pauseRace, a.expiresAt + 1)).toMatchObject({ result: "skip", reason: "paused by owner" });
    for (const mode of ["observe", "off"] as const) {
      let m: "on" | "observe" | "off" = "on";
      const flip: ReminderPorts = { ...ON, policy: () => ({ mode: m, manualAfterMs: null }), askerLive: async () => ((m = mode), true) };
      expect(await remindOne(db(), a, flip, a.expiresAt + 1)).toMatchObject({ result: "skip", reason: `mode=${mode}` });
    }
    expect(reminders()).toEqual([]);
    expect((await remindOne(db(), a, { ...ON, paused: () => paused }, a.expiresAt + 2)).result).toBe("skip");
    paused = false;
    expect((await remindOne(db(), a, { ...ON, paused: () => paused }, a.expiresAt + 2)).result).toBe("opened");
  });

  test("等发起方查询期间 owner 变不活跃 / 证据没了 → 不拿旧证据开卡，wait；之后又活跃了照开", async () => {
    const a = expired();
    for (const gone of [{ active: false, evidence: "presence away" }, null]) {
      let act: { active: boolean; evidence: string } | null = { active: true, evidence: "heartbeat" };
      const race: ReminderPorts = { ...ON, ownerActive: () => act, askerLive: async () => ((act = gone), true) };
      expect(await remindOne(db(), a, race, a.expiresAt + 1)).toMatchObject({ result: "wait" });
    }
    expect(reminders()).toEqual([]);
    expect((await remindOne(db(), a, ON, a.expiresAt + 2)).result).toBe("opened");
  });

  test("写锁内再问一次 owner 活跃（同步 port）：判定后、写入前证据没了 → wait，不开", async () => {
    const a = expired();
    let calls = 0;
    const flip: ReminderPorts = { ...ON, ownerActive: () => (calls++ === 0 ? { active: true, evidence: "heartbeat" } : null) };
    expect(await remindOne(db(), a, flip, a.expiresAt + 1)).toMatchObject({ result: "wait", reason: "no owner activity evidence" });
    expect(calls).toBe(2);
    expect(reminders()).toEqual([]);
  });

  test("原卡在判定后被改过（如 owner 隐藏）→ 放弃", async () => {
    const a = expired();
    const hide: ReminderPorts = { ...ON, askerLive: () => (patchAsk(db(), a.id, { extra: { hidden: { by: "owner:self", at: 1 } } }, a.expiresAt + 5), true) };
    expect(await remindOne(db(), a, hide, a.expiresAt + 10)).toMatchObject({ result: "skip", reason: "original changed" });
    expect(reminders()).toEqual([]);
  });
});

describe("再提示：批量与通知待办", () => {
  test("批里某条的 port 抛错：只有那条 wait，前面开出的保留；开出的卡带通知待办，记 done 后不再列出；已答的不补", async () => {
    const a = expired({ askKey: "a" });
    const b = expired({ askKey: "b" });
    let calls = 0;
    // 每条问两次 owner 活跃（判定 + 写锁内复核）：第 3 次 = 第二条
    const flaky: ReminderPorts = { ...ON, ownerActive: () => { if (calls++ === 2) throw new Error("presence temporarily down"); return { active: true, evidence: "heartbeat" }; } };
    const res = await sweepReminders(db(), flaky, b.expiresAt + 1);
    expect(res.map((r) => r.result).sort()).toEqual(["opened", "wait"]);
    expect(res.find((r) => r.result === "wait")).toMatchObject({ reason: "check failed: presence temporarily down" });
    expect(pendingReminderNotices(db()).map((x) => x.extra.recoveryOf)).toHaveLength(1);
    // 恢复后再扫：另一条开出；两张都还在待办里（第一张的通知没人发过）
    await sweepReminders(db(), ON, b.expiresAt + 60_000);
    const pend = pendingReminderNotices(db());
    expect(pend.map((x) => x.extra.recoveryOf).sort()).toEqual([a.id, b.id].sort());
    markReminderNoticed(db(), pend[0].id, b.expiresAt + 60_001);
    answerAsk(db(), pend[1].id, answer(b.expiresAt + 60_002));
    expect(pendingReminderNotices(db())).toEqual([]);
    expect(getAsk(db(), pend[0].id)!.state).toBe("open");
  });
});

describe("再提示：待办通知重放的闸", () => {
  test("off / observe / 缺策略 / 暂停 / 无活跃证据 / owner 不在 → 不放行（待办留着）；on + 未暂停 + owner 活跃才放行", async () => {
    const a = expired();
    const r = await remindOne(db(), a, ON, a.expiresAt + 1);
    if (r.result !== "opened") throw new Error("expected opened");
    const n = r.reminder;
    expect(await noticeBlocker(n, { ...ON, policy: () => ({ mode: "off", manualAfterMs: null }) }, 1)).toBe("mode=off");
    expect(await noticeBlocker(n, { ...ON, policy: () => ({ mode: "observe", manualAfterMs: null }) }, 1)).toBe("mode=observe");
    expect(await noticeBlocker(n, { ownerActive: ON.ownerActive }, 1)).toBe("mode=observe");
    expect(await noticeBlocker(n, { ...ON, paused: () => true }, 1)).toBe("paused by owner");
    expect(await noticeBlocker(n, { ...ON, ownerActive: () => null }, 1)).toBe("no owner activity evidence");
    expect(await noticeBlocker(n, { ...ON, ownerActive: async () => ({ active: false, evidence: "away" }) }, 1)).toBe("owner not active (away)");
    expect(await noticeBlocker(n, { ...ON, ownerActive: () => { throw new Error("down"); } }, 1)).toBe("check failed: down");
    expect(await noticeBlocker(n, ON, 1)).toBeNull();
    expect(pendingReminderNotices(db()).map((x) => x.id)).toEqual([n.id]);
  });
});
