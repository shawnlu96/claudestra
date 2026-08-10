/**
 * v2.18.1+ 会话尾部扫描单测。
 *
 * 核心不变量：**「最近活动时间」只能来自真实对话记录，绝不能退回文件 mtime。**
 * 2026-08-10 owner 报「qingniao-miniapp 我明明啥也没干却一直排最前」——尾部
 * 256KB 全是重启残渣 → 旧实现退 mtime → CC 的 housekeeping 一 touch 文件，
 * 这个 agent 就顶到列表第一。这里锁住「找不到就是 null」。
 */

import { describe, test, expect } from "bun:test";
import { scanSessionTail, TAIL_WINDOWS } from "../src/lib/session-tail.js";

const jsonl = (recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** 重启残渣：CC 回放排队命令时产出的礼节性回复 + /model 命令记录 + 元数据条目 */
const RESTART_RESIDUE = [
  { type: "file-history-snapshot", messageId: "x" },
  { type: "permission-mode", mode: "bypassPermissions" },
  {
    type: "assistant",
    timestamp: "2026-08-08T18:03:57.189Z",
    message: { model: "claude-opus-5", content: [{ type: "text", text: "No response requested." }] },
  },
  {
    type: "user",
    timestamp: "2026-08-08T18:03:59.767Z",
    message: { content: "<command-name>/model</command-name>\n<command-args>claude-opus-5</command-args>" },
  },
  {
    type: "user",
    timestamp: "2026-08-08T18:03:59.768Z",
    message: { content: "<local-command-stdout>Set model to Opus 5</local-command-stdout>" },
  },
];

describe("scanSessionTail — convTs", () => {
  test("窗内只有重启残渣 → convTs 为 null（不许退 mtime）", () => {
    const info = scanSessionTail(jsonl(RESTART_RESIDUE));
    expect(info.convTs).toBeNull();
  });

  test("取最后一条真实对话，跳过其后的全部残渣", () => {
    const real = {
      type: "assistant",
      timestamp: "2026-07-08T15:09:02.879Z",
      message: { model: "claude-opus-5", content: [{ type: "text", text: "做完了" }] },
    };
    const info = scanSessionTail(jsonl([real, ...RESTART_RESIDUE]));
    expect(info.convTs).toBe(Date.parse("2026-07-08T15:09:02.879Z"));
  });

  test("用户真实提问算对话（内容不是 <command-*> 包裹）", () => {
    const info = scanSessionTail(
      jsonl([{ type: "user", timestamp: "2026-08-01T00:00:00.000Z", message: { content: "帮我看下这个 bug" } }]),
    );
    expect(info.convTs).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  test("空文本 / 半行截断不抛错", () => {
    expect(scanSessionTail("").convTs).toBeNull();
    expect(scanSessionTail('{"type":"assis').convTs).toBeNull();
  });
});

describe("scanSessionTail — 上下文 / 模型 / effort", () => {
  test("usage 合计取 input + cache 读写；全 0 的合成记录跳过", () => {
    const info = scanSessionTail(
      jsonl([
        {
          type: "assistant",
          timestamp: "2026-08-01T00:00:00Z",
          message: { model: "claude-opus-5", usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
        },
        {
          type: "assistant",
          timestamp: "2026-08-01T00:01:00Z",
          message: { model: "claude-opus-5", usage: { input_tokens: 0, cache_read_input_tokens: 0 } },
        },
      ]),
    );
    expect(info.ctxTokens).toBe(1000);
  });

  test("compact 边界比 assistant 新时以 postTokens 为准", () => {
    const info = scanSessionTail(
      jsonl([
        { type: "assistant", timestamp: "2026-08-01T00:00:00Z", message: { model: "m", usage: { input_tokens: 500_000 } } },
        { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 42_000 } },
      ]),
    );
    expect(info.ctxTokens).toBe(42_000);
  });

  test("model 取最近一条 assistant，<synthetic> 占位跳过", () => {
    const info = scanSessionTail(
      jsonl([
        { type: "assistant", timestamp: "2026-08-01T00:00:00Z", message: { model: "claude-opus-5" } },
        { type: "assistant", timestamp: "2026-08-01T00:01:00Z", message: { model: "<synthetic>" } },
      ]),
    );
    expect(info.model).toBe("claude-opus-5");
    expect(info.modelTs).toBe(Date.parse("2026-08-01T00:00:00Z"));
  });

  test("effort 读会话内 /effort 的 stdout 自述", () => {
    const info = scanSessionTail(
      jsonl([
        {
          type: "user",
          timestamp: "2026-08-01T00:00:00Z",
          message: { content: "<local-command-stdout>Set effort level to xhigh</local-command-stdout>" },
        },
      ]),
    );
    expect(info.effort).toBe("xhigh");
    // 命令记录不算对话——effort 读到了也不能顺手把它当活动时间
    expect(info.convTs).toBeNull();
  });
});

describe("TAIL_WINDOWS", () => {
  test("逐级放宽且单调递增（命中即停，最坏读 8MB）", () => {
    expect(TAIL_WINDOWS.length).toBeGreaterThan(1);
    for (let i = 1; i < TAIL_WINDOWS.length; i++) {
      expect(TAIL_WINDOWS[i]).toBeGreaterThan(TAIL_WINDOWS[i - 1]);
    }
    expect(TAIL_WINDOWS[0]).toBe(256 * 1024);
  });
});
