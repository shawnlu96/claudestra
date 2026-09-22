/**
 * 运行时生命周期层的契约。
 *
 * 1. 适配器产出的启动命令与改造前 manager 的调用**逐字一致**：下面的 legacy* 是
 *    manager.ts 改造前在 create / resume / restart / restart-fork 四处传给
 *    buildClaudeCommand / buildPiCommand 的原样参数，spec* 是改造后 manager 构造的
 *    LaunchSpec。两边必须产出同一个字符串——老 agent 重启后的命令一个字节都不能变。
 * 2. 每个 manageable 适配器都有完整的生命周期面（exitCommand / control / waitReady …）。
 * 3. 就绪 / 退出判据用假窗口跑一遍，钉住 CC 与 Pi 各自的判据。
 */
import { describe, expect, test } from "bun:test";
import { buildClaudeCommand } from "../src/lib/claude-launch.ts";
import { buildPiCommand } from "../src/lib/pi-launch.ts";
import { normalizePiEnvProfile, type PiEnvProfile } from "../src/lib/pi-env.ts";
import {
  allSources,
  claudeCodeAdapter,
  codexAdapter,
  controlFor,
  isManaged,
  managedFor,
  manageableRuntimeIds,
  piAdapter,
  requireManaged,
} from "../src/lib/runtimes/index.ts";
import type { LaunchSpec, WindowOps } from "../src/lib/runtimes/types.ts";
import { describeKeys } from "../src/lib/runtimes/window-ops.ts";

// ── 1. 启动命令逐字一致 ─────────────────────────────────────────────

interface Ctx {
  channelId: string;
  bridgeUrl: string;
  sessionId: string;
  tmuxName: string;
  displayName?: string;
  preset?: string;
  raw?: string;
  effort?: string;
  mode?: string;
  model?: string;
  purpose?: string;
  projectContext?: string;
  piEnv?: PiEnvProfile;
  forkSession?: boolean;
}

// 改造前 cmdCreate 传给 buildAgentCommand 的参数（去掉 runtime 键）
const legacyCreate = (c: Ctx) => ({
  piEnv: c.piEnv,
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  sessionId: c.sessionId,
  disallowedPreset: c.preset,
  disallowedRaw: c.raw,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
  purpose: c.purpose,
  agentName: c.tmuxName,
  projectContext: c.projectContext,
});
// 改造前 cmdResume
const legacyResume = (c: Ctx) => ({
  piEnv: normalizePiEnvProfile(c.piEnv),
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  sessionId: c.sessionId,
  resumeId: c.sessionId,
  forkSession: !!c.forkSession,
  displayName: c.displayName,
  disallowedPreset: c.preset,
  disallowedRaw: c.raw,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
});
// 改造前 cmdRestart
const legacyRestart = (c: Ctx) => ({
  piEnv: normalizePiEnvProfile(c.piEnv),
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  resumeId: c.sessionId,
  sessionId: c.sessionId,
  displayName: c.displayName,
  disallowedPreset: c.preset,
  disallowedRaw: c.raw,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
  purpose: c.purpose,
  agentName: c.tmuxName,
});
// 改造前 cmdRestart 的 bg 占用自愈分支（只对 Claude Code）
const legacyRestartFork = (c: Ctx) =>
  buildClaudeCommand({
    channelId: c.channelId,
    bridgeUrl: c.bridgeUrl,
    resumeId: c.sessionId,
    forkSession: true,
    displayName: c.displayName,
    disallowedPreset: c.preset,
    disallowedRaw: c.raw,
    effort: c.effort,
    permissionMode: c.mode,
    model: c.model,
    purpose: c.purpose,
    agentName: c.tmuxName,
  });

