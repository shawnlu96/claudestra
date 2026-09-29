/**
 * web/features/quota-wall/held-send.ts + view-compose survivingPending：发出去的消息被 bridge 押住（heldBy）时不进「正在回复」、
 * 气泡下插说明、乐观气泡过了 30 分钟也保着（T24 wf notify-web-rules-1）。
 */
import { describe, expect, test } from "bun:test";
import { heldSendNotice, markHeldSend } from "../web/features/quota-wall/held-send";
import { PENDING_KEEP_MS, survivingPending } from "../web/features/chat/view-compose";
import type { ChatMessage } from "../web/features/chat/type";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("押住的发送", () => {
  test("停在额度菜单：解除正在回复、气泡标 held、插一条「没发键、等你处理」", () => {
    const opt: ChatMessage = { id: "l1", role: "user", content: "你先停一下", local: true, ts: new Date(0).toISOString() };
    const s = { messages: [opt], streaming: true, awaitingChunk: true };
    markHeldSend(s, "l1", "wall_menu", "n1", true, "t");
    expect(s).toMatchObject({ streaming: false, awaitingChunk: false });
    expect(opt.held).toBe(true);
    expect(s.messages[1]).toEqual({ id: "n1", role: "system", content: heldSendNotice("wall_menu", true), ts: "t" });
    expect(heldSendNotice("wall_menu", true)).toContain("没有发任何键");
    expect(heldSendNotice("quota_wall", true)).toContain("出闸后");
  });

  test("非全权设备 / guest 只拿到 queued：同样解除「正在回复」、气泡标 held，说明不提额度（wf2 notify-web-rules-2）", () => {
    const s = { messages: [{ id: "l1", role: "user", content: "hi", local: true, ts: "t0" } as ChatMessage], streaming: true, awaitingChunk: true };
    markHeldSend(s, "l1", "queued", "n1", true, "t");
    expect(s.streaming).toBe(false);
    expect(s.messages[0]!.held).toBe(true);
    for (const zh of [true, false]) expect(heldSendNotice("queued", zh)).not.toMatch(/额度|usage|limit/i);
  });

  test("押住的乐观气泡过了 30 分钟还在视图里；普通的照旧按 30 分钟放手", () => {
    const at = Date.parse("2026-09-29T00:00:00Z");
    const held: ChatMessage = { id: "l1", role: "user", content: "押着的", local: true, held: true, ts: new Date(at).toISOString() };
    const plain: ChatMessage = { ...held, id: "l2", content: "普通的", held: undefined };
    expect(survivingPending([held, plain], [], at + PENDING_KEEP_MS + 60_000).map((m) => m.id)).toEqual(["l1"]);
  });

  test("说明行对齐后没了，气泡自己仍带「押着」标记（wf3 delivery-hold-6）", () => {
    const opt: ChatMessage = { id: "l1", role: "user", content: "停", local: true, ts: new Date(0).toISOString() };
    const s = { messages: [opt], streaming: true, awaitingChunk: true };
    markHeldSend(s, "l1", "queued", "n1", true, "t");
    const view = survivingPending(s.messages, [{ id: "h1", role: "assistant", content: "之前的回复" }], 60_000);
    expect(view.map((m) => [m.id, m.held])).toEqual([["l1", true]]); // 系统说明行不在了，押着的气泡还在、还带 held
    const src = readFileSync(join(import.meta.dir, "../web/features/chat/components/message-list.tsx"), "utf8");
    expect(src).toContain("{m.held && !m.failed && <HeldMark />}");
    expect(readFileSync(join(import.meta.dir, "../web/features/quota-wall/held-mark.tsx"), "utf8")).not.toMatch(/额度|usage|limit/i);
  });
});
