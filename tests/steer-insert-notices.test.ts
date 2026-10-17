import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { type Envelope } from "../src/bridge/router.js";
import { answerableUnmixed } from "../src/bridge/stop-settle.js";
import {
  configureSteerInsert, INSERT_LIMIT, insertIdsFrom, insertSnapshot, insertUnseenFrom, noteInsert, openInsertBook, settleInsertReply, sweepInserts,
} from "../src/bridge/steer-insert.js";
import { insertNoticeWanted, settleInsertStop, wireInsertNotices } from "../src/bridge/steer-insert-notices.js";
import { isInternalIdleNotice } from "../src/lib/held-idle-batch.js";
import { requestStillHeld } from "../src/lib/held-pac.js";

let clock = 10_000, stopAt: number | undefined;
let calls: AgentCallBook, notices: Envelope[];
const env = (id: string, from = "X"): Envelope => ({
  from: { kind: "local", channelId: from, agentName: `agent-${from}`, ws: undefined as never },
  to: { kind: "local", channelId: "T", agentName: "agent-T", ws: undefined as never }, intent: "request", content: `问题 ${id}`,
  meta: { messageId: id, threadId: `thread-${id}`, ts: "2026-10-17T00:00:00Z", triggerKind: "agent_tool", inboundRoute: { action: "insert", via: "steer", p: 0.9 } },
});
function insert(id: string, from = "X"): void {
  calls.add("T", { callerChannelId: from, callerName: `agent-${from}`, targetName: "agent-T", ts: clock }, id);
  noteInsert(env(id, from), "T");
}
const hold = (e: Envelope) => { notices.push(e); };
const stop = (snapshot = insertSnapshot("T"), normal = true) => settleInsertStop("T", snapshot, normal);

beforeEach(() => {
  clock += 3 * 86_400_000;
  stopAt = undefined;
  calls = new AgentCallBook(null);
  notices = [];
  openInsertBook(null);
  configureSteerInsert({ now: () => clock });
  wireInsertNotices({ hold, stoppedAt: () => stopAt, dropRequest: (t, c, id) => calls.dropRequest(t, c, id) });
});
afterAll(() => {
  openInsertBook(null);
  configureSteerInsert({ now: () => Date.now(), stoppedAt: () => undefined, removed: () => {} });
});

