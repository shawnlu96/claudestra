/**
 * v2.23+ Pi 会话文件：路径定位 + 格式翻译
 *
 * 重点锁住：
 *   - 目录编码规则（含软链解析：/tmp 在 macOS 上落在 --private-tmp-…--）
 *   - 文件名匹配（<ts>_<sessionId>.jsonl）与跨项目兜底查找
 *   - Pi 行 → Claude Code 形状的翻译（下游五个消费者照后者写的）
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  encodePiSessionDir,
  findPiSessionBySessionId,
  listPiSessionJsonls,
  piLineToClaudeShape,
  mapPiToolCall,
  piSessionIdFromFilename,
  piSessionPath,
  piUsageToClaude,
  readPiSessionAsClaudeShape,
  resolveCwd,
} from "../src/lib/pi-session.ts";

describe("encodePiSessionDir", () => {
  test("绝对路径去头斜杠、分隔符换 -、两端包 --", () => {
    expect(encodePiSessionDir("/Users/he/repos/piagent")).toBe("--Users-he-repos-piagent--");
  });

  test("下划线保留、冒号也换掉", () => {
    expect(encodePiSessionDir("/Users/he/projects/bn_market_maker")).toBe("--Users-he-projects-bn_market_maker--");
    expect(encodePiSessionDir("/a:b/c")).toBe("--a-b-c--");
  });

  test("软链被解析（/tmp → /private/tmp on macOS；其它平台按 realpath 自身比）", () => {
    // 不写死 /private/tmp：拿系统自己的 realpath 做期望值，跨平台都成立
    const resolved = realpathSync(tmpdir());
    expect(encodePiSessionDir(tmpdir())).toBe(`--${resolved.replace(/^\//, "").replace(/[/:]/g, "-")}--`);
  });

  test("resolveCwd 对不存在的路径原样返回（不抛）", () => {
    expect(resolveCwd("/no/such/dir/at/all")).toBe("/no/such/dir/at/all");
  });
});

describe("会话文件定位", () => {
  function fixture() {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-cwd-"));
    const dir = join(agentDir, "sessions", encodePiSessionDir(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-14T07-14-15-025Z_aaaa-1111.jsonl"), "{}\n");
    writeFileSync(join(dir, "2026-09-14T08-00-00-000Z_bbbb-2222.jsonl"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "x");
    return { agentDir, cwd };
  }

  test("按 sessionId 找到对应文件（不是别的会话）", () => {
    const { agentDir, cwd } = fixture();
    const hit = piSessionPath(cwd, "bbbb-2222", agentDir);
    expect(hit?.endsWith("2026-09-14T08-00-00-000Z_bbbb-2222.jsonl")).toBe(true);
    expect(piSessionPath(cwd, "nope", agentDir)).toBeNull();
    expect(piSessionPath(cwd, "", agentDir)).toBeNull();
  });

  test("列出目录下全部 jsonl（忽略非 jsonl）", () => {
    const { agentDir, cwd } = fixture();
    const files = listPiSessionJsonls(cwd, agentDir);
    expect(files.length).toBe(2);
    expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
  });

  test("跨项目兜底查找", () => {
    const { agentDir } = fixture();
    expect(findPiSessionBySessionId("aaaa-1111", agentDir)?.includes("_aaaa-1111.jsonl")).toBe(true);
    expect(findPiSessionBySessionId("missing", agentDir)).toBeNull();
  });

  test("目录不存在时返回空/null，不抛", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pi-agent-empty-"));
    expect(listPiSessionJsonls("/no/such/cwd", agentDir)).toEqual([]);
    expect(piSessionPath("/no/such/cwd", "x", agentDir)).toBeNull();
    expect(findPiSessionBySessionId("x", agentDir)).toBeNull();
  });
});

describe("piUsageToClaude", () => {
  test("字段名映射（Pi 的 input/output/cacheRead/cacheWrite）", () => {
    expect(piUsageToClaude({ input: 12, output: 34, cacheRead: 5, cacheWrite: 6, totalTokens: 57 })).toEqual({
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 6,
    });
  });

  test("缺字段补 0；非对象返回 undefined", () => {
    expect(piUsageToClaude({ input: 1 })).toEqual({
      input_tokens: 1,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(piUsageToClaude(undefined)).toBeUndefined();
  });
});

describe("piLineToClaudeShape", () => {
  test("assistant：toolCall → tool_use，thinking 保留，usage 改名", () => {
    const line = JSON.stringify({
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "2026-09-14T07:00:00.000Z",
      message: {
        role: "assistant",
        model: "glm-5.3-flash",
        usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 },
        content: [
          { type: "thinking", thinking: "想一下" },
          { type: "text", text: "好" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    });
    const out = piLineToClaudeShape(line)!;
    expect(out.type).toBe("assistant");
    expect(out.message.model).toBe("glm-5.3-flash");
    expect(out.message.usage.input_tokens).toBe(10);
    expect(out.message.content).toEqual([
      { type: "thinking", thinking: "想一下" },
      { type: "text", text: "好" },
      // Pi 的 bash → CC 的 Bash（名字映射，下游摘要渲染认后者）
      { type: "tool_use", id: "tc1", name: "Bash", input: { command: "ls" } },
    ]);
  });

  test("toolResult → user 里的 tool_result 块（Pi 是独立一行）", () => {
    const line = JSON.stringify({
      type: "message",
      timestamp: "2026-09-14T07:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "boom" }],
      },
    });
    const out = piLineToClaudeShape(line)!;
    expect(out.type).toBe("user");
    expect(out.message.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tc1",
      content: [{ type: "text", text: "boom" }],
      is_error: true,
    });
  });

  test("user 文本消息", () => {
    const out = piLineToClaudeShape(
      JSON.stringify({ type: "message", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    )!;
    expect(out.type).toBe("user");
    expect(out.message.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("压缩检查点 → compact_boundary（历史面板认这个）", () => {
    const out = piLineToClaudeShape(JSON.stringify({ type: "compaction", summary: "摘要" }))!;
    expect(out.type).toBe("system");
    expect(out.subtype).toBe("compact_boundary");
    expect(out.compactSummary).toBe("摘要");
  });

  test("非对话行（model_change / custom / 坏 JSON）一律返回 null", () => {
    expect(piLineToClaudeShape(JSON.stringify({ type: "model_change", modelId: "x" }))).toBeNull();
    expect(piLineToClaudeShape(JSON.stringify({ type: "custom", customType: "x" }))).toBeNull();
    expect(piLineToClaudeShape(JSON.stringify({ type: "message", message: { role: "custom" } }))).toBeNull();
    expect(piLineToClaudeShape("{ 坏 json")).toBeNull();
    expect(piLineToClaudeShape("")).toBeNull();
  });

  test("header 行给出会话身份", () => {
    const out = piLineToClaudeShape(JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/x" }))!;
    expect(out.subtype).toBe("pi_session_start");
    expect(out.sessionId).toBe("s1");
  });
});

describe("readPiSessionAsClaudeShape", () => {
  test("整文件翻译：跳过非对话行，保留顺序", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-file-"));
    const p = join(dir, "s.jsonl");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/x" }),
      JSON.stringify({ type: "model_change", modelId: "m" }),
      JSON.stringify({ type: "message", timestamp: "t1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      "",
      JSON.stringify({ type: "message", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    ];
    writeFileSync(p, lines.join("\n") + "\n");
    const out = readPiSessionAsClaudeShape(p);
    expect(out.map((e) => e.type)).toEqual(["system", "user", "assistant"]);
    expect(out[2].message.content[0].text).toBe("yo");
  });

  test("文件不存在返回空数组", () => {
    expect(readPiSessionAsClaudeShape("/no/such/file.jsonl")).toEqual([]);
  });
});

describe("mapPiToolCall（Pi 工具名/参数 → Claude Code 形状）", () => {
  test("内置工具映射：read/write/edit/find/grep/ls/bash", () => {
    expect(mapPiToolCall("read", { path: "/a/b.ts", offset: 3 })).toEqual({
      name: "Read",
      input: { file_path: "/a/b.ts", offset: 3 },
    });
    expect(mapPiToolCall("write", { path: "/a/b.ts", content: "x" })).toEqual({
      name: "Write",
      input: { file_path: "/a/b.ts", content: "x" },
    });
    // Pi 的 edits 数组 → CC 的单次 old/new（摘要渲染只需要这个）
    expect(mapPiToolCall("edit", { path: "/a/b.ts", edits: [{ oldText: "a", newText: "b" }] })).toEqual({
      name: "Edit",
      input: { file_path: "/a/b.ts", old_string: "a", new_string: "b" },
    });
    expect(mapPiToolCall("find", { pattern: "**/*.ts" })).toEqual({ name: "Glob", input: { pattern: "**/*.ts" } });
    expect(mapPiToolCall("grep", { pattern: "foo", path: "/a" })).toEqual({
      name: "Grep",
      input: { pattern: "foo", path: "/a" },
    });
    expect(mapPiToolCall("bash", { command: "ls -la" })).toEqual({ name: "Bash", input: { command: "ls -la" } });
  });

  test("Claudestra 自有工具与未知工具原样透传（不猜）", () => {
    expect(mapPiToolCall("reply", { text: "hi" })).toEqual({ name: "reply", input: { text: "hi" } });
    expect(mapPiToolCall("mcp__mem0__search", { q: "x" })).toEqual({ name: "mcp__mem0__search", input: { q: "x" } });
    expect(mapPiToolCall("weird", undefined)).toEqual({ name: "weird", input: {} });
  });

  test("翻译后的 toolCall 直接带 CC 名字（下游摘要渲染不用改）", () => {
    const out = piLineToClaudeShape(
      JSON.stringify({
        type: "message",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x/y.ts" } }],
        },
      }),
    )!;
    expect(out.message.content[0]).toEqual({ type: "tool_use", id: "c1", name: "Read", input: { file_path: "/x/y.ts" } });
  });
});

describe("piSessionIdFromFilename（会话文件名 → sessionId）", () => {
  test("按第一个下划线切，时间戳前缀丢掉", () => {
    expect(piSessionIdFromFilename("2026-09-14T10-41-50-730Z_04b31677-8fef-4128.jsonl")).toBe("04b31677-8fef-4128");
  });

  test("自造 id 里带下划线也取全（这正是不能按最后一个下划线切的原因）", () => {
    expect(piSessionIdFromFilename("2026-09-14T10-41-50-730Z_pi_my_agent.jsonl")).toBe("pi_my_agent");
  });

  test("不是会话文件返回 null", () => {
    expect(piSessionIdFromFilename("notes.txt")).toBeNull();
    expect(piSessionIdFromFilename("nounderscore.jsonl")).toBeNull();
  });
});
