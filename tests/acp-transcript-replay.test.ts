import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineTranslator } from "../src/lib/session-source.ts";
import { REPLAY_ITEMS, replayFrame, replayOfLines, showReplay, tailLines, tuiHeader } from "../src/lib/acp/transcript-replay.ts";

// 重启 / 迁移后窗口回放最近一段历史：读会话文件尾巴，照常先打码再截断，只留最后 REPLAY_ITEMS 段

const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv";
const cc = createLineTranslator(undefined); // Claude Code 形状的行：宿主推给 bridge 的条目就是这个形状
const ts = "2026-10-15T11:00:00.000Z";
const assistant = (content: unknown[]) => JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content } });
const user = (content: unknown) => JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content } });

describe("replayOfLines", () => {
  test("正文 / 工具 / 结果 / 收到的消息按 transcript 的段显示，收到的消息不冒充助手正文", () => {
    const items = replayOfLines(cc, [
      user("审一下 LCK-1"),
      assistant([{ type: "text", text: "好的" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "a\nb" }]),
      "", "{半行",
    ]).map((r) => r.item);
    expect(items).toEqual(["> 消息：审一下 LCK-1", "● 好的", "● Bash(ls)", "  ⎿ a\n    b"]);
  });

  test("先打码再截断：历史里的密钥不出现，超长正文照 transcript 上限截", () => {
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行`).join("\n");
    const items = replayOfLines(cc, [assistant([{ type: "text", text: `key ${SECRET}` }]), user([{ type: "text", text: `token=${SECRET}` }]), assistant([{ type: "text", text: long }])]);
    expect(items.map((r) => r.item).join("\n")).not.toContain(SECRET);
    expect(items.at(-1)!.item).toContain("…（共 400 行）");
    expect(items[0]!.at?.toISOString()).toBe(ts);
  });

  test("思考按多行显示（不压成一行，不出「共 1 行」）", () => {
    const items = replayOfLines(cc, [assistant([{ type: "thinking", thinking: "先看 diff。\n再看测试。" }])]).map((r) => r.item);
    expect(items).toEqual(["✻ 先看 diff。\n  再看测试。"]);
  });

  test(`只留最后 ${REPLAY_ITEMS} 段`, () => {
    const lines = Array.from({ length: 50 }, (_, i) => assistant([{ type: "text", text: `第 ${i} 条` }]));
    const items = replayOfLines(cc, lines);
    expect(items).toHaveLength(REPLAY_ITEMS);
    expect(items.at(-1)!.item).toBe("● 第 49 条");
  });
});

describe("tailLines", () => {
  test("只读末尾：截在半行上的第一行整行不要", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-replay-"));
    try {
      const f = join(dir, "s.jsonl");
      writeFileSync(f, "aaaaaaaaaa\nbbb\nccc\n");
      expect(tailLines(f, 9)).toEqual(["bbb", "ccc", ""]);
      expect(tailLines(f)).toEqual(["aaaaaaaaaa", "bbb", "ccc", ""]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("showReplay", () => {
  const sink = () => {
    const shown: string[] = [];
    return { shown, screen: { show: (i: string) => void shown.push(i) } };
  };

  test("有历史：前面一行说明已接续、后面一道分隔，中间是段", () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-replay-"));
    try {
      const f = join(dir, "s.jsonl");
      writeFileSync(f, `${assistant([{ type: "text", text: "上次说到这" }])}\n`);
      const { shown, screen } = sink();
      showReplay(screen, () => f, cc, () => {});
      const { head, foot } = replayFrame(1);
      expect(shown).toEqual([head, "● 上次说到这", foot]);
      expect(head).toContain("已接续会话");
      expect(head).toContain("网页");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("新会话（没文件）不画；读不了只记日志、不抛", () => {
    const { shown, screen } = sink();
    const logs: string[] = [];
    showReplay(screen, () => null, cc, (m) => void logs.push(m));
    showReplay(screen, () => "/nonexistent/acp-replay.jsonl", cc, (m) => void logs.push(m));
    expect(shown).toEqual([]);
    expect(logs).toHaveLength(1);
  });
});

test("顶部提示：一行（80 列放得下），不含本机路径", () => {
  const h = tuiHeader("agent-dn-review-pi", "01a138d1-91d8-72db-b1a0-ee2807fe5971", true);
  expect(h).toBe("ACP 会话 agent-dn-review-pi · 线程 01a138d1 · /help 看命令");
  expect(Bun.stringWidth(h)).toBeLessThan(80);
  expect(tuiHeader("a", "b", false)).toEndWith("只看");
});
