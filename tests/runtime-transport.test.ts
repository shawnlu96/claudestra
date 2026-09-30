import { describe, expect, test } from "bun:test";
import { normalizeRegistryAgents } from "../src/lib/registry.ts";
import { CODEX_ACP_CONTROL, CODEX_CONTROL } from "../src/lib/runtimes/codex.ts";
import { claudeCodeAdapter, controlFor, normalizeTransport, piAdapter, transportsOf } from "../src/lib/runtimes/index.ts";

// T60 transport 开关：缺省 tmux 时一切照旧，acp 只有声明了 ACP 段的运行时（目前只有 Codex）才生效

describe("controlFor(runtime, transport)", () => {
  test("不传 / tmux：与加开关之前逐字相同", () => {
    for (const rt of [undefined, null, "", "claude-code", "pi", "codex", "nope"]) {
      expect(controlFor(rt, "tmux")).toBe(controlFor(rt));
    }
    expect(controlFor("codex")).toBe(CODEX_CONTROL);
    expect(controlFor("pi")).toBe(piAdapter.control);
    expect(controlFor(undefined)).toBe(claudeCodeAdapter.control);
  });

  test("codex + acp → acp 的策略：不发键、宿主上报忙闲、会话内改模型、斜杠当 prompt", () => {
    const c = controlFor("codex", "acp");
    expect(c).toBe(CODEX_ACP_CONTROL);
    expect(c).toMatchObject({
      interruptKeys: [],
      preemptOnHumanMessage: false,
      idleSource: "acp",
      modelEnforcement: "config-option",
      paneHeuristics: false,
      abortVia: "extension",
      slashAsPrompt: true,
    });
  });

  test("没声明 ACP 的运行时要 acp → 退回它自己的 tmux 策略（manager 切 transport 前会先拒绝）", () => {
    expect(controlFor("claude-code", "acp")).toBe(claudeCodeAdapter.control);
    expect(controlFor("pi", "acp")).toBe(piAdapter.control);
    expect(controlFor(undefined, "acp")).toBe(claudeCodeAdapter.control);
  });
});

describe("transportsOf / normalizeTransport", () => {
  test("只有 Codex 能走 acp", () => {
    expect(transportsOf("codex")).toEqual(["tmux", "acp"]);
    expect(transportsOf("pi")).toEqual(["tmux"]);
    expect(transportsOf(undefined)).toEqual(["tmux"]);
    expect(transportsOf("nope")).toEqual(["tmux"]);
  });

  test("只认 acp，缺省与认不出的一律 tmux", () => {
    expect(normalizeTransport("acp")).toBe("acp");
    for (const v of [undefined, null, "", "tmux", "ACP", 1]) expect(normalizeTransport(v)).toBe("tmux");
  });
});

describe("registry 读 transport 字段", () => {
  test("acp 与显式 tmux 读出来；缺省 / 脏值读成 undefined", () => {
    const agents = normalizeRegistryAgents({
      agents: {
        "agent-a": { runtime: "codex", transport: "acp" },
        "agent-b": { runtime: "codex" },
        "agent-c": { runtime: "codex", transport: "tmux" },
        "agent-d": { transport: 42 },
      },
    });
    expect(agents.map((a) => a.transport)).toEqual(["acp", undefined, "tmux", undefined]);
    expect(normalizeTransport(agents[1].transport)).toBe("tmux");
  });
});
