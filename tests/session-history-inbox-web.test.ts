/**
 * i28-IBX1：收件箱拆出的消息 seq = 工具结果行号 + 0.01·k，网页气泡 id = h<行号>.0k。
 * 网页按 h<seq> 取行号的地方（差量去重、滚动锚点、隐藏）和隐藏接口都要认它（审查 fractional-seq）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallBook } from "../src/bridge/agent-calls.js";
import { HeldQueue } from "../src/bridge/held-queue.js";
import { initInbox, takeInbox } from "../src/bridge/inbox.js";
import { setWebStatePathForTest } from "../src/bridge/local-api/db.js";
import { handleLocalApi } from "../src/bridge/local-api/index.js";
import type { Envelope, LocalEndpoint } from "../src/bridge/router.js";
import type { Principal } from "../src/lib/principals.js";
import { readSessionHistory } from "../src/lib/session-history.js";
import { closeWebState } from "../src/lib/web-state.js";
import { toChatMessages, type NeutralMessage } from "../web/lib/chat/history-shape";
import { dropCoveredDelta } from "../web/features/chat/live-merge";
import { seqOfId } from "../web/features/chat/scroll-anchor";

const SID = "d9b485ef-dcd2-4609-8e0a-07c6a5515a99";
const OWNER: Principal = { id: "owner:self", role: "owner", agents: ["*", "master"], createdAt: "2026-01-01T00:00:00Z", manage: true, credential: "dev_o1" };
const me = { tag: "ws" } as never;
const to = { kind: "local", agentName: "agent-claudestra", channelId: "c-me", ws: me } as LocalEndpoint;
const note = (id: string, agentName: string, content: string) => ({
  env: {
    from: { kind: "local", agentName, channelId: `c-${agentName}`, ws: me }, to, intent: "request", content,
    meta: { messageId: id, triggerKind: "agent_tool", ts: "2026-10-03T00:00:00Z", threadId: `thr-${id}` },
  } as Envelope,
  to, heldAt: 0,
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "sh-inbox-web-"));
  setWebStatePathForTest(join(dir, "web-state.sqlite"));
});
afterAll(() => {
  setWebStatePathForTest(undefined);
  closeWebState(join(dir, "web-state.sqlite"));
  rmSync(dir, { recursive: true, force: true });
});

async function rows() {
  const held = new HeldQueue(null);
  held.set("c-me", [note("agent_a", "scheduler", "第一条"), note("agent_b", "agent-codex", "第二条")]);
  initInbox({ clients: new Map([["c-me", { ws: me }]]), held, calls: new AgentCallBook(null), render: async (e) => e.content, emitIn: () => {}, stoppedAt: () => undefined });
  const r = await takeInbox(me, 1000);
  if ("error" in r) throw new Error(r.error);
  const ts = "2026-10-03T01:00:00Z";
  const recs = [
    { type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__claudestra__check_inbox", input: {} }] } },
    { type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: r.result.text }] } },
  ];
  const p = join(dir, `s${Math.random()}.jsonl`);
  writeFileSync(p, recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const ms = (await readSessionHistory(p)).messages as unknown as NeutralMessage[];
  return { ms, chat: toChatMessages(ms, { sid: SID }) };
}

describe("收件箱拆出的消息：网页行号协议兼容", () => {
  test("气泡 id 是 h<行号>.0k；滚动锚点取得到 seq；差量去重认得已覆盖的", async () => {
    const { chat } = await rows();
    const inbox = chat.filter((m) => m.role === "user");
    expect(inbox.map((m) => m.id)).toEqual(["h1.01", "h1.02"]);
    expect(inbox.map((m) => seqOfId(m.id))).toEqual([1.01, 1.02]);
    expect(dropCoveredDelta(chat, chat)).toEqual([]);
    expect(dropCoveredDelta(chat.slice(0, 2), chat).map((m) => m.id)).toEqual(["h1.02"]);
  });

  test("隐藏：接口接受 h<行号>.0k 的区间，只隐藏这一条", async () => {
    const url = "http://bridge.local/api/v1/agents/worker/hidden";
    const call = (body: unknown) =>
      handleLocalApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(url), OWNER);
    const res = (await call({ sessionId: SID, fromSeq: 1.01, toSeq: 1.01, hide: true }))!;
    expect(res.status).toBe(200);
    const { ms } = await rows();
    const ranges = ((await res.json()) as { ranges: { fromSeq: number; toSeq: number }[] }).ranges;
    const isHidden = (seq: number) => ranges.some((r) => seq >= r.fromSeq && seq <= r.toSeq);
    expect(toChatMessages(ms, { sid: SID, isHidden }).filter((m) => m.role === "user").map((m) => m.id)).toEqual(["h1.02"]);
    expect((await call({ sessionId: SID, fromSeq: 1.01, hide: false }))!.status).toBe(200);
    expect((await call({ sessionId: SID, fromSeq: 1.5 }))!.status).toBe(400); // 行号仍然只认整数和收件箱的子条目
    expect((await call({ sessionId: SID, fromSeq: 1.001 }))!.status).toBe(400);
  });
});
