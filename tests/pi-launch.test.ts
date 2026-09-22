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
import { buildPiCommand, PI_EXTENSION_PATH, isPiThinkingLevel } from "../src/lib/pi-launch.ts";
import { managedFor } from "../src/lib/runtimes/index.ts";
import type { LaunchSpec } from "../src/lib/runtimes/types.ts";
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

  test("能力档案：缺省不加任何开关，信任项目默认开启", () => {
    const cmd = buildPiCommand(base);
    expect(cmd).toContain("--approve");
    expect(cmd).not.toContain("--no-approve");
    expect(cmd).not.toContain("--no-extensions");
  });

  test("能力档案：minimal 关掉发现但仍加载 Claudestra 自己的扩展", () => {
    const cmd = buildPiCommand({ ...base, piEnv: { base: "minimal" } });
    expect(cmd).toContain("--no-extensions");
    expect(cmd).toContain("--no-skills");
    expect(cmd).toContain("--no-prompt-templates");
    // 显式 -e 在 --no-extensions 下仍然生效（实测），通道扩展必须还在
    expect(cmd).toContain(`--extension ${PI_EXTENSION_PATH}`);
    // 发现开关必须在第一个 -e 之前（顺序有语义，见 pi-env.ts 注释）
    expect(cmd.indexOf("--no-extensions")).toBeLessThan(cmd.indexOf("--extension"));
  });

  test("能力档案：包源扩展排在通道扩展（路径）之前 —— 反序会让包源被静默忽略", () => {
    const cmd = buildPiCommand({ ...base, piEnv: { base: "minimal", extensions: ["npm:@ff-labs/pi-fff"] } });
    const pkg = cmd.indexOf("--extension npm:@ff-labs/pi-fff");
    const chan = cmd.indexOf(`--extension ${PI_EXTENSION_PATH}`);
    expect(pkg).toBeGreaterThan(-1);
    expect(chan).toBeGreaterThan(-1);
    expect(pkg).toBeLessThan(chan);
  });

  test("能力档案：不信任项目资源 / 额外扩展 / 禁工具 / MCP 配置都能落到命令上", () => {
    const cmd = buildPiCommand({
      ...base,
      piEnv: {
        base: "minimal",
        trustProject: false,
        extensions: ["npm:pi-lens"],
        excludeTools: ["web_search"],
        mcpConfig: "/tmp/mcp.json",
      },
    });
    expect(cmd).toContain("--no-approve");
    expect(cmd).not.toContain(" --approve");
    expect(cmd).toContain("--extension npm:pi-lens");
    expect(cmd).toContain("--exclude-tools web_search");
    expect(cmd).toContain("--mcp-config /tmp/mcp.json");
  });

  test("能力档案：带空格的扩展路径被转义（不会断成两个参数）", () => {
    const cmd = buildPiCommand({ ...base, piEnv: { extensions: ["/Users/he/my ext/x.ts"] } });
    expect(cmd).toContain("--extension '/Users/he/my ext/x.ts'");
  });
});

describe("agentRuntime", () => {
  test("runtime=pi 认 pi；其余一律 claude-code", () => {
    expect(agentRuntime({ runtime: "pi" })).toBe("pi");
    expect(agentRuntime({ runtime: "claude-code" })).toBe("claude-code");
    expect(agentRuntime({})).toBe("claude-code");
    expect(agentRuntime(undefined)).toBe("claude-code");
    expect(agentRuntime({ runtime: "codex" })).toBe("codex");
    expect(agentRuntime({ runtime: "gpt-9" })).toBe("claude-code"); // 未知值走老路
  });
});

describe("按 runtime 分发启动器（managedFor）", () => {
  const spec = (over: Partial<LaunchSpec>): LaunchSpec => ({ mode: "new", sessionId: "", ...base, bridgeUrl: base.bridgeUrl, ...over });
  test("runtime=pi 出 pi 命令，且不含 claude 专属 flag", () => {
    const cmd = managedFor("pi")!.buildLaunchCommand(spec({ purpose: "测试" }));
    expect(cmd).toContain(" pi ");
    expect(cmd).toContain("--extension");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--dangerously-load-development-channels");
  });

  test("runtime 缺失 → Claude Code 命令（历史 agent 行为不变）", () => {
    for (const runtime of [undefined, "", "claude-code"]) {
      const cmd = managedFor(runtime)!.buildLaunchCommand(spec({ sessionId: "11111111-2222-3333-4444-555555555555" }));
      expect(cmd).toContain("claude --dangerously-load-development-channels");
      expect(cmd).not.toContain("--extension");
    }
  });

  test("认不出的 runtime 不回退成 Claude Code（拼错的 --runtime 不能被悄悄当 CC 起）", () => {
    expect(managedFor("something-else")).toBeNull();
    expect(managedFor("codex")?.id).toBe("codex");
  });
});

describe("PI_BIN / thinking 白名单（review #10 修复）", () => {
  const withEnv = (patch: Record<string, string | undefined>, fn: () => void) => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(patch)) { prev[k] = process.env[k]; if (patch[k] === undefined) delete process.env[k]; else process.env[k] = patch[k]; }
    try { fn(); } finally {
      for (const k of Object.keys(patch)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    }
  };

  test("PI_BIN 生效：命令用它，不再写死 pi（与 piAvailable() 同源）", () => {
    withEnv({ PI_BIN: "/opt/pi-dist/bin/pi", PI_CODING_AGENT_BIN: undefined }, () => {
      const cmd = buildPiCommand(base);
      expect(cmd).toContain("/opt/pi-dist/bin/pi");
      expect(cmd).not.toContain(" pi ");
    });
  });

  test("PI_CODING_AGENT_BIN 作为次选；都没设回落到 pi", () => {
    withEnv({ PI_BIN: undefined, PI_CODING_AGENT_BIN: "/usr/local/bin/pi-agent" }, () => {
      expect(buildPiCommand(base)).toContain("/usr/local/bin/pi-agent");
    });
    withEnv({ PI_BIN: undefined, PI_CODING_AGENT_BIN: undefined }, () => {
      expect(buildPiCommand(base)).toContain(" pi ");
    });
  });

  test("isPiThinkingLevel 只放行已知档位（换行注入串一律拒绝）", () => {
    expect(isPiThinkingLevel("high")).toBe(true);
    expect(isPiThinkingLevel("off")).toBe(true);
    expect(isPiThinkingLevel("high\n/quit")).toBe(false);
    expect(isPiThinkingLevel("")).toBe(false);
    expect(isPiThinkingLevel("ultra")).toBe(false);
  });
});
