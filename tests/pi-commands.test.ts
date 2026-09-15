import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCommandsFor } from "../src/lib/pi-env.js";

function fakeHome(agent: string, snapshot: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "pi-cmd-"));
  const dir = join(home, ".claude-orchestrator", "pi-env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent}.json`), JSON.stringify(snapshot));
  return home;
}

test("Pi 命令来自运行时快照，标记 scope=pi（CC 的 skills 扫描不适用）", () => {
  const home = fakeHome("agent-x", {
    at: new Date().toISOString(), agent: "agent-x", toolCount: 0, tools: [],
    commandCount: 3, commands: ["compact", "claudestra-model", "council"],
  });
  const cmds = piCommandsFor("agent-x", home);
  expect(cmds.map((c) => c.name)).toEqual(["compact", "claudestra-model", "council"]);
  expect(cmds.every((c) => c.scope === "pi" && c.invokeName === c.name)).toBe(true);
});

test("快照缺失或 commands 脏数据 → 空列表 / 过滤（面板不显示幽灵命令）", () => {
  expect(piCommandsFor("agent-missing", fakeHome("other", {}))).toEqual([]);
  const home = fakeHome("agent-y", {
    at: new Date().toISOString(), agent: "agent-y", toolCount: 0, tools: [],
    commandCount: 2, commands: ["ok", "", "   ", 42 as unknown as string],
  });
  expect(piCommandsFor("agent-y", home).map((c) => c.name)).toEqual(["ok"]);
});
