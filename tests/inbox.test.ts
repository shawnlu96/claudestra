/**
 * bridge/inbox.ts：agent 调 check_inbox 领取排队给它的 agent 消息——领取是租约不是出队（ack 才出队、过期可重领）、
 * 和 Stop 投递共用频道锁、一批最多 10 条 / 16000 字、人类消息不碰、认不出调用方就报错。
 */
import { describe, expect, test } from "bun:test";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { HeldQueue, INBOX_LEASE_MS, leaseActive, unseenFrom, type HeldItem } from "../src/bridge/held-queue.js";
import { callStillHeld } from "../src/lib/held-pac.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";

const me = { tag: "claudestra-ws" } as never;
const item = (content: string, kind: "local" | "user" = "local", heldAt = 0): HeldItem => ({
  env: {
    from: kind === "local" ? { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws: me } : { kind: "user", userId: "u1", username: "owner" },
    to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me },
    intent: "request", content,
    meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: "thr_1" },
  } as HeldItem["env"],
  to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me },
  heldAt,
});

function setup(items: HeldItem[]) {
  const held = new HeldQueue(null);
  const calls = new AgentCallBook(null);
  if (items.length) held.set("c-me", items);
  calls.add("c-me", { callerChannelId: "c-codex", callerName: "agent-codex", targetName: "agent-claudestra", ts: 1 });
  const mirrored: string[] = [];
  initInbox({
    clients: new Map([["c-me", { ws: me }]]),
    held, calls,
    render: async (env) => `[🤖 来自 ${env.from.kind === "local" ? env.from.agentName : "?"}]\n${env.content}`,
    emitIn: (_c, env) => mirrored.push(String(env.content)),
  });
  return { held, calls, mirrored };
}

