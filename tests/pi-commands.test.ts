import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCommandsFor, PI_BUILTIN_PASSTHROUGH } from "../src/lib/pi-env.js";

function fakeHome(agent: string, snapshot: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "pi-cmd-"));
  const dir = join(home, ".claude-orchestrator", "pi-env");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent}.json`), JSON.stringify(snapshot));
  return home;
}

const builtinNames = PI_BUILTIN_PASSTHROUGH.map((b) => b.name);

test("Pi 命令来自运行时快照，标记 scope=pi（CC 的 skills 扫描不适用）", () => {
  const home = fakeHome("agent-x", {
    at: new Date().toISOString(), agent: "agent-x", toolCount: 0, tools: [],
    commandCount: 3, commands: ["compact", "claudestra-model", "council"],
  });
  const cmds = piCommandsFor("agent-x", home);
  // 快照那三条在最前，且 scope=pi
  expect(cmds.slice(0, 3).map((c) => c.name)).toEqual(["compact", "claudestra-model", "council"]);
  expect(cmds.slice(0, 3).every((c) => c.scope === "pi" && c.invokeName === c.name)).toBe(true);
});

test("快照 commands 脏数据照样过滤（面板不显示幽灵命令）", () => {
  const home = fakeHome("agent-y", {
    at: new Date().toISOString(), agent: "agent-y", toolCount: 0, tools: [],
    commandCount: 2, commands: ["ok", "", "   ", 42 as unknown as string],
  });
  const names = piCommandsFor("agent-y", home).map((c) => c.name);
  expect(names.filter((n) => !builtinNames.includes(n))).toEqual(["ok"]);
});

// owner 2026-09-22 实报：网页对 Pi agent 打 `/reload` 毫无反应。
// 快照里 97 条命令没有 reload —— 扩展的 getCommands() 只报包与扩展提供的，
// Pi 自己的 BUILTIN_SLASH_COMMANDS 一条都不在里面 ⇒ 直通认不出来 ⇒ 当普通文本
// 投给 agent，agent 只能回「这是 TUI 命令，我只收到一行文本」。
test("Pi 内置命令补进来——/reload 这类必须能直通", () => {
  const home = fakeHome("agent-x", {
    at: new Date().toISOString(), agent: "agent-x", toolCount: 0, tools: [],
    commandCount: 1, commands: ["council"],
  });
  const cmds = piCommandsFor("agent-x", home);
  const reload = cmds.find((c) => c.name === "reload");
  expect(reload).toBeDefined();
  expect(reload!.invokeName).toBe("reload");
  expect(reload!.scope).toBe("pi-builtin"); // 面板里能看出它来自哪儿
  expect(reload!.description).not.toBe(""); // 内置的带说明，快照那批没有
});

test("快照缺失也要有内置那批（扩展没写快照 ≠ 一个命令都不能用）", () => {
  const cmds = piCommandsFor("agent-missing", fakeHome("other", {}));
  expect(cmds.map((c) => c.name)).toEqual(builtinNames);
});

test("同名以快照为准，不重复出现（它才是这个会话真加载到的那个）", () => {
  const home = fakeHome("agent-z", {
    at: new Date().toISOString(), agent: "agent-z", toolCount: 0, tools: [],
    commandCount: 1, commands: ["compact"],
  });
  const cmds = piCommandsFor("agent-z", home);
  expect(cmds.filter((c) => c.name === "compact")).toHaveLength(1);
  expect(cmds.find((c) => c.name === "compact")!.scope).toBe("pi");
});

test("白名单不收会断链路/需要人在 TUI 前的那些", () => {
  // 结束或轮转会话
  for (const n of ["quit", "new", "resume", "fork", "clone", "import"]) {
    expect(builtinNames).not.toContain(n);
  }
  // 打开交互选择器（模态挡住时 Pi 收不到消息，且没有自动 Esc 看门狗）
  for (const n of ["settings", "model", "tree", "thinking", "scoped-models", "login"]) {
    expect(builtinNames).not.toContain(n);
  }
  // 改持久凭据 / 信任决定
  for (const n of ["logout", "trust"]) {
    expect(builtinNames).not.toContain(n);
  }
});
