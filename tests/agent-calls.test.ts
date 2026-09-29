/**
 * bridge/agent-calls.ts：send_to_agent 回程路由簿——每个 (target, caller) 一槽、落盘（bridge 重启后答复仍推回发起方）、
 * 老格式迁移、没指明答给谁时只在恰好一个 caller 在等才算、多个在等只提醒一次、坏文件不让 bridge 起不来。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook, ambiguityNotice, expiredNotice, type PendingAgentCall } from "../src/bridge/agent-calls.js";

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

describe("撞错后的槽（T24）", () => {
  test("send_to_agent 投递失败只撤那一条：不是答复，扣下的话不推、等续跑标记不清（adv1 P2-5）", () => {
    const book = new AgentCallBook(null);
    const pushed: string[][] = [];
    book.onWithheld = (p) => void pushed.push(p.withheld ?? []);
    book.add("c-codex", call(1), "m1");
    book.markApiError("c-codex", none, "（给我的）半句", "c-me", 5);
    book.add("c-codex", call(9), "m2");
    book.dropRequest("c-codex", "c-me", "m2");
    expect(pushed).toEqual([]);
    expect(book.slot("c-codex", "c-me")!.requests).toMatchObject([{ messageId: "m1", apiErrorAt: 5, withheld: ["（给我的）半句"] }]);
  });

  test("target 被关掉：等续跑的槽经 onExpired 告诉 caller（附扣下的话），别的槽照旧静默删（wf delivery-hold-8）", () => {
    const book = new AgentCallBook(null);
    const gone: string[] = [];
    book.onExpired = (p, why) => void gone.push(`${p.callerChannelId}:${why}:${p.withheld?.join("") ?? ""}`);
    book.add("c-codex", call(1), "m1");
    book.add("c-codex", call(1, "c-b", "agent-b"), "m2");
    book.markApiError("c-codex", none, "半句", "c-me", 5);
    book.add("c-codex", call(1, "c-late", "agent-late"), "m3");
    expect(book.dropChannel("c-codex")).toBe(3);
    expect(gone).toEqual(["c-me:之后它被关掉了:半句", "c-b:之后它被关掉了:"]);
  });
});

describe("逐条过期（T6c1：同一槽 q1 已送、q2 押着，扫描不能整槽删）", () => {
  const H = 3_600_000;
  const STALE = 2 * H;
  const heldIds = (...ids: string[]) => () => ids.map((messageId) => ({ fromKind: "local", fromChannelId: "c-me", messageId }));
  const ids = (c?: PendingAgentCall) => c?.requests?.map((r) => r.messageId);

  test("A1 场景：过了 2 小时 q1 过期、q2 的回程保留；q2 送到后能推回，再过 2 小时才过期", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", { ...call(0), expecting: "改设计稿" }, "q1");
    book.add("c-codex", { ...call(10 * 60_000), expecting: "再跑测试" }, "q2");
    const gone = book.sweepStale(2 * H + 11 * 60_000, STALE, heldIds("q2"));
    expect(gone.map(ids)).toEqual([["q1"]]);
    expect(ids(book.slot("c-codex", "c-me"))).toEqual(["q2"]);
    expect(book.answerable("c-codex", (r) => r.messageId === "q2")).toBeUndefined(); // 还押着：它没看到
    // q2 在 3 小时时真正送到（押后投递）
    book.touchDelivered("c-codex", { from: { kind: "local", channelId: "c-me" }, meta: { messageId: "q2" } } as never, 3 * H);
    expect(book.sweepStale(3 * H + 60_000, STALE, heldIds())).toEqual([]);
    const v = book.answerable("c-codex", none)!;
    expect(v.expecting).toBe("再跑测试");
    expect(ids(v)).toEqual(["q2"]);
    expect(book.sweepStale(5 * H + 1, STALE, heldIds()).map(ids)).toEqual([["q2"]]);
    expect(book.slot("c-codex", "c-me")).toBeUndefined();
  });

  test("touch 带 message_id 只动那一条；对不上的不动已有请求的钟（老数据没记 id 的照旧跟着刷）；不带 = 整槽重置", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(0), "q1");
    book.add("c-codex", call(0), "q2");
    book.touch("c-codex", "c-me", 5000, "q2");
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.deliveredAt)).toEqual([0, 5000]);
    book.touch("c-codex", "c-me", 7000, "reply_fwd_x");
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.deliveredAt)).toEqual([0, 5000]);
    expect(book.slot("c-codex", "c-me")!.ts).toBe(0);
    book.add("c-codex", call(0, "c-old", "agent-old")); // 没记 id 的老式请求：没法按 id 对，照旧跟着这个 caller 的送达刷
    book.touch("c-codex", "c-old", 8000, "whatever");
    expect(book.slot("c-codex", "c-old")!.requests!.map((r) => r.deliveredAt)).toEqual([8000]);
    book.touch("c-codex", "c-me", 9000); // 额度闸出闸：显式整槽重置
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => r.deliveredAt)).toEqual([9000, 9000]);
    expect(book.slot("c-codex", "c-me")!.ts).toBe(9000);
  });

  test("r1 P1-1：同一 caller 每小时一条押后送达的 oneShot 通知（不登记回程），不会让早已送到的 q1 永不过期", () => {
    const book = new AgentCallBook(null);
    book.add("c-codex", call(H), "q1");
    const gone: string[] = [];
    for (let h = 2; h <= 4; h++) {
      book.touchDelivered("c-codex", { from: { kind: "local", channelId: "c-me" }, meta: { messageId: `note${h}` } } as never, h * H);
      book.touchDelivered("c-codex", { from: { kind: "user" }, meta: { messageId: `human${h}` } } as never, h * H); // 人类消息不碰回程簿
      gone.push(...book.sweepStale(h * H + 60_000, STALE, heldIds()).flatMap((c) => c.messageIds ?? []));
    }
    expect(gone).toEqual(["q1"]); // 3h+1min 那次扫描就删了（送达于 1h）
    expect(book.slot("c-codex", "c-me")).toBeUndefined();
  });

  test("老数据兼容：请求没记送达时刻回落槽级 ts；#116 老槽 q2 押着时只删 q1", () => {
    const p = join(dir, "legacy-sweep.json");
    writeFileSync(p, JSON.stringify({
      ["c-codex\u001fc-me"]: { ...call(0), ts: H, targetChannelId: "c-codex", requests: [{ messageId: "q1", ts: 0 }] },
      ["c-codex\u001fc-pi"]: { ...call(0, "c-pi", "agent-pi"), targetChannelId: "c-codex", messageIds: ["q1", "q2"] },
    }));
    const book = new AgentCallBook(p);
    const heldPi = () => [{ fromKind: "local", fromChannelId: "c-pi", messageId: "q2" }];
    expect(book.sweepStale(3 * H - 1, STALE, heldPi).map((c) => c.callerChannelId)).toEqual(["c-pi"]); // me 的槽级 ts 是 1h，还没到
    expect(ids(book.slot("c-codex", "c-pi"))).toEqual(["q2"]);
    expect(book.sweepStale(3 * H + 1, STALE, heldPi).map((c) => c.callerChannelId)).toEqual(["c-me"]);
    expect(ids(new AgentCallBook(p).slot("c-codex", "c-pi"))).toEqual(["q2"]); // 落盘
  });

  test("撞错时看到的几条回复频道相同：扣到最后一条；整槽过期每条各发一条通知，扣下的话只随它自己那条", () => {
    const book = new AgentCallBook(null);
    const sent: [string | undefined, string][] = [];
    book.onExpired = (p) => void sent.push([p.originalReplyChannel, p.withheld?.join("") ?? ""]);
    book.add("c-codex", { ...call(0), originalReplyChannel: "A" }, "q1");
    book.add("c-codex", { ...call(0), originalReplyChannel: "A" }, "q2");
    expect(book.markApiError("c-codex", none, "半句", "c-me", 60_000)).toBe("c-me");
    book.sweepStale(2 * H + 1, STALE, heldIds());
    expect(sent).toEqual([["A", ""], ["A", "半句"]]);
    expect(book.slot("c-codex", "c-me")).toBeUndefined();
  });

  test("撞错时看到的几条回复频道不一样：对不上是答哪条的，不扣（交给 stop-settle 告诉 owner）；过期各发一条空通知", () => {
    const book = new AgentCallBook(null);
    const sent: [string | undefined, string][] = [];
    book.onExpired = (p) => void sent.push([p.originalReplyChannel, p.withheld?.join("") ?? ""]);
    book.add("c-codex", { ...call(0), originalReplyChannel: "A" }, "q1");
    book.add("c-codex", { ...call(0), originalReplyChannel: "B" }, "q2");
    expect(book.markApiError("c-codex", none, "半句", "c-me", 60_000)).toBeUndefined();
    book.sweepStale(2 * H + 1, STALE, heldIds());
    expect(sent).toEqual([["A", ""], ["B", ""]]);
  });

  test("部分过期：等续跑和扣下的话只跟自己那条走——q1 过期带走自己的，押着的 q2 没有；q2 之后被答不会再推", () => {
    const book = new AgentCallBook(null);
    const sent: string[] = [];
    book.onExpired = (p) => void sent.push(`${ids(p)}:${p.withheld?.join("") ?? ""}`);
    book.onWithheld = () => void sent.push("withheld-again");
    book.add("c-codex", call(0), "q1");
    book.markApiError("c-codex", none, "半句", "c-me", 60_000);
    book.add("c-codex", call(60_000), "q2");
    book.sweepStale(2 * H + 1, STALE, heldIds("q2"));
    expect(sent).toEqual(["q1:半句"]);
    expect(book.slot("c-codex", "c-me")!.requests).toEqual([expect.objectContaining({ messageId: "q2" })]);
    expect(book.slot("c-codex", "c-me")!.requests![0]).not.toHaveProperty("withheld");
    book.consume("c-codex", "c-me", book.exact("c-codex", "c-me", none));
    expect(sent).toEqual(["q1:半句"]);

    const b2 = new AgentCallBook(null);
    const sent2: string[] = [];
    b2.onExpired = (p) => void sent2.push(`${ids(p)}:${p.withheld?.join("") ?? ""}`);
    b2.add("c-codex", call(0), "q1");
    b2.add("c-codex", call(H), "q2");
    b2.markApiError("c-codex", none, "半句", "c-me", H + 60_000); // 同一回复频道：扣到看到的最后一条 q2
    b2.sweepStale(2 * H + 1, STALE, heldIds());
    expect(sent2).toEqual(["q1:"]);
    expect(b2.slot("c-codex", "c-me")!.requests).toMatchObject([{ messageId: "q2", apiErrorAt: H + 60_000, withheld: ["半句"] }]);
  });

  test("r1 P1-2：q1 撞错扣下的话、q2 后送到（不同回复频道）、q1 单独过期 → 那句话随 q1 的通知发到 q1 的频道，不留给 q2", () => {
    const book = new AgentCallBook(null);
    const sent: string[] = [];
    book.onExpired = (p) => void sent.push(`expired:${ids(p)}:${p.originalReplyChannel}:${p.withheld?.join("") ?? ""}`);
    book.onWithheld = (p) => void sent.push(`withheld:${p.originalReplyChannel}:${p.withheld?.join("") ?? ""}`);
    book.add("c-codex", { ...call(0), originalReplyChannel: "chan-q1" }, "q1");
    book.markApiError("c-codex", none, "q1 的半句", "c-me", 60_000);
    book.add("c-codex", { ...call(H), originalReplyChannel: "chan-q2" }, "q2");
    book.sweepStale(2 * H + 1, STALE, heldIds());
    expect(sent).toEqual(["expired:q1:chan-q1:q1 的半句"]);
    expect(book.slot("c-codex", "c-me")!.requests!.map((r) => [r.messageId, r.apiErrorAt, r.withheld])).toEqual([["q2", undefined, undefined]]);
    book.consume("c-codex", "c-me", book.exact("c-codex", "c-me", none));
    expect(sent).toHaveLength(1); // q2 被答掉时没有别人的话可推
  });

  test("扣下的话被直接答掉时推到撞错那一轮请求的频道，不是槽里最后一条（后来的 q2）的", () => {
    const book = new AgentCallBook(null);
    const sent: string[] = [];
    book.onWithheld = (p) => void sent.push(`${p.originalReplyChannel}:${p.withheld?.join("")}`);
    book.add("c-codex", { ...call(0), originalReplyChannel: "chan-q1" }, "q1");
    book.markApiError("c-codex", none, "半句", "c-me", 60_000);
    book.add("c-codex", { ...call(H), originalReplyChannel: "chan-q2" }, "q2");
    book.consume("c-codex", "c-me", book.exact("c-codex", "c-me", none));
    expect(sent).toEqual(["chan-q1:半句"]);
  });

  test("r2：q1、q2 先后两次撞错（不同回复频道）→ 各自的话只在各自那条上；q1 过期带走 q1 的，q2 被答只推 q2 的", () => {
    const book = new AgentCallBook(null);
    const sent: string[] = [];
    book.onExpired = (p) => void sent.push(`expired:${ids(p)}:${p.originalReplyChannel}:${p.withheld?.join("|") ?? ""}`);
    book.onWithheld = (p) => void sent.push(`withheld:${ids(p)}:${p.originalReplyChannel}:${p.withheld?.join("|") ?? ""}`);
    book.add("c-codex", { ...call(0), originalReplyChannel: "chan-q1" }, "q1");
    book.markApiError("c-codex", none, "q1 的半句", "c-me", 60_000);
    book.add("c-codex", { ...call(H), originalReplyChannel: "chan-q2" }, "q2");
    // 第二次撞错时它看到 q1、q2 两条、频道不一样：这一轮的话对不上是答哪条的，不扣（stop-settle 告诉 owner）
    expect(book.markApiError("c-codex", none, "q2 的半句", "c-me", H + 60_000)).toBeUndefined();
    book.sweepStale(2 * H + 1, STALE, heldIds());
    expect(sent).toEqual(["expired:q1:chan-q1:q1 的半句"]);
    book.consume("c-codex", "c-me", book.exact("c-codex", "c-me", none));
    expect(sent).toEqual(["expired:q1:chan-q1:q1 的半句"]); // q2 那条上没有别人的话
  });

  test("r2：两次撞错各看到一条（q1 答掉前 q2 还押着）→ 各扣各的，q2 过期只带 q2 的", () => {
    const book = new AgentCallBook(null);
    const sent: string[] = [];
    book.onExpired = (p) => void sent.push(`${ids(p)}:${p.originalReplyChannel}:${p.withheld?.join("|") ?? ""}`);
    book.add("c-codex", { ...call(0), originalReplyChannel: "chan-q1" }, "q1");
    book.add("c-codex", { ...call(0), originalReplyChannel: "chan-q2" }, "q2");
    book.markApiError("c-codex", (r) => r.messageId === "q2", "q1 的半句", "c-me", 60_000);
    book.markApiError("c-codex", (r) => r.messageId === "q1", "q2 的半句", "c-me", 2 * 60_000); // 假想：只看到 q2 的那一轮
    book.sweepStale(3 * H, STALE, heldIds());
    expect(sent).toEqual(["q1:chan-q1:q1 的半句", "q2:chan-q2:q2 的半句"]);
  });

  test("老格式槽级扣下的话：只有一条归属就挂到它上面；归属不清不推，过期通知里说一句", () => {
    const p = join(dir, "legacy-withheld.json");
    writeFileSync(p, JSON.stringify({
      ["c-codex\u001fc-me"]: { ...call(0), targetChannelId: "c-codex", apiErrorAt: 60_000, withheld: ["我的半句"], requests: [{ messageId: "q1", ts: 0 }] },
      ["c-codex\u001fc-pi"]: { ...call(0, "c-pi", "agent-pi"), targetChannelId: "c-codex", apiErrorAt: 60_000, withheld: ["谁的半句"],
        requests: [{ messageId: "p1", ts: 0, originalReplyChannel: "X" }, { messageId: "p2", ts: 0, originalReplyChannel: "Y" }] },
      ["c-codex\u001fc-r1"]: { ...call(0, "c-r1", "agent-r1"), targetChannelId: "c-codex", apiErrorAt: 60_000, withheld: ["r 的半句"], apiErrorFor: ["r1"],
        requests: [{ messageId: "r1", ts: 0 }, { messageId: "r2", ts: 0 }] },
    }));
    const book = new AgentCallBook(p);
    expect(book.slot("c-codex", "c-me")!.requests).toMatchObject([{ messageId: "q1", apiErrorAt: 60_000, withheld: ["我的半句"] }]);
    expect(book.slot("c-codex", "c-r1")!.requests).toMatchObject([{ messageId: "r1", withheld: ["r 的半句"] }, { messageId: "r2" }]);
    expect(book.slot("c-codex", "c-r1")!.requests![1]).not.toHaveProperty("withheld");
    expect(book.slot("c-codex", "c-me")!.withheld).toBeUndefined();
    const sent: string[] = [];
    book.onExpired = (x) => void sent.push(expiredNotice(x));
    book.sweepStale(3 * H, STALE, () => []);
    const pi = sent.filter((t) => t.includes("归属不明"));
    expect(pi).toHaveLength(2);
    expect(sent.join("\n")).not.toContain("谁的半句");
    expect(new AgentCallBook(p).size).toBe(0);
  });
});
