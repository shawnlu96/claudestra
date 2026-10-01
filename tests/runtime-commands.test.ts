/** lib/runtime-commands.ts：Codex agent 的命令面板 / slash 直通白名单是 Codex 自己的内置命令，不是 Claude Code 的技能 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { piEnvSnapshotPath } from "../src/lib/pi-env.js";
import { CODEX_BUILTIN_PASSTHROUGH, runtimeCommandsFor } from "../src/lib/runtime-commands.js";

describe("runtimeCommandsFor", () => {
  test("Claude Code（或没写 runtime）→ null，走 CC 注册表", () => {
    expect(runtimeCommandsFor(undefined, "x")).toBeNull();
    expect(runtimeCommandsFor("claude-code", "x")).toBeNull();
  });
  test("Codex → 内置命令；会换会话 / 退出的不在表里；只有会跑一轮的不标 builtin", () => {
    const cmds = runtimeCommandsFor("codex", "agent-codex")!;
    const names = cmds.map((c) => c.name);
    expect(names).toContain("model");
    expect(names).toContain("review");
    for (const bad of ["new", "resume", "fork", "quit", "exit", "logout", "save-compact", "clear"]) expect(names).not.toContain(bad);
    expect(cmds.find((c) => c.name === "status")!.scope).toBe("builtin");
    expect(cmds.find((c) => c.name === "review")!.scope).toBe("codex-turn");
    expect(cmds).toHaveLength(CODEX_BUILTIN_PASSTHROUGH.length);
  });
  test("ACP 版 Pi：tmux 扩展留下的 claudestra-* 和 TUI 内置命令都不列，扩展 / 包的命令照列，内置只剩适配器能跑的 /compact", () => {
    const p = piEnvSnapshotPath("agent-pi-acp");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: new Date().toISOString(), commands: ["claudestra-model", "claudestra-thinking", "council"] }));
    const tmux = runtimeCommandsFor("pi", "agent-pi-acp")!.map((c) => c.name);
    expect(tmux).toContain("claudestra-model");
    expect(tmux).toContain("reload");
    expect(runtimeCommandsFor("pi", "agent-pi-acp", true)!.map((c) => c.name)).toEqual(["council", "compact"]);
    expect(runtimeCommandsFor("pi", "agent-no-snapshot", true)!.map((c) => c.name)).toEqual(["compact"]);
  });
});