// 改造后 manager 构造的 LaunchSpec（与 manager.ts 里三处一一对应）
const specCreate = (c: Ctx): LaunchSpec => ({
  mode: "new",
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  sessionId: c.sessionId,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
  purpose: c.purpose,
  agentName: c.tmuxName,
  projectContext: c.projectContext,
  extras: { disallowedPreset: c.preset, disallowedRaw: c.raw, piEnv: c.piEnv },
});
const specResume = (c: Ctx): LaunchSpec => ({
  mode: c.forkSession ? "fork" : "resume",
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  sessionId: c.sessionId,
  displayName: c.displayName,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
  extras: { disallowedPreset: c.preset, disallowedRaw: c.raw, piEnv: normalizePiEnvProfile(c.piEnv) },
});
const specRestart = (c: Ctx): LaunchSpec => ({
  mode: "resume",
  channelId: c.channelId,
  bridgeUrl: c.bridgeUrl,
  sessionId: c.sessionId,
  displayName: c.displayName,
  effort: c.effort,
  permissionMode: c.mode,
  model: c.model,
  purpose: c.purpose,
  agentName: c.tmuxName,
  extras: { disallowedPreset: c.preset, disallowedRaw: c.raw, piEnv: normalizePiEnvProfile(c.piEnv) },
});

const SID = "11111111-2222-3333-4444-555555555555";
const base: Ctx = { channelId: "1234567890", bridgeUrl: "ws://localhost:3847", sessionId: SID, tmuxName: "agent-foo" };

const CASES: Array<[string, Ctx]> = [
  ["最简", base],
  ["显示名带空格与中文", { ...base, displayName: "我的 agent's box" }],
  ["model 别名 + effort", { ...base, model: "opus", effort: "high" }],
  ["model id + effort=default（不传 flag）", { ...base, model: "claude-fable-5-1", effort: "default" }],
  ["effort=ultracode（启动 flag 降到 xhigh）", { ...base, effort: "ultracode" }],
  ["Pi 的 provider/model + thinking 档", { ...base, model: "cc-switch/glm-5.3-flash", effort: "max" }],
  ["非 bypass 权限模式", { ...base, mode: "plan" }],
  ["auto 归一到 bypass", { ...base, mode: "auto" }],
  ["权限预设", { ...base, preset: "strict" }],
  ["原始黑名单覆盖", { ...base, raw: "Bash(rm -rf:*) Bash(curl:*)" }],
  ["purpose 带引号换行", { ...base, purpose: "审 PR，别碰 'main'\n第二行" }],
  ["project 上下文", { ...base, purpose: "测试", projectContext: "你属于 project X：目录 /a /b；同伴 agent-y" }],
  ["全家桶", {
    ...base,
    displayName: "foo",
    preset: "readonly",
    effort: "low",
    mode: "acceptEdits",
    model: "sonnet",
    purpose: "p",
    projectContext: "ctx",
  }],
  ["Pi 能力档案 minimal", { ...base, piEnv: { base: "minimal" } }],
  ["Pi 能力档案 + 额外扩展 + 不信任项目", {
    ...base,
    piEnv: { base: "minimal", extensions: ["npm:pkg-a", "/abs/ext.ts"], excludeTools: ["bash"], trustProject: false } as PiEnvProfile,
  }],
];

describe("Claude Code：启动命令与改造前逐字一致", () => {
  for (const [name, c] of CASES) {
    test(`create · ${name}`, () => {
      expect(claudeCodeAdapter.buildLaunchCommand(specCreate(c))).toBe(buildClaudeCommand(legacyCreate(c)));
    });
    test(`resume · ${name}`, () => {
      expect(claudeCodeAdapter.buildLaunchCommand(specResume(c))).toBe(buildClaudeCommand(legacyResume(c)));
    });
    test(`resume --fork · ${name}`, () => {
      const f = { ...c, forkSession: true };
      expect(claudeCodeAdapter.buildLaunchCommand(specResume(f))).toBe(buildClaudeCommand(legacyResume(f)));
    });
    test(`restart · ${name}`, () => {
      expect(claudeCodeAdapter.buildLaunchCommand(specRestart(c))).toBe(buildClaudeCommand(legacyRestart(c)));
    });
    test(`restart 占用自愈 fork · ${name}`, () => {
      expect(claudeCodeAdapter.buildLaunchCommand({ ...specRestart(c), mode: "fork" })).toBe(legacyRestartFork(c));
    });
  }

  test("mode 真的决定了 flag（防止上面的等式两边一起退化）", () => {
    expect(claudeCodeAdapter.buildLaunchCommand(specCreate(base))).toContain(`--session-id ${SID}`);
    expect(claudeCodeAdapter.buildLaunchCommand(specResume(base))).toContain(`--resume ${SID}`);
    expect(claudeCodeAdapter.buildLaunchCommand(specResume(base))).not.toContain("--fork-session");
    expect(claudeCodeAdapter.buildLaunchCommand(specResume({ ...base, forkSession: true }))).toContain("--fork-session");
  });
});

