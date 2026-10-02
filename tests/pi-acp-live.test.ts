/**
 * Pi 走 ACP 时的网页直播（端到端，不起 pi）：适配器的事件映射（pi-adapter/map.ts）→ 宿主翻译器（lib/acp/updates.ts）→ bridge 推送模式的 watcher，
 * 看网页实际收到的事件：自动压缩出 compact_done（📦 + ctx 回落）、自动重试 / 思考是进度句、Edit / Write 的工具卡带 diff / 内容。
 */
import { describe, expect, test } from "bun:test";
import { noteAcpChannel } from "../src/bridge/acp-state.ts";
import { subscribeEvents } from "../src/bridge/event-bus.ts";
import { pushEntries, startWatching, stopWatching } from "../src/bridge/jsonl-watcher.ts";
import { createPiEventMapper } from "../src/lib/acp/pi-adapter/map.ts";
import { createAcpTranslator } from "../src/lib/acp/updates.ts";

const CH = "local-pi-acp-live";
const AG = "agent-pi-acp-live";
const discord = {} as any;

describe("Pi ACP 直播：pi 事件 → 网页事件", () => {
  test("自动压缩 → compact_done；自动重试 / 思考 → 进度句；Edit / Write 工具卡带 diff / 内容", async () => {
    noteAcpChannel(CH, "acp");
    await startWatching(AG, "/w", "sid-live", CH, discord, { transport: "acp", runtime: "pi" });
    const events: any[] = [];
    const unsub = subscribeEvents({}, (e) => void (e.chatId === CH && events.push(e)));
    try {
      const m = createPiEventMapper();
      const t = createAcpTranslator();
      const feed = async (...evs: Record<string, unknown>[]) => {
        const entries = evs.flatMap((e) => m.push(e)).flatMap((u) => t.push(u));
        if (entries.length) expect(await pushEntries(CH, entries, discord)).toEqual({ ok: true, lost: 0 });
      };
      await feed({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "529 overloaded" });
      await feed(
        { type: "message_start", message: { role: "assistant" } },
        { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "改一下常量" } },
        { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "/w/a.ts", edits: [{ oldText: "a = 1", newText: "a = 2" }] } },
        { type: "tool_execution_start", toolCallId: "w1", toolName: "write", args: { path: "/w/b.md", content: "hello" } },
      );
      await feed({ type: "compaction_start", reason: "threshold" });
      await feed({ type: "compaction_end", reason: "threshold", result: { tokensBefore: 150_000, estimatedTokensAfter: 32_000 }, aborted: false, willRetry: false });

      const progress = events.filter((e) => e.type === "assistant_text").map((e) => [e.data.text, e.data.progress]);
      expect(progress).toEqual([
        ["请求出错：529 overloaded，2 秒后自动重试（1/3）", true], ["改一下常量", true], ["正在自动压缩上下文…", true],
      ]);
      const tools = events.filter((e) => e.type === "tool_start").map((e) => [e.data.name, e.data.summary, e.data.detail]);
      expect(tools).toEqual([
        ["Edit", "✏️ Edit a.ts", "/w/a.ts\n─── old ───\na = 1\n─── new ───\na = 2"],
        ["Write", "📝 Write b.md", "/w/b.md\n───\nhello"],
      ]);
      expect(events.find((e) => e.type === "compact_done")?.data).toEqual({ preTokens: 150_000, postTokens: 32_000, trigger: "auto" });
    } finally {
      unsub();
      stopWatching(AG);
    }
  });
});