describe("takeInbox", () => {
  test("领取：带批次号 / 来源 / message_id，不出队只落租约，网页镜像，回程钟重起；人类消息不碰", async () => {
    const { held, calls, mirrored } = setup([item("复核意见 1", "local", 0), item("人类补充", "user"), item("复核意见 2", "local", 0)]);
    const r = await takeInbox(me, 5 * 60_000);
    if ("error" in r) throw new Error(r.error);
    expect(r.result.n).toBe(2);
    expect(r.result.text).toMatch(/收件箱 inbox_\w+：2 条/);
    expect(r.result.text).toContain("1/2 · 来自 agent-codex · message_id=m-复核意见 1 · 排队 5 分钟");
    expect(r.result.text).toMatch(/ack: "inbox_\w+"/);
    const q = held.get("c-me")!;
    expect(q.map((i) => i.env.content)).toEqual(["复核意见 1", "人类补充", "复核意见 2"]); // 还在队里
    expect(q.filter((i) => leaseActive(i, 5 * 60_000)).length).toBe(2);
    expect(mirrored).toEqual(["复核意见 1", "复核意见 2"]);
    expect(calls.slot("c-me", "c-codex")!.ts).toBeGreaterThan(1);
  });

  test("没 ack 再调：原样重给还没确认的那批（工具结果丢了也能重读），不续租、不领新的；过期后照常重领", async () => {
    const { held } = setup([item("a"), item("b")]);
    const first = await takeInbox(me, 1000);
    if ("error" in first) throw new Error(first.error);
    const batch = /inbox_\w+/.exec(first.result.text)![0];
    held.set("c-me", [...held.get("c-me")!, item("c")]);
    const again = await takeInbox(me, 2000);
    if ("error" in again) throw new Error(again.error);
    expect(again.result.text).toContain(`收件箱 ${batch}：2 条。这是你领过还没确认的一批`);
    expect(again.result.text).not.toContain("m-c");
    expect(held.get("c-me")!.filter((i) => i.lease).every((i) => i.lease!.at === 1000)).toBe(true);
    const later = await takeInbox(me, 1000 + INBOX_LEASE_MS + 1);
    expect("result" in later && later.result.n).toBe(3);
  });

  test("领取后没 ack 就回复：回程判定算它看到了（#112 × #114 的组合）", async () => {
    const { held, calls } = setup([item("请复核")]);
    const seen = () => calls.answerable("c-me", (c) => callStillHeld(c, unseenFrom(held, "c-me")));
    expect(seen()).toBeUndefined(); // 还押着、没领：不算
    await takeInbox(me, 1000);
    expect(seen()?.callerChannelId).toBe("c-codex"); // 领了（租约中、未 ack）：算送到了
  });

  test("ack：这批出队并顺带领下一批；错的 / 已确认过的批次号只提示", async () => {
    const { held } = setup(Array.from({ length: 12 }, (_, i) => item(`m${i}`)));
    const r1 = await takeInbox(me, 1000);
    if ("error" in r1) throw new Error(r1.error);
    const batch = /inbox_\w+/.exec(r1.result.text)![0];
    expect(r1.result.text).toContain("还有 2 条");
    const r2 = await takeInbox(me, 2000, { ack: batch });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.result.text).toContain(`已确认 ${batch}（10 条出队）`);
    expect(r2.result.n).toBe(2);
    expect(held.get("c-me")).toHaveLength(2);
    const r3 = await takeInbox(me, 3000, { ack: batch });
    expect("result" in r3 && r3.result.text).toContain("没有待确认的条目");
  });

  test("字数预算：一批不超过 16000 字，单条超长的不放进批（回合结束时完整送达）", async () => {
    const big = (c: string, id: string) => {
      const i = item(c);
      i.env.meta.messageId = id; // helper 的 message_id 带正文，长正文会把抬头也撑长
      return i;
    };
    const { held } = setup([big("x".repeat(9000), "m-x"), big("y".repeat(9000), "m-y"), big("z".repeat(20_000), "m-z")]);
    const r = await takeInbox(me, 1000);
    if ("error" in r) throw new Error(r.error);
    expect(r.result.n).toBe(1);
    expect(r.result.text).toContain("这条共"); // 超长的给开头预览，全文回合结束送达
    expect(held.get("c-me")!.filter((i) => i.lease).length).toBe(1);
  });

  test("超长的一条：预览里给 read 入口；分页读（第一次读就打租约），读完 ack 出队", async () => {
    const big = item("z".repeat(30_000));
    big.env.meta.messageId = "m-big";
    const { held } = setup([big]);
    const r = await takeInbox(me, 1000);
    expect("result" in r && r.result.text).toContain('check_inbox({ read: "m-big" })');
    const p1 = await takeInbox(me, 1000, { read: "m-big" });
    if ("error" in p1) throw new Error(p1.error);
    expect(p1.result.text).toContain("第 1/3 页");
    expect(p1.result.text).toContain('page: 2');
    const batch = held.get("c-me")![0].lease!.batchId;
    const p3 = await takeInbox(me, 2000, { read: "m-big", page: 9 });
    expect("result" in p3 && p3.result.text).toContain("第 3/3 页");
    expect(held.get("c-me")![0].lease!.at).toBe(1000); // 读后面的页不续租
    await takeInbox(me, 3000, { ack: batch });
    expect(held.get("c-me") ?? []).toHaveLength(0);
    const gone = await takeInbox(me, 4000, { read: "m-big" });
    expect("result" in gone && gone.result.text).toContain("没有 message_id=m-big");
  });

  test("空的 / 正在被 Stop 投递（频道锁被占）/ 认不出调用方", async () => {
    const { held } = setup([]);
    const empty = await takeInbox(me);
    expect("result" in empty && empty.result.text).toContain("没有可领取");
    held.set("c-me", [item("x")]);
    held.claim("c-me");
    const busy = await takeInbox(me);
    expect("result" in busy && busy.result.n).toBe(0);
    expect(held.get("c-me")).toHaveLength(1);
    held.release("c-me");
    const stranger = await takeInbox({ tag: "other" } as never);
    expect("error" in stranger).toBe(true);
  });
});
