/**
 * bridge/held-queue.ts：agent→agent 押后队列落盘（bridge 重启不丢、ws 不落盘）、投出去之后才持久化出队、
 * 押满 30 分钟只提醒一次发送方、24 小时才放弃。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ageHeld, HELD_GIVE_UP_MS, HELD_NOTIFY_MS, heldNoticeText, HeldQueue, type HeldItem } from "../src/bridge/held-queue.js";

const dir = mkdtempSync(join(tmpdir(), "held-queue-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ws = { send: () => undefined, secret: "进程内对象" } as never;
const item = (content: string, heldAt: number): HeldItem => ({
  env: {
    from: { kind: "local", agentName: "agent-codex", channelId: "c-codex", ws },
    to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws },
    intent: "request", content,
    meta: { messageId: `m-${content}`, triggerKind: "agent_tool", ts: "2026-09-28T00:00:00Z", threadId: "thr_1" },
  } as HeldItem["env"],
  to: { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws },
  heldAt,
});

describe("HeldQueue 落盘", () => {
  test("set 之后落盘、不带 ws；重启（新实例）原样恢复", () => {
    const p = join(dir, "a.json");
    const q = new HeldQueue(p);
    q.set("c-me", [item("复核 1/7", 1000), item("复核 2/7", 2000)]);
    const raw = readFileSync(p, "utf8");
    expect(raw).not.toContain("进程内对象");
    const again = new HeldQueue(p);
    const back = again.get("c-me")!;
    expect(back.map((i) => i.env.content)).toEqual(["复核 1/7", "复核 2/7"]);
    expect(back[0].to.ws).toBeUndefined();
    expect(back[0].env.meta.messageId).toBe("m-复核 1/7");
  });

  test("投递中别处 set 触发整表落盘，未投出的那条仍在盘上；投出后 remove 才消失", () => {
    const p = join(dir, "b.json");
    const q = new HeldQueue(p);
    const a = item("a", 1), b = item("b", 2);
    q.set("c-me", [a, b]);
    q.set("c-other", [item("x", 3)]); // 投 a 的 await 期间别的频道入队
    expect(new HeldQueue(p).get("c-me")!.map((i) => i.env.content)).toEqual(["a", "b"]);
    q.remove("c-me", a);
    expect(new HeldQueue(p).get("c-me")!.map((i) => i.env.content)).toEqual(["b"]);
    q.remove("c-me", b);
    expect(new HeldQueue(p).has("c-me")).toBe(false);
  });

  test("claim：同一频道同一时刻只有一个投递者，release 之后可再领", () => {
    const q = new HeldQueue(null);
    expect(q.claim("c-me")).toBe(true);
    expect(q.claim("c-me")).toBe(false);
    expect(q.claim("c-other")).toBe(true);
    q.release("c-me");
    expect(q.claim("c-me")).toBe(true);
  });

  test("文件坏了：不恢复、不抛", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, '{"c-me": [{"nope": 1}]}');
    expect(new HeldQueue(p).size).toBe(0);
  });
});

describe("ageHeld", () => {
  test("30 分钟内不打扰；过了 30 分钟只提醒一次、消息留着；24 小时放弃并出队", () => {
    const q = new HeldQueue(null);
    const now = 10 * HELD_GIVE_UP_MS;
    q.set("c-me", [item("new", now - 60_000), item("old", now - HELD_NOTIFY_MS - 1), item("ancient", now - HELD_GIVE_UP_MS - 1)]);
    const first = ageHeld(q, now);
    expect(first.map((n) => `${n.kind}:${n.item.env.content}`)).toEqual(["still-queued:old", "gave-up:ancient"]);
    expect(q.get("c-me")!.map((i) => i.env.content)).toEqual(["new", "old"]);
    expect(ageHeld(q, now + 60_000)).toEqual([]);
    expect(heldNoticeText(first[0])).toContain("不用重发");
    expect(heldNoticeText(first[1])).toContain("已放弃");
  });
});