describe("逐条插队催答", () => {
  test("Pi 迟到的作废回执先销指定 id，不重复产生叫停回显", () => {
    insert("late-voided"); clock++; stopAt = clock;
    settleInsertReply("T", ["late-voided"]);
    expect(notices).toHaveLength(0);
    expect(insertSnapshot("T").size).toBe(0);
  });

  test("提醒入队后才叫停或明确回复：投前作废旧提醒，合批不能绕过检查", () => {
    insert("queued"); stop();
    const reminder = notices[0];
    expect(insertNoticeWanted(reminder)).toBe(true);
    expect(isInternalIdleNotice({ env: reminder } as never)).toBe(false);
    clock++; stopAt = clock;
    expect(insertNoticeWanted(reminder)).toBe(false);
    expect(notices.at(-1)?.to).toMatchObject({ channelId: "X" });
    clock++; insert("answered"); stop();
    const answered = notices.at(-1)!;
    settleInsertReply("T", ["answered"]);
    expect(insertNoticeWanted(answered)).toBe(false);
  });

  test("提醒入队后主动补投，不依赖 Stop 之前已有押后消息", async () => {
    const flushed: string[] = [];
    wireInsertNotices({ hold, stoppedAt: () => undefined, dropRequest: () => {}, flush: async (t) => { flushed.push(t); } });
    insert("schedule"); stop();
    expect(notices).toHaveLength(1);
    expect(flushed).toEqual([]);
    await Bun.sleep(2_100);
    expect(flushed).toEqual(["T"]);
  });

  test("oneShot 插话不挂等待账、不催答、不发超期说明", () => {
    const e = env("one-shot"); e.meta.skipInterAgentWatchdog = true;
    noteInsert(e, "T"); stop(); clock += 86_400_001; sweepInserts();
    expect(insertSnapshot("T").size).toBe(0);
    expect(notices).toHaveLength(0);
  });

  test("回别人只销别人的账；同一发送方两条各催一次，重复 Stop / 重启不再催", () => {
    insert("x1"); insert("x2"); insert("y", "Y");
    settleInsertReply("T", insertIdsFrom("T", "Y"));
    stop(); stop();
    expect(notices).toHaveLength(2);
    expect(notices.every((e) => e.to.kind === "local" && e.to.channelId === "T" && e.meta.waitForIdle)).toBe(true);
    expect(notices.map((e) => e.content).join()).toContain("agent-X");
    expect(notices.map((e) => e.content).join()).toContain("问题 x1");
    expect(notices.map((e) => e.content).join()).toContain("问题 x2");
    const path = join(mkdtempSync(join(tmpdir(), "insert-reminded-")), "book.json");
    openInsertBook(path);
    insert("persisted"); stop();
    const n = notices.length;
    openInsertBook(path); stop();
    expect(notices).toHaveLength(n);
    expect(calls.slot("T", "X")).toBeDefined();
  });

  test("Stop 到达后、drain await 期间新插进来的留到下一次 Stop", () => {
    insert("before");
    const snap = insertSnapshot("T");
    clock++; insert("after");
    stop(snap);
    expect(notices.map((e) => e.meta.inReplyTo)).toEqual(["before"]);
    stop();
    expect(notices.map((e) => e.meta.inReplyTo)).toEqual(["before", "after"]);
  });

  test("StopFailure 不唤醒目标，下一次正常 Stop 仍会催", () => {
    insert("failure"); stop(undefined, false);
    expect(notices).toHaveLength(0);
    stop();
    expect(notices).toHaveLength(1);
  });

  test("owner 叫停：即使之前催过，也只通知 X、不再唤醒目标，逐条释放回程", () => {
    insert("stopped"); stop(); notices = [];
    clock++; stopAt = clock;
    stop(undefined, false);
    expect(notices).toHaveLength(1);
    expect(notices[0].to).toMatchObject({ channelId: "X" });
    expect(notices[0].content).toContain("目标被 owner 叫停，你的插话可能没被处理，需要的话请重发。");
    expect(calls.slot("T", "X")).toBeUndefined();
    expect(insertSnapshot("T").size).toBe(0);
    clock++; insert("after-stop"); stop();
    expect(notices[1].to).toMatchObject({ channelId: "T" });
  });

  test("24 小时到期：读账即释放槽并通知 X，不能被该次 drain 错推；不依赖目标再写入", () => {
    insert("expired");
    clock += 86_400_000;
    const held = (r: { messageId?: string; callerChannelId: string }) => requestStillHeld(r, insertUnseenFrom("T"));
    expect(answerableUnmixed(calls, "T", held)).toBeUndefined();
    expect(calls.slot("T", "X")).toBeUndefined();
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("对方 24 小时没明确回复");
    expect(notices[0].meta.inReplyTo).toBe("expired");
    sweepInserts();
    expect(notices).toHaveLength(1);
  });

  test("过期只释放对应请求，同槽中后来的请求保留", () => {
    insert("old"); clock += 86_400_000 - 10;
    insert("fresh"); clock += 11;
    sweepInserts();
    expect(calls.slot("T", "X")?.messageIds).toEqual(["fresh"]);
    expect([...insertSnapshot("T")]).toEqual(["fresh"]);
  });

  test("回复帧之前的插队才销账，解析目标期间后来插的回程和保护都保留", () => {
    insert("earlier"); clock++; const replyAt = clock;
    insert("later"); // 同一毫秒也保守保留，不能被旧回复销掉
    const snap = insertIdsFrom("T", "X", replyAt);
    const view = calls.exact("T", "X", (r) => requestStillHeld(r, insertUnseenFrom("T", "X", replyAt)));
    expect(view?.messageIds).toEqual(["earlier"]);
    calls.consume("T", "X", view);
    settleInsertReply("T", snap);
    expect(calls.slot("T", "X")?.messageIds).toEqual(["later"]);
    expect([...insertSnapshot("T")]).toEqual(["later"]);
    stop();
    expect(notices[0].meta.inReplyTo).toBe("later");
  });
});

describe("确认账校验和上限", () => {
  test("坏条目逐个跳过并落盘清理，好条目仍可读（含坏整本与数组）", () => {
    const path = join(mkdtempSync(join(tmpdir(), "insert-invalid-")), "book.json");
    const good = { env: env("good"), at: clock };
    const variants = [null, [], { ...good, at: "bad" }, { ...good, at: -1 }, { ...good, reminded: 3 },
      { ...good, env: {} }, { ...good, env: { ...env("bad"), content: null } }, { ...good, env: { ...env("bad"), meta: null } },
      { ...good, env: { ...env("bad"), to: { kind: "local", channelId: "T", agentName: { toString: null } } } }];
    const invalid = variants.map((v, i) => {
      const candidate = structuredClone(v);
      const e = (candidate as { env?: Envelope } | null)?.env;
      if (e?.meta) e.meta.messageId = `bad-${i}`;
      return [`bad-${i}`, candidate];
    });
    writeFileSync(path, JSON.stringify({ T: { good, ...Object.fromEntries(invalid) }, broken: null, array: [] }));
    openInsertBook(path);
    expect([...insertSnapshot("T")]).toEqual(["good"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ T: { good } });
  });

  test("全局超过上限清最老条目，释放其回程且告知原请求方", () => {
    const path = join(mkdtempSync(join(tmpdir(), "insert-limit-")), "book.json");
    const records = Object.fromEntries(Array.from({ length: INSERT_LIMIT + 1 }, (_, i) => [`id-${i}`, { env: env(`id-${i}`), at: clock + i }]));
    writeFileSync(path, JSON.stringify({ T: records }));
    calls.add("T", { callerChannelId: "X", callerName: "agent-X", targetName: "agent-T", ts: clock }, "id-0");
    openInsertBook(path);
    expect(insertSnapshot("T").size).toBe(INSERT_LIMIT);
    expect(insertSnapshot("T").has("id-0")).toBe(false);
    expect(calls.slot("T", "X")).toBeUndefined();
    expect(notices[0].content).toContain("确认账已达上限");
  });
});
