/**
 * Codex code-mode rollout 的翻译：以 item_completed 为准，exec 包装丢掉。
 *
 * 夹具 tests/fixtures/codex-rollout-tui.jsonl 取自 0.153.4 的真实探针会话（TUI 挂
 * channel-server 调 reply、Stop hook block 后补 reply、sleep 命令）+ 一轮 exec 引导，
 * 路径与个人信息已替换。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexCommandText,
  codexLineToClaudeShape,
  newCodexTranslateState,
} from "../src/lib/codex-session.js";
import { readSessionHistory } from "../src/lib/session-history.js";

const FIXTURE = join(import.meta.dir, "fixtures", "codex-rollout-tui.jsonl");
const LINES = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim());

function translateAll(stateful: boolean) {
  const st = stateful ? newCodexTranslateState() : undefined;
  return LINES.map((l) => codexLineToClaudeShape(l, st)).filter(Boolean) as Record<string, any>[];
}
const toolUses = (recs: Record<string, any>[]) =>
  recs.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []).filter((b: any) => b.type === "tool_use"));
const userTexts = (recs: Record<string, any>[]) =>
  recs.filter((r) => r.type === "user" && typeof r.message?.content === "string").map((r) => r.message.content as string);

for (const stateful of [true, false]) {
  describe(`真实 rollout（${stateful ? "带状态" : "无状态"}）`, () => {
    const recs = translateAll(stateful);

    test("McpToolCall → mcp__claudestra__reply，参数原样", () => {
      const replies = toolUses(recs).filter((t: any) => t.name === "mcp__claudestra__reply");
      expect(replies.map((t: any) => t.input.text)).toEqual(["PONG-1", "NUDGED", "SLEPT"]);
      expect(replies[0].input.chat_id).toBe("999000111");
    });

    test("CommandExecution → Bash{command}", () => {
      expect(toolUses(recs).filter((t: any) => t.name === "Bash").map((t: any) => t.input.command)).toEqual(["sleep 20"]);
    });

    test("code-mode 的 exec 包装与它的输出都不出现", () => {
      expect(toolUses(recs).some((t: any) => t.name === "exec")).toBe(false);
      const results = recs.flatMap((r) =>
        Array.isArray(r.message?.content) ? r.message.content.filter((b: any) => b.type === "tool_result") : [],
      );
      expect(results).toEqual([]);
    });

    test("AGENTS.md 注入块、引导消息不当用户发言；channel 包装标 isMeta", () => {
      const texts = userTexts(recs);
      expect(texts.some((t) => t.includes("AGENTS.md"))).toBe(false);
      expect(texts.some((t) => t.includes("[claudestra:bootstrap]"))).toBe(false);
      const chan = recs.find((r) => r.type === "user" && String(r.message?.content).startsWith("<channel"));
      expect(chan?.isMeta).toBe(true);
    });

    test("<hook_prompt> → system 提示，不是用户气泡", () => {
      const hook = recs.find((r) => r.type === "system" && r.subtype === "hook_prompt");
      expect(hook?.content).toContain("[D3-NUDGE]");
      expect(userTexts(recs).some((t) => t.includes("hook_prompt"))).toBe(false);
    });
  });
}

test("带状态时引导轮的 assistant「OK」一并丢掉（无状态做不到，只丢 user 那条）", () => {
  const ok = (recs: Record<string, any>[]) =>
    recs.filter((r) => r.type === "assistant" && r.message?.content?.[0]?.text === "OK").length;
  expect(ok(translateAll(true))).toBe(0);
  expect(ok(translateAll(false))).toBe(1);
});

test("本轮没有 item 事件（老格式）时 exec 保留、输出按 call_id 对上", () => {
  const st = newCodexTranslateState();
  const L = (o: unknown) => JSON.stringify(o);
  codexLineToClaudeShape(L({ type: "event_msg", payload: { type: "task_started" } }), st);
  const call = codexLineToClaudeShape(L({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: "x" } }), st);
  expect(call?.message.content[0].name).toBe("exec");
  const out = codexLineToClaudeShape(L({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c1", output: "Script completed\nWall time 0.1 seconds\n" } }), st);
  expect(out?.message.content[0].tool_use_id).toBe("c1");
});

test("codexCommandText：剥 shell -lc 包装", () => {
  expect(codexCommandText(["/bin/zsh", "-lc", "sleep 20"])).toBe("sleep 20");
  expect(codexCommandText(["bash", "-c", "ls"])).toBe("ls");
  expect(codexCommandText(["git", "status"])).toBe("git status");
  expect(codexCommandText("echo hi")).toBe("echo hi");
  expect(codexCommandText(undefined)).toBe("");
});

test("历史面板读得出 Codex 的 reply（经 session-source 首行嗅探认出 codex）", async () => {
  const page = await readSessionHistory(FIXTURE, { limit: 200 });
  const all = JSON.stringify(page.messages);
  for (const t of ["PONG-1", "NUDGED", "SLEPT"]) expect(all).toContain(t);
  expect(all).not.toContain("ALL_TOOLS");
  const users = page.messages.filter((m: any) => m.role === "user").map((m: any) => m.text);
  expect(users).toContain("hello from web");
  expect(users.some((t: string) => t.includes("AGENTS.md"))).toBe(false);
});