describe("Pi：启动命令与改造前逐字一致", () => {
  for (const [name, c] of CASES) {
    test(`create · ${name}`, () => {
      expect(piAdapter.buildLaunchCommand(specCreate(c))).toBe(buildPiCommand(legacyCreate(c)));
    });
    test(`resume · ${name}`, () => {
      expect(piAdapter.buildLaunchCommand(specResume(c))).toBe(buildPiCommand(legacyResume(c)));
    });
    test(`resume --fork（Pi 的 --session-id 是 open-or-create，没有 fork 语义）· ${name}`, () => {
      const f = { ...c, forkSession: true };
      expect(piAdapter.buildLaunchCommand(specResume(f))).toBe(buildPiCommand(legacyResume(f)));
    });
    test(`restart · ${name}`, () => {
      expect(piAdapter.buildLaunchCommand(specRestart(c))).toBe(buildPiCommand(legacyRestart(c)));
    });
  }
});

// ── 2. 适配器契约 ───────────────────────────────────────────────────

describe("manageable 适配器契约", () => {
  const managed = allSources().filter(isManaged);

  test("manageable=true 的适配器都实现了生命周期（不能只挂个名）", () => {
    for (const s of allSources()) expect(isManaged(s)).toBe(s.manageable);
    expect(managed.map((m) => m.id).sort()).toEqual(["claude-code", "pi"]);
  });

  test("每个 manageable 适配器都有退出指令、control、就绪判据、registry 字段", () => {
    for (const m of managed) {
      expect(m.exitCommand).toMatch(/^\/\S+$/);
      expect(m.noteTag.length).toBeGreaterThan(0);
      expect(m.inbound.length).toBeGreaterThan(0);
      expect(m.turnEnd.length).toBeGreaterThan(0);
      expect(m.control.interruptKeys.length).toBeGreaterThan(0);
      for (const fn of ["waitReady", "buildLaunchCommand", "isValidSessionId", "available", "registryFields"]) {
        expect(typeof (m as never as Record<string, unknown>)[fn]).toBe("function");
      }
    }
  });

  test("退出指令与 registry notes 前缀沿用历史值", () => {
    expect(claudeCodeAdapter.exitCommand).toBe("/exit");
    expect(piAdapter.exitCommand).toBe("/quit");
    expect(claudeCodeAdapter.noteTag).toBe("claude");
    expect(piAdapter.noteTag).toBe("pi");
  });

  test("registry 字段：CC 不写（老数据逐字节不变），Pi 写 runtime + 档案", () => {
    expect(claudeCodeAdapter.registryFields(specCreate(base))).toEqual({});
    expect(piAdapter.registryFields(specCreate(base))).toEqual({ runtime: "pi" });
    expect(piAdapter.registryFields(specCreate({ ...base, piEnv: { base: "minimal" } }))).toEqual({
      runtime: "pi",
      piEnv: { base: "minimal" },
    });
  });

  test("会话 id 格式：CC 要 UUID，Pi 收自造 id", () => {
    expect(claudeCodeAdapter.isValidSessionId(SID)).toBe(true);
    expect(claudeCodeAdapter.isValidSessionId("my-pi-session")).toBe(false);
    expect(piAdapter.isValidSessionId("my-pi-session")).toBe(true);
    expect(piAdapter.isValidSessionId("")).toBe(false);
  });

  test("sessionIdFromPath：三家的文件名规则", () => {
    expect(claudeCodeAdapter.sessionIdFromPath(`/h/.claude/projects/x/${SID}.jsonl`)).toBe(SID);
    expect(piAdapter.sessionIdFromPath("/h/.pi/agent/sessions/--x--/2026-09-23T01-02-03-004Z_my_id.jsonl")).toBe("my_id");
    expect(codexAdapter.sessionIdFromPath(
      "/h/.codex/sessions/2026/09/22/rollout-2026-09-22T16-14-49-01a0c7f7-a1d2-7d71-92fb-e2936564d987.jsonl",
    )).toBe("01a0c7f7-a1d2-7d71-92fb-e2936564d987");
    expect(claudeCodeAdapter.sessionIdFromPath("/x/notes.txt")).toBeNull();
  });
});

