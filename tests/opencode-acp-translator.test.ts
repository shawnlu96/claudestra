/** OpenCode 的三处翻译差异（lib/acp/updates.ts TranslatorOptions），用 OCR-1B 的真实夹具回放。docs/runtimes/opencode-acp.md */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acpRuntime } from "../src/lib/acp/host-runtime";
import { createAcpTranslator, type CompactSource } from "../src/lib/acp/updates";

const FIX = join(import.meta.dir, "fixtures/opencode-acp");

/** 夹具里发给宿主的 session/update（只取 prompt 之后的，load 回放的不算） */
function updates(file: string, afterPrompt = true): Record<string, any>[] {
  const frames = readFileSync(join(FIX, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const start = afterPrompt ? frames.findIndex((f) => f.msg?.method === "session/prompt") : 0;
  return frames.slice(Math.max(start, 0)).filter((f) => f.msg?.method === "session/update").map((f) => f.msg.params.update);
}

function replay(file: string, compact: CompactSource, mcp = "claudestra") {
  const tr = createAcpTranslator(() => "T", compact, acpRuntime("opencode").translator!(mcp));
  const out = updates(file).flatMap((u) => tr.push(u));
  return [...out, ...tr.flush()];
}

const toolUses = (entries: Record<string, any>[]) => entries.flatMap((e) => e.message?.content ?? []).filter((b: any) => b.type === "tool_use");
const toolResults = (entries: Record<string, any>[]) => entries.flatMap((e) => e.message?.content ?? []).filter((b: any) => b.type === "tool_result");
const auto: CompactSource = { from: "command-end", trigger: () => "auto" };

describe("OpenCode translator", () => {
  test("工具调用等 in_progress 再起头：命令是真命令，不出 Bash(command=\"bash\")", () => {
    const uses = toolUses(replay("prompt-tool-call.jsonl", auto));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ name: "Bash", input: { command: "ls -1" } });
    expect(JSON.stringify(uses)).not.toContain('"command":"bash"');
    expect(toolResults(replay("prompt-tool-call.jsonl", auto))[0].content).toContain("a.txt");
  });

  test("不开推迟时（Codex / Pi 的现行行为）pending 就起头——这正是要修的那一处", () => {
    const tr = createAcpTranslator(() => "T", auto);
    const uses = toolUses(updates("prompt-tool-call.jsonl").flatMap((u) => tr.push(u)));
    expect(uses[0].input.command).toBe("bash");
  });

  test("<mcp>_<tool> 改名成 mcp__<mcp>__<tool>，入参取 in_progress 的 rawInput", () => {
    const uses = toolUses(replay("mcp-stdio.jsonl", auto, "probe"));
    expect(uses).toEqual([expect.objectContaining({ name: "mcp__probe__ping", input: { text: "hello" } })]);
    // 不是宿主交下去的 server 名：不改（免得误伤 OpenCode 内置的带下划线工具）
    expect(toolUses(replay("mcp-stdio.jsonl", auto, "claudestra"))[0].name).toBe("probe_ping");
  });

  test("打断：被杀的命令以 completed 收尾，tool_result 带 aborted 说明、不标 is_error", () => {
    const r = toolResults(replay("cancel.jsonl", auto));
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].is_error).toBeUndefined();
    expect(toolUses(replay("cancel.jsonl", auto))[0].input.command).toContain("sleep 60");
  });

  test("/compact 那一轮：结束出 compact_boundary(manual)，摘要正文不当回复", () => {
    let manual = true;
    const tr = createAcpTranslator(() => "T", { from: "command-end", trigger: () => (manual ? "manual" : "auto") }, acpRuntime("opencode").translator!("claudestra"));
    const mid = updates("compact.jsonl").flatMap((u) => tr.push(u));
    manual = false; // 宿主在 prompt 返回时就复位了，flush 时 trigger 已是 auto
    const end = tr.flush();
    expect(mid.filter((e) => e.type === "assistant")).toEqual([]);
    expect(end).toEqual([{ type: "system", subtype: "compact_boundary", timestamp: "T", compactMetadata: { trigger: "manual" } }]);
    // 下一轮普通回合照常出正文
    expect(tr.push({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hi" } })).toEqual([]);
    expect(tr.flush()[0].message.content[0].text).toBe("hi");
  });

  test("普通回合不出压缩边界", () => {
    expect(replay("prompt-tool-call.jsonl", auto).some((e) => e.subtype === "compact_boundary")).toBe(false);
  });
});
