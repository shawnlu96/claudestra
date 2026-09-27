/**
 * 设置页「记忆卫生」只在挂了 mem0 MCP 的机器上显示（lib/memory-hygiene.ts mem0McpConfigured）：
 * 卫生 prompt 用 mcp__mem0__* 工具、cron 在家目录起 agent，没挂就只会开出必然失败的任务。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mem0McpConfigured } from "../src/lib/memory-hygiene";

const dir = mkdtempSync(join(tmpdir(), "hyg-avail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const home = "/Users/someone";
const write = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
};

describe("mem0McpConfigured", () => {
  test("用户级挂了 mem0 → 可用", () => {
    expect(mem0McpConfigured(home, write("a.json", JSON.stringify({ mcpServers: { mem0: { command: "x" }, tavily: {} } })))).toBe(true);
  });

  test("只在家目录这个项目级挂了 → 可用（cron 在家目录起 agent）", () => {
    expect(mem0McpConfigured(home, write("b.json", JSON.stringify({ projects: { [home]: { mcpServers: { mem0: {} } } } })))).toBe(true);
  });

  test("只挂在别的项目里 / 完全没挂 → 不可用", () => {
    expect(mem0McpConfigured(home, write("c.json", JSON.stringify({ projects: { "/Users/someone/repo": { mcpServers: { mem0: {} } } } })))).toBe(false);
    expect(mem0McpConfigured(home, write("d.json", JSON.stringify({ mcpServers: { tavily: {} } })))).toBe(false);
  });

  test("文件不存在 / 写坏了 → 不可用，不抛", () => {
    expect(mem0McpConfigured(home, join(dir, "missing.json"))).toBe(false);
    expect(mem0McpConfigured(home, write("e.json", "{not json"))).toBe(false);
  });
});