describe("control 声明", () => {
  test("CC：C-c 打断、人类消息抢占、看 pane、会话内补 /model", () => {
    expect(controlFor("claude-code")).toEqual({
      interruptKeys: ["C-c"],
      preemptOnHumanMessage: true,
      idleSource: "pane",
      modelEnforcement: "in-session",
      paneHeuristics: true,
    });
  });

  test("Pi：维持 C-c，不抢占、忙闲只信 hook、模型以启动参数为准（restart 不再补发 /model）", () => {
    expect(controlFor("pi")).toEqual({
      interruptKeys: ["C-c"],
      preemptOnHumanMessage: false,
      idleSource: "hook",
      modelEnforcement: "launch-flag",
      paneHeuristics: false,
    });
  });

  test("Codex 还只读，但打断键已声明为 Escape（空闲时 C-c = 退出）", () => {
    expect(controlFor("codex").interruptKeys).toEqual(["Escape"]);
    expect(managedFor("codex")).toBeNull();
  });

  test("缺省 / 未知 runtime 回退 CC 的策略（历史数据没有 runtime 字段）", () => {
    expect(controlFor(undefined)).toBe(claudeCodeAdapter.control);
    expect(controlFor("gpt-9")).toBe(claudeCodeAdapter.control);
  });

  test("打断回执里的按键名给人看", () => {
    expect(describeKeys(controlFor(undefined).interruptKeys)).toBe("Ctrl+C");
    expect(describeKeys(controlFor("codex").interruptKeys)).toBe("Esc");
  });
});

describe("managedFor / requireManaged", () => {
  test("缺省 = Claude Code；认不出 / 只读 = null", () => {
    expect(managedFor(undefined)).toBe(claudeCodeAdapter);
    expect(managedFor("")).toBe(claudeCodeAdapter);
    expect(managedFor("pi")).toBe(piAdapter);
    expect(managedFor("gpt-9")).toBeNull();
    expect(managedFor("codex")).toBeNull();
  });

  test("requireManaged 的报错分得清「只读来源」与「不认识」", () => {
    expect(() => requireManaged("codex")).toThrow(/只读会话来源/);
    expect(() => requireManaged("gpt-9")).toThrow(/未知的 runtime: "gpt-9"。可用: claude-code, pi/);
    expect(manageableRuntimeIds()).toEqual(["claude-code", "pi"]);
  });
});

// ── 3. 就绪 / 退出判据（假窗口） ─────────────────────────────────────

function fakeWindow(panes: string[], opts: Record<string, string> = {}) {
  const keys: string[] = [];
  const lines: string[] = [];
  const literals: string[] = [];
  let i = 0;
  const win: WindowOps = {
    name: "agent-foo",
    target: "master:agent-foo",
    capture: async () => panes[Math.min(i++, panes.length - 1)] ?? "",
    sendLine: async (t) => void lines.push(t),
    sendLiteral: async (t) => void literals.push(t),
    sendKey: async (k) => void keys.push(k),
    sendEscape: async () => void keys.push("Escape"),
    getOption: async (k) => opts[k] ?? null,
    setOption: async (k, v) => {
      opts[k] = v;
      return true;
    },
    childPids: async () => [],
    sleep: async () => {},
  };
  return { win, keys, lines, literals, opts };
}

