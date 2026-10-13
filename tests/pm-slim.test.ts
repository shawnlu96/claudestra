/**
 * 协调者启动瘦身（lib/pm-slim.ts，agents-PMSLIM1）：只用合成策略和临时状态目录，不起真实 PM。
 * 测试里的 agent 名带 slimtest，免得记录文件串到同进程跑的其他上下文边界测试。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { CONFIG_PATH } from "../src/lib/paths.ts";
import { PROJECTS_PATH } from "../src/lib/projects.ts";
import { buildClaudeCommand } from "../src/lib/claude-launch.ts";
import { codexAdapter, type LaunchSpec } from "../src/lib/runtimes/index.ts";
import { claudeLaunchOptions } from "../src/lib/runtimes/claude-code.ts";
import { ccLaunchSettings, compactCommand, DEFAULT_KEEP_LIST, matchPolicy, resolvePolicies, type CompactKeep } from "../src/lib/ctx-boundary-policy.ts";
import {
  applyPmSlimSettings, pmSlimAction, pmSlimForLaunch, pmSlimModePath, pmSlimPlan, pmSlimRecordPath, readPmSlimMode, readPmSlimRecord,
  type PmSlimLaunchDeps, type PmSlimMode,
} from "../src/lib/pm-slim.ts";
import { ctxBoundaryTick, resetCtxBoundaryState } from "../src/bridge/ctx-boundary.ts";
import { agent, harness, MIN } from "./ctx-boundary-harness.ts";

const PM = "agent-pm-slimtest";
const EXEC = "agent-task-slimtest";
const DENY = ["mcp__playwright", "mcp__tavily"];

const writeMode = (mode: unknown) => {
  mkdirSync(dirname(pmSlimModePath()), { recursive: true });
  writeFileSync(pmSlimModePath(), typeof mode === "string" ? JSON.stringify({ mode }) : String(mode));
};
const SID = "11111111-1111-1111-1111-111111111111";
const spec = (name: string): LaunchSpec => ({ mode: "new", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: SID, agentName: name, settingsName: name });
const settingsOf = (cmd: string): Record<string, unknown> | null => {
  const m = cmd.match(/--settings '([^']*)'/);
  return m ? JSON.parse(m[1]) : null;
};
const count = (s: string, flag: string) => s.split(` ${flag} `).length - 1;
const plan = (mode: PmSlimMode, policies = resolvePolicies(undefined).policies, name = PM) => pmSlimPlan({ name }, policies, mode);

function clean() {
  rmSync(pmSlimModePath(), { force: true });
  for (const n of [PM, EXEC]) rmSync(pmSlimRecordPath(n), { force: true });
}
beforeEach(() => {
  clean();
  resetCtxBoundaryState();
});
afterEach(clean);

describe("[验收线 1] on：permissions.deny 合并去重，不加 MCP 配置参数；执行者和 Codex 原样", () => {
  test("内置 coordinator 缺省排除两组工具；已有的一条 deny 在前、去重", () => {
    const p = plan("on")!;
    expect(p.deny).toEqual(DENY);
    const own = { skillOverrides: { a: "off" }, permissions: { deny: ["Bash(rm:*)", "mcp__tavily"], allow: ["Read"] } };
    expect(applyPmSlimSettings(own, p)).toEqual({
      skillOverrides: { a: "off" },
      autoCompactWindow: 300_000,
      permissions: { allow: ["Read"], deny: ["Bash(rm:*)", "mcp__tavily", "mcp__playwright"] },
    });
    expect(own.permissions.deny).toEqual(["Bash(rm:*)", "mcp__tavily"]); // 不改调用方的对象
  });

  test("完整启动串：on 的 --settings 带两条 deny，--strict-mcp-config / --mcp-config 个数与基线一样", () => {
    writeMode("on");
    const opts = claudeLaunchOptions(spec(PM));
    expect(opts.pmSlim?.mode).toBe("on");
    const base = buildClaudeCommand({ ...opts, pmSlim: undefined });
    const on = buildClaudeCommand(opts);
    expect((settingsOf(on)!.permissions as { deny: string[] }).deny).toEqual(DENY);
    for (const f of ["--strict-mcp-config", "--mcp-config"]) expect(count(on, f)).toBe(count(base, f));
    expect(count(on, "--settings")).toBe(1);
  });

  test("执行者（名字或 linked worktree）不算协调者：计划为 null，启动串与基线逐字相等", () => {
    writeMode("on");
    const opts = claudeLaunchOptions(spec(EXEC));
    expect(opts.pmSlim).toBeNull();
    expect(buildClaudeCommand(opts)).toBe(buildClaudeCommand({ ...opts, pmSlim: undefined }));
    // 名字写进 coordinator 的 match，但工作目录是 worktree：照样排除
    const pols = resolvePolicies([{ id: "coordinator", match: { names: ["agent-*"] } }]).policies;
    expect(pmSlimPlan({ name: "agent-wt", worktree: true }, pols, "on")).toBeNull();
    expect(pmSlimPlan({ name: EXEC }, pols, "on")).toBeNull();
  });

  test("Codex 启动串不受开关影响", () => {
    const prev = process.env.CODEX_TUI_BIN;
    process.env.CODEX_TUI_BIN = "/usr/bin/true";
    try {
      writeMode("off");
      const off = codexAdapter.buildLaunchCommand({ ...spec(PM), cwd: "/tmp" });
      writeMode("on");
      expect(codexAdapter.buildLaunchCommand({ ...spec(PM), cwd: "/tmp" })).toBe(off);
      expect(off).not.toContain("permissions");
    } finally {
      if (prev === undefined) delete process.env.CODEX_TUI_BIN;
      else process.env.CODEX_TUI_BIN = prev;
    }
  });
});

describe("[验收线 2] autoCompactWindow 与已有设置合并；observe / off 逐字等于基线", () => {
  const pols = resolvePolicies([{ id: "coordinator", ccWindow: 200_000 }]).policies;
  const own = { effortLevel: "high", hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };

  test("ccWindow=200000 → 保留旧字段并带 autoCompactWindow；null / 无策略不带", () => {
    const s = applyPmSlimSettings(own, plan("on", pols));
    expect(s).toMatchObject({ ...own, autoCompactWindow: 200_000 });
    const nul = resolvePolicies([{ id: "coordinator", ccWindow: null }]).policies;
    expect(applyPmSlimSettings(own, plan("on", nul))).not.toHaveProperty("autoCompactWindow");
    expect(plan("on", pols, "agent-car")).toBeNull();
    expect(applyPmSlimSettings(own, null)).toBe(own);
    expect(ccLaunchSettings(matchPolicy(pols, { name: PM }))).toEqual({ autoCompactWindow: 200_000 });
  });

  test("observe / off：settings 原对象，完整命令与不带计划的基线逐字相等；observe 写候选记录、不含 MCP 服务器配置", () => {
    for (const mode of ["observe", "off"] as const) {
      expect(applyPmSlimSettings(own, plan(mode, pols))).toBe(own);
      writeMode(mode);
      const opts = claudeLaunchOptions(spec(PM));
      expect(opts.pmSlim?.mode).toBe(mode);
      expect(buildClaudeCommand(opts)).toBe(buildClaudeCommand({ ...opts, pmSlim: undefined }));
    }
    writeMode("observe");
    claudeLaunchOptions(spec(PM));
    const rec = readPmSlimRecord(PM) as Record<string, unknown>;
    expect(rec).toMatchObject({ mode: "observe", policy: "coordinator", deny: DENY, autoCompactWindow: 300_000, action: "compact", keep: "default" });
    expect(Array.isArray(rec.reasons)).toBe(true);
    expect(JSON.stringify(rec)).not.toMatch(/mcpServers|command|env/);
  });

  test("开关文件：不在 → observe；坏了 / mode 不认得 → off 带诊断", () => {
    expect(readPmSlimMode()).toEqual({ mode: "observe", diag: null });
    writeMode("{not json");
    expect(readPmSlimMode()).toMatchObject({ mode: "off", diag: expect.any(String) });
    writeMode("maybe");
    expect(readPmSlimMode()).toMatchObject({ mode: "off", diag: expect.any(String) });
  });
});

describe("[验收线 3] on 注入 /compact <清单>；observe / off 仍是 /save-compact；守卫照旧", () => {
  const keepPols = resolvePolicies([{ id: "coordinator", keep: "只留卡号" }]).policies;
  const inject = (mode: PmSlimMode, pols = keepPols, name = PM) => {
    const m = matchPolicy(pols, { name });
    const read = () => ({ mode, action: "compact", session: SID });
    return compactCommand(pmSlimAction({ name, sessionId: SID }, m, m?.policy.action ?? "save-compact", read), m?.policy.keep ?? null);
  };

  test("命令字符串", () => {
    expect(inject("on")).toBe("/compact 只留卡号");
    expect(inject("on", resolvePolicies(undefined).policies)).toBe(`/compact ${DEFAULT_KEEP_LIST}`);
    expect(inject("observe")).toBe("/save-compact");
    expect(inject("off")).toBe("/save-compact");
    // 其他策略（自定义 save-compact 的个人 agent）不受影响
    const other = resolvePolicies([{ id: "mine", match: { names: ["agent-car"] }, window: 100_000, action: "save-compact" }]).policies;
    expect(inject("on", other, "agent-car")).toBe("/save-compact");
    // 没有启动记录（上次不是按 on 起的）→ 原样
    expect(pmSlimAction({ name: PM, sessionId: SID }, matchPolicy(keepPols, { name: PM }), "save-compact")).toBe("save-compact");
  });

  test("旧 on 记录不沿用：本次读失败 / 不命中 → 删记录；会话 id 对不上 → 原样", () => {
    const m = matchPolicy(keepPols, { name: PM });
    writeMode("on");
    claudeLaunchOptions(spec(PM));
    expect(pmSlimAction({ name: PM, sessionId: SID }, m, "save-compact")).toBe("compact");
    expect(pmSlimAction({ name: PM, sessionId: "another-session" }, m, "save-compact")).toBe("save-compact");
    const throwing: PmSlimLaunchDeps = {
      mode: () => ({ mode: "off", diag: null }), policies: () => { throw new Error("boom"); }, projectId: () => undefined, worktree: () => false,
      record: () => true, clear: (n) => rmSync(pmSlimRecordPath(n), { force: true }), log: () => {},
    };
    expect(pmSlimForLaunch({ name: PM, sessionId: SID, mode: "resume" }, throwing)).toBeNull();
    expect(readPmSlimRecord(PM)).toBeNull();
    expect(pmSlimAction({ name: PM, sessionId: SID }, m, "save-compact")).toBe("save-compact");
    // 没有 session 键的记录不认
    expect(pmSlimAction({ name: PM, sessionId: SID }, m, "save-compact", () => ({ mode: "on", action: "compact" }))).toBe("save-compact");
  });

  const pm = () => agent({ name: PM, target: `master:${PM}`, projectId: null, sessionId: SID, ctx: 200_000, convTs: 0, mtime: 0 });

  test("bridge 端到端：on 启动记录 → 发 /compact；草稿挡住、15 分钟守卫内不发", async () => {
    writeMode("on");
    claudeLaunchOptions(spec(PM));
    const h = harness([pm()]);
    h.deps.agents = async () => [pm()];
    await ctxBoundaryTick(h.deps);
    expect(h.sent.map((x) => x.line)).toEqual([`/compact ${DEFAULT_KEEP_LIST}`]);
    h.advance(MIN);
    expect((await ctxBoundaryTick(h.deps))[0].verdict.fire).toBe(false); // 守卫 / 冷却
    expect(h.sent.length).toBe(1);

    resetCtxBoundaryState();
    const d = harness([pm()], { state: { draft: true } });
    const r = await ctxBoundaryTick(d.deps);
    expect(r[0].verdict).toEqual({ fire: false, reason: "draft" });
    expect(d.sent).toEqual([]);
  });

  test("bridge 端到端：observe 启动记录 → 仍发 /save-compact", async () => {
    writeMode("observe");
    claudeLaunchOptions(spec(PM));
    const h = harness([pm()]);
    await ctxBoundaryTick(h.deps);
    expect(h.sent.map((x) => x.line)).toEqual(["/save-compact"]);
  });
});

describe("[验收线 4] 坏配置只忽略该字段，诊断不带原值；resume / restart 同 new", () => {
  test("ccDeny 非数组 / 含非字符串、ccWindow 非正整数：只忽略该字段，其余照常", () => {
    const bad = [{ ccDeny: "mcp__secret_srv" }, { ccDeny: ["mcp__ok", 42] }, { ccWindow: -7 }, { ccWindow: 123.5 }];
    for (const e of bad) {
      const r = resolvePolicies([{ id: "coordinator", window: 170_000, ...e }]);
      const c = r.policies.find((p) => p.id === "coordinator")!;
      expect(c.window).toBe(170_000);
      if ("ccDeny" in e) expect(c.ccDeny).toEqual(DENY);
      else expect(c.ccWindow).toBeNull();
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0].text).not.toMatch(/secret_srv|mcp__ok|42|-7|123\.5/);
    }
  });

  const launch = (deps: PmSlimLaunchDeps, name = PM) => pmSlimForLaunch({ name, sessionId: SID, mode: "new" }, deps);

  test("配置读失败 → 按 off（null），记一条短诊断，不写记录并清掉旧记录；诊断进记录的理由", () => {
    const logs: string[] = [];
    const recs: unknown[] = [];
    const cleared: string[] = [];
    const deps = (over: Partial<PmSlimLaunchDeps>): PmSlimLaunchDeps => ({
      mode: () => ({ mode: "on", diag: null }), policies: () => resolvePolicies(undefined), projectId: () => undefined, worktree: () => false,
      record: (p) => (recs.push(p), true), clear: (n) => void cleared.push(n), log: (t) => void logs.push(t), ...over,
    });
    expect(launch(deps({ policies: () => { throw new Error("boom"); } }))).toBeNull();
    expect([recs.length, logs.length, cleared]).toEqual([0, 1, [PM]]);
    const p = launch(deps({ mode: () => ({ mode: "off", diag: "pm-slim.json 读不出来，按 off" }) }))!;
    expect(p.mode).toBe("off");
    expect(p.reasons).toContain("pm-slim.json 读不出来，按 off");
    const w = launch(deps({ policies: () => resolvePolicies([{ id: "coordinator", ccDeny: 5 }]) }))!;
    expect(w.reasons.some((r) => r.startsWith("ccDeny"))).toBe(true);
    // 记录写不进去 → 本次按 off，并清旧记录
    cleared.length = 0;
    expect(launch(deps({ record: () => false }))).toBeNull();
    expect(cleared).toEqual([PM]);
  });

  test("config.json 损坏 → 按 off：不沿用 readConfigSync 的上次成功值 / 安全默认", () => {
    writeMode("on");
    const cfg = CONFIG_PATH;
    const had = existsSync(cfg) ? readFileSync(cfg, "utf8") : null;
    try {
      writeFileSync(cfg, "{not json");
      const opts = claudeLaunchOptions(spec(PM));
      expect(opts.pmSlim).toBeNull();
      expect(settingsOf(buildClaudeCommand(opts))?.permissions).toBeUndefined();
      expect(readPmSlimRecord(PM)).toBeNull();
    } finally {
      if (had === null) rmSync(cfg, { force: true });
      else writeFileSync(cfg, had);
    }
  });

  test("首次以新名字 resume / fork（不带 agentName / settingsName）：按 displayName 认出协调者", () => {
    writeMode("on");
    for (const mode of ["resume", "fork"] as const) {
      const fresh: LaunchSpec = { mode, channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: SID, displayName: PM.replace("agent-", "") };
      const opts = claudeLaunchOptions(fresh);
      expect(opts.pmSlim?.agent).toBe(PM);
      expect((settingsOf(buildClaudeCommand(opts))!.permissions as { deny: string[] }).deny).toEqual(DENY);
      expect([opts.agentName, opts.settingsAgent]).toEqual([undefined, undefined]); // 命令里的自称 / 设置名语义不变
    }
  });
  test("首次以新名字 resume / fork、按项目匹配（registry 里还没这一行）：按启动目录归属的项目认出协调者", () => {
    writeMode("on");
    const lead = "agent-lead-slimtest";
    const dir = mkdtempSync(join(tmpdir(), "pm-slim-proj-"));
    const saved = [CONFIG_PATH, PROJECTS_PATH].map((f) => (existsSync(f) ? readFileSync(f, "utf8") : null));
    try {
      writeFileSync(CONFIG_PATH, JSON.stringify({ autoCompact: { policies: [{ id: "coordinator", match: { projects: ["slimtest-proj"], names: [] } }] } }));
      writeFileSync(PROJECTS_PATH, JSON.stringify({ projects: [{ id: "slimtest-proj", name: "p", dirs: [dir], createdAt: "" }] }));
      for (const mode of ["resume", "fork"] as const) {
        const opts = claudeLaunchOptions({ mode, channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: SID, displayName: "lead-slimtest", cwd: dir });
        expect(opts.pmSlim?.agent).toBe(lead);
        expect(opts.pmSlim?.reasons[0]).toContain("project");
        expect((settingsOf(buildClaudeCommand(opts))!.permissions as { deny: string[] }).deny).toEqual(DENY);
        expect(readPmSlimRecord(lead)?.mode).toBe("on");
      }
      // 目录不归这个项目 → 不命中，原样
      const other = claudeLaunchOptions({ mode: "resume", channelId: "123", bridgeUrl: "ws://localhost:3847", sessionId: SID, displayName: "lead-slimtest", cwd: tmpdir() });
      expect(other.pmSlim).toBeNull();
    } finally {
      [CONFIG_PATH, PROJECTS_PATH].forEach((f, i) => (saved[i] === null ? rmSync(f, { force: true }) : writeFileSync(f, saved[i]!)));
      rmSync(pmSlimRecordPath(lead), { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("resume / fork 与 new 同口径", () => {
    writeMode("on");
    for (const mode of ["resume", "fork"] as const) {
      const opts = claudeLaunchOptions({ ...spec(PM), mode });
      expect(opts.pmSlim?.mode).toBe("on");
      expect((settingsOf(buildClaudeCommand(opts))!.permissions as { deny: string[] }).deny).toEqual(DENY);
    }
  });
});
