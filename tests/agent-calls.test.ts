/**
 * bridge/agent-calls.ts：send_to_agent 回程路由簿——每个 (target, caller) 一槽、落盘（bridge 重启后答复仍推回发起方）、
 * 老格式迁移、没指明答给谁时只在恰好一个 caller 在等才算、多个在等只提醒一次、坏文件不让 bridge 起不来。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook, ambiguityNotice, type PendingAgentCall } from "../src/bridge/agent-calls.js";

const dir = mkdtempSync(join(tmpdir(), "agent-calls-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const call = (ts: number, caller = "c-me", callerName = "agent-claudestra"): PendingAgentCall => ({
  callerChannelId: caller, callerName, targetName: "agent-codex",
  originalReplyChannel: "api:owner:self", expecting: "按意见改设计稿", ts,
});
const none = () => false;

describe("AgentCallBook", () => {
  test("add 落盘，新实例（= bridge 重启）原样恢复", () => {
    const p = join(dir, "a.json");
    new AgentCallBook(p).add("c-codex", call(1000), "m1");
    expect(new AgentCallBook(p).slot("c-codex", "c-me")).toMatchObject({
      ...call(1000), targetChannelId: "c-codex", messageIds: ["m1"],
      requests: [{ messageId: "m1", expecting: "按意见改设计稿", originalReplyChannel: "api:owner:self", ts: 1000 }],
    });
  });

  test("两个 caller 问同一个 target 各占一槽，互不覆盖；consume 只消化指定那槽", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(1, "c-me"));
    book.add("c-codex", call(2, "c-pi", "agent-pi"));
    expect(book.forTarget("c-codex").map((c) => c.callerChannelId).sort()).toEqual(["c-me", "c-pi"]);
    expect(book.consume("c-codex", "c-me")).toBe(true);
    expect(book.forTarget("c-codex").map((c) => c.callerChannelId)).toEqual(["c-pi"]);
    book.add("c-codex", call(3, "c-pi", "agent-pi")); // 同一个 caller 再问：覆盖自己那槽
    expect(book.forTarget("c-codex")).toHaveLength(1);
    expect(book.slot("c-codex", "c-pi")?.ts).toBe(3);
  });

  test("同一 caller 连着问：q1 已送到、q2 还押着 → 答复只算 q1（只带 q1 的 expecting），消化只删 q1，q2 留着等它自己的答复", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", { ...call(1), expecting: "改设计稿" }, "q1");
    book.add("c-codex", { ...call(2), expecting: "再跑测试" }, "q2");
    const q2Held = (r: { messageId?: string }) => r.messageId === "q2";
    const v = book.exact("c-codex", "c-me", q2Held)!;
    expect(v.expecting).toBe("改设计稿");
    expect(v.requests!.map((r) => r.messageId)).toEqual(["q1"]);
    expect(book.consume("c-codex", "c-me", v)).toBe(true);
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.messageId)).toEqual(["q2"]);
    expect(book.exact("c-codex", "c-me", q2Held)).toBeUndefined(); // q2 还押着：它的答复不会被别的收尾吃掉
    const v2 = book.exact("c-codex", "c-me", () => false)!; // q2 送到了
    expect(v2.expecting).toBe("再跑测试");
    book.consume("c-codex", "c-me", v2);
    expect(book.slot("c-codex", "c-me")).toBeUndefined();
  });

  test("两条都送到了：一次答复算两条（expecting 合并），消化后整槽删；dropRequest 只撤指定那条", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", { ...call(1), expecting: "改设计稿" }, "q1");
    book.add("c-codex", { ...call(2), expecting: "再跑测试" }, "q2");
    book.dropRequest("c-codex", "c-me", "q2");
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.messageId)).toEqual(["q1"]);
    book.add("c-codex", { ...call(3), expecting: "再跑测试" }, "q3");
    const v = book.answerable("c-codex", () => false)!;
    expect(v.expecting).toBe("改设计稿；另一个问题：再跑测试");
    book.consume("c-codex", "c-me", v);
    expect(book.slot("c-codex", "c-me")).toBeUndefined();
  });

  test("#116 时期的老槽（messageIds 有两条、没有 requests）：每条都算请求，答了已送到的 q1 不会删掉押着的 q2", () => {
    const p = join(dir, "legacy116.json");
    writeFileSync(p, JSON.stringify({ ["c-codex\u001fc-me"]: { ...call(1), targetChannelId: "c-codex", messageIds: ["q1", "q2"], expecting: "合并过的" } }));
    const book = new AgentCallBook(p);
    const v = book.exact("c-codex", "c-me", (r) => r.messageId === "q2")!;
    expect(v.requests!.map((r) => r.messageId)).toEqual(["q1"]);
    book.consume("c-codex", "c-me", v);
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.messageId)).toEqual(["q2"]);
  });

  test("回复频道只取已送到那几条自己的：q1 没有、q2 押着且有 B → 视图里是空（走默认），不借 q2 的", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", { ...call(1), originalReplyChannel: undefined }, "q1");
    book.add("c-codex", { ...call(2), originalReplyChannel: "B" }, "q2");
    expect(book.exact("c-codex", "c-me", (r) => r.messageId === "q2")!.originalReplyChannel).toBeUndefined();
  });

  test("answerable：恰好一个已送达的 caller 在等才算；请求还押着的不算；两个在等谁都不算", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(1, "c-me"));
    expect(book.answerable("c-codex", none)?.callerChannelId).toBe("c-me");
    expect(book.answerable("c-codex", (c) => c.callerChannelId === "c-me")).toBeUndefined();
    book.add("c-codex", call(2, "c-pi", "agent-pi"));
    expect(book.answerable("c-codex", none)).toBeUndefined();
    expect(book.answerable("c-codex", (c) => c.callerChannelId === "c-pi")?.callerChannelId).toBe("c-me"); // pi 的还押着 → 只剩 me
  });

  test("takeAmbiguity：多个在等时返回这批并只提醒一次；新来一个再提醒", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(1, "c-me"));
    expect(book.takeAmbiguity("c-codex", none, 10)).toEqual([]);
    book.add("c-codex", call(2, "c-pi", "agent-pi"));
    const first = book.takeAmbiguity("c-codex", none, 10);
    expect(first.map((c) => c.callerName).sort()).toEqual(["agent-claudestra", "agent-pi"]);
    expect(ambiguityNotice(first)).toContain("2 个 agent 同时在等你的答复");
    expect(book.takeAmbiguity("c-codex", none, 20)).toEqual([]);
    book.add("c-codex", call(3, "c-mem0", "agent-mem0"));
    expect(book.takeAmbiguity("c-codex", none, 30)).toHaveLength(3);
  });

  test("touch：给了 caller 只动那一槽，否则 target 名下全部；落盘", () => {
    const p = join(dir, "c.json");
    const book = new AgentCallBook(p);
    book.add("c-codex", call(1000, "c-me"));
    book.add("c-codex", call(1000, "c-pi", "agent-pi"));
    book.touch("c-codex", "c-me", 5000);
    const back = new AgentCallBook(p);
    expect(back.slot("c-codex", "c-me")?.ts).toBe(5000);
    expect(back.slot("c-codex", "c-pi")?.ts).toBe(1000);
    book.touch("c-codex", undefined, 7000);
    expect(new AgentCallBook(p).forTarget("c-codex").map((c) => c.ts)).toEqual([7000, 7000]);
  });

  test("dropChannel：这个频道作为 target 或 caller 的槽全清", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(1, "c-me"));
    book.add("c-pi", call(1, "c-me"));
    book.add("c-me", call(1, "c-pi", "agent-pi"));
    book.add("c-codex", call(1, "c-pi", "agent-pi"));
    expect(book.dropChannel("c-me")).toBe(3);
    expect(book.forTarget("c-codex").map((c) => c.callerChannelId)).toEqual(["c-pi"]);
  });

  test("老格式（key = target）启动时迁成按槽存，内容不丢", () => {
    const p = join(dir, "old.json");
    writeFileSync(p, JSON.stringify({ "c-codex": call(1000) }));
    const book = new AgentCallBook(p);
    expect(book.slot("c-codex", "c-me")?.expecting).toBe("按意见改设计稿");
    expect(new AgentCallBook(p).answerable("c-codex", none)?.targetChannelId).toBe("c-codex");
  });

  test("坏文件 / 形状不对：不抛、不恢复，原文件挪成 .corrupt-* 保留，之后正常落盘", () => {
    const sub = mkdtempSync(join(dir, "bad-"));
    const p = join(sub, "d.json");
    writeFileSync(p, "{not json");
    expect(new AgentCallBook(p).size).toBe(0);
    writeFileSync(p, JSON.stringify({ "c-codex": { callerChannelId: "c-me" } }));
    const book = new AgentCallBook(p);
    expect(book.size).toBe(0);
    const kept = readdirSync(sub).filter((f) => f.startsWith("d.json.corrupt-"));
    expect(kept.length).toBe(2);
    expect(kept.map((f) => readFileSync(join(sub, f), "utf8")).sort()).toEqual(['{"c-codex":{"callerChannelId":"c-me"}}', "{not json"]);
    book.add("c-codex", call(1));
    expect(new AgentCallBook(p).slot("c-codex", "c-me")?.ts).toBe(1);
  });
});