const CC_READY = "some output\n\n❯ \n──────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
const CC_BOOTING = "Loading…";
const CC_IDLE_PROMPT = [
  "This session is 21h 6m old and 913.2k tokens.",
  "❯ 1. Resume from summary (recommended)",
  "  2. Resume full session as-is",
  "  3. Don't ask me again",
  "Enter to confirm · Esc to cancel",
].join("\n");
const SHELL = "user@host ~/repo %";

describe("Claude Code waitReady", () => {
  const budget = { rounds: 10, pollMs: 0 };

  test("看到 ❯ + 横幅即就绪", async () => {
    const { win } = fakeWindow([CC_BOOTING, CC_BOOTING, CC_READY]);
    expect(await claudeCodeAdapter.waitReady(win, budget)).toEqual({ ready: true, recoveredFullSession: false });
  });

  test("闲置弹窗：只选一次「恢复完整会话」（Down + Enter），就绪时带 recoveredFullSession", async () => {
    const { win, keys } = fakeWindow([CC_IDLE_PROMPT, CC_IDLE_PROMPT, CC_READY]);
    expect(await claudeCodeAdapter.waitReady(win, budget)).toEqual({ ready: true, recoveredFullSession: true });
    expect(keys).toEqual(["Down", "Enter"]);
  });

  test("会话被 bg agent 占用 → occupied（调用方走 fork 自愈）", async () => {
    const { win } = fakeWindow([CC_BOOTING, "Error: session is currently running as a background agent"]);
    const r = await claudeCodeAdapter.waitReady(win, budget);
    expect(r.ready).toBe(false);
    expect(r.ready === false && r.reason).toBe("occupied");
  });

  test("预算用完 → timeout", async () => {
    const { win } = fakeWindow([CC_BOOTING]);
    const r = await claudeCodeAdapter.waitReady(win, { rounds: 3, pollMs: 0 });
    expect(r.ready === false && r.reason).toBe("timeout");
  });
});

describe("Pi waitReady / beforeLaunch", () => {
  test("beforeLaunch 清零就绪标记（复用窗口不能认旧的 1）", async () => {
    const { win, opts } = fakeWindow([""], { "@claudestra_ready": "1" });
    await piAdapter.beforeLaunch!(win);
    expect(opts["@claudestra_ready"]).toBe("0");
  });

  test("扩展写下 @claudestra_ready=1 即就绪，不看 pane 文案", async () => {
    const { win } = fakeWindow(["随便什么 TUI"], { "@claudestra_ready": "1" });
    expect(await piAdapter.waitReady(win, { rounds: 5, pollMs: 0 })).toEqual({ ready: true });
  });

  test("窗口回到 shell = pi 已退出，早败 exited", async () => {
    const { win } = fakeWindow([SHELL], { "@claudestra_ready": "0" });
    const r = await piAdapter.waitReady(win, { rounds: 20, pollMs: 0 });
    expect(r.ready === false && r.reason).toBe("exited");
  });
});

describe("退出收尾", () => {
  test("CC onExitPane：确认框按 Enter、/exit 落进补全列表再按 Enter、无关屏幕不动", async () => {
    const { win, keys } = fakeWindow([]);
    expect(await claudeCodeAdapter.onExitPane!("/exit   Exit the REPL", win)).toBe("handled");
    expect(keys).toEqual(["Enter"]);
    expect(await claudeCodeAdapter.onExitPane!("Goodbye!", win)).toBe("handled");
    expect(await claudeCodeAdapter.onExitPane!("普通输出", win)).toBe("none");
    expect(keys).toEqual(["Enter"]);
  });

  test("Pi 没有 CC 那套收尾弹窗", () => {
    expect(piAdapter.onExitPane).toBeUndefined();
  });
});
