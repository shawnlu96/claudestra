/**
 * v2.23+ Pi 启动器与运行时分发测试
 *
 * 重点锁住：
 *   - Pi 命令必须带 --approve + 指向仓库内扩展的 --extension（否则会话收不到消息）
 *   - env 前缀注入身份三件套（DISCORD_CHANNEL_ID / BRIDGE_URL / CLAUDESTRA_AGENT）
 *   - --session-id 是 open-or-create：create 与 restart 共用同一个字段
 *   - effort 只在对得上 Pi 的 --thinking 档位时才传（不认识的值不能瞎塞）
 *   - 分发：runtime=pi → pi 命令；缺失/未知 → Claude Code 命令（向后兼容）
 */

import { describe, test, expect } from "bun:test";
import { buildPiCommand, PI_EXTENSION_PATH } from "../src/lib/pi-launch.ts";
import { buildAgentCommand } from "../src/lib/launch-command.ts";
import { agentRuntime } from "../src/lib/registry.ts";

const base = { channelId: "chan-1", bridgeUrl: "ws://localhost:3847", agentName: "agent-pi" };

describe("buildPiCommand", () => {
  test("身份 env + 扩展路径 + approve 都在", () => {
    const cmd = buildPiCommand(base);
    expect(cmd).toContain("DISCORD_CHANNEL_ID=chan-1");
    expect(cmd).toContain("BRIDGE_URL=ws://localhost:3847");
    expect(cmd).toContain("CLAUDESTRA_AGENT=agent-pi");
    expect(cmd).toContain(" pi ");
    expect(cmd).toContain("--approve");
    expect(cmd).toContain(`--extension ${PI_EXTENSION_PATH}`);
  });

  test("扩展路径指向仓库内的 Pi 通道实现", () => {
    expect(PI_EXTENSION_PATH.endsWith("/src/pi/claudestra-extension.ts")).toBe(true);
  });

  test("sessionId / name / model 透传", () => {
    const cmd = buildPiCommand({
      ...base,
      sessionId: "6f1c2a10-0000-4000-8000-abcdefabcdef",
      model: "cc-switch-open-code-go/glm-5.3-flash",
    });
    expect(cmd).toContain("--session-id 6f1c2a10-0000-4000-8000-abcdefabcdef");
    expect(cmd).toContain("--name agent-pi");
    expect(cmd).toContain("--model cc-switch-open-code-go/glm-5.3-flash");
  });

  test("effort 只有落在 Pi 的 --thinking 档位里才传", () => {
    expect(buildPiCommand({ ...base, effort: "high" })).toContain("--thinking high");
    expect(buildPiCommand({ ...base, effort: "xhigh" })).toContain("--thinking xhigh");
    // Claude Code 侧的档位（如 ultracode）Pi 不认 —— 不能瞎塞给 --thinking
    expect(buildPiCommand({ ...base, effort: "ultracode" })).not.toContain("--thinking");
    expect(buildPiCommand({ ...base, effort: "" })).not.toContain("--thinking");
  });

  test("purpose 与 project 上下文合并成一条 --append-system-prompt", () => {
    const cmd = buildPiCommand({ ...base, purpose: "负责回归测试", projectContext: "你属于 project qingniao" });
    expect(cmd.match(/--append-system-prompt/g)?.length).toBe(1);
    expect(cmd).toContain("负责回归测试");
    expect(cmd).toContain("你属于 project qingniao");
  });

  test("带空格的值被正确转义（不出现裸空格断参）", () => {
    const cmd = buildPiCommand({ ...base, purpose: "a b'c" });
    // 前缀是注入的职责说明，这里只断言值本身的转义结果在串里
    expect(cmd).toContain("a b'\\''c'");
  });
});

describe("agentRuntime", () => {
  test("runtime=pi 认 pi；其余一律 claude-code", () => {
    expect(agentRuntime({ runtime: "pi" })).toBe("pi");
    expect(agentRuntime({ runtime: "claude-code" })).toBe("claude-code");
    expect(agentRuntime({})).toBe("claude-code");
    expect(agentRuntime(undefined)).toBe("claude-code");
    expect(agentRuntime({ runtime: "codex" })).toBe("claude-code"); // 未知值走老路
  });
});

describe("buildAgentCommand 分发", () => {
  test("runtime=pi 出 pi 命令，且不含 claude 专属 flag", () => {
    const cmd = buildAgentCommand({ ...base, runtime: "pi", purpose: "测试" });
    expect(cmd).toContain(" pi ");
    expect(cmd).toContain("--extension");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--dangerously-load-development-channels");
  });

  test("runtime 缺失/未知 → Claude Code 命令（历史 agent 行为不变）", () => {
    for (const runtime of [undefined, "claude-code", "something-else"]) {
      const cmd = buildAgentCommand({ ...base, runtime, sessionId: "11111111-2222-3333-4444-555555555555" });
      expect(cmd).toContain("claude --dangerously-load-development-channels");
      expect(cmd).not.toContain("--extension");
    }
  });
});
