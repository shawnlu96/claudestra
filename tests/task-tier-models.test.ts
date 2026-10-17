/**
 * TIER3 类型 × 角色的模型解析（src/lib/task-tier-models.ts）与本机各角色的 argv（card-role-definitions.ts applyCardRole / tierCreate）：
 * 默认表逐格、「类型格 → 角色格 → 产品默认」与显式继承、旧表兼容且读取不改写、Codex 降档不猜、家族不换、作者覆盖扩展点在下限内生效。
 * 不调真实模型：applyCardRole 只产 argv，create 是替身。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCardRole, tierCreate } from "../src/lib/card-role-definitions.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { CARD_ROLES, defaultRoleModels, readRoleModels, roleModelsProblem, type CardRole, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { resetDocsTemplate } from "../src/lib/task-tier-docs-template.js";
import { registerAuthorTierOverride, resolveTierModel, TIER_DEFAULTS, useTaskTierPort, type TierLaunchCtx } from "../src/lib/task-tier-models.js";
import type { TierTable } from "../src/lib/task-tier-model-settings.js";
import { TASK_TIERS, type TaskTier } from "../src/lib/task-tier-spec.js";

const OPUS = "claude-opus-5-5", SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const cleanups: (() => void)[] = [];
afterEach(() => { useTaskTierPort(); useRoleModelPort(); registerAuthorTierOverride(null); for (const c of cleanups.splice(0)) c(); });

const MISSING: RoleModelRead = { status: "missing", table: defaultRoleModels() };
const withTable = (edit: (t: ReturnType<typeof defaultRoleModels>) => void): RoleModelRead => { const t = defaultRoleModels(); t.rev = 1; edit(t); return { status: "ok", table: t }; };
/** taskTierModels 的模式与读到的表；旧 roleModel 键固定 observe 且不落盘，只看本卡行为 */
function port(mode: "on" | "observe" | "off", read: RoleModelRead = MISSING): { reads: () => number } {
  let n = 0;
  useTaskTierPort({ policy: () => ({ mode, manualAfterMs: null, source: "config" }), read: () => (n++, read) });
  useRoleModelPort({ policy: () => ({ mode: "observe", manualAfterMs: null, source: "config" }), read: () => MISSING, observe: () => undefined });
  return { reads: () => n };
}
const ctx = (tier: string, extra: Partial<TierLaunchCtx> = {}): TierLaunchCtx => ({ project: "p1", card: "T1", tier, round: 0, ...extra });
const author = (...extra: string[]) => ["create", "a1", "/w", "--purpose", "T1 作者", "--task", "T1", "--card", "T1", "--card-role", "author", "--effort", "high",
  "--project", "p1", ...extra];
const reviewer = (...extra: string[]) => ["create", "r1", "/w", "--purpose", "T1 审查", "--project", "p1", "--task", "T1 审查", "--card", "T1", "--card-role", "reviewer", ...extra];
const pm = (...extra: string[]) => ["create", "m1", "/w", "--purpose", "T1 PM 审", "--project", "p1", "--card", "T1", "--card-role", "other", ...extra];
const CODEX = ["--runtime", "codex", "--transport", "acp"];
const argsOf = (r: ReturnType<typeof applyCardRole>) => ("error" in r ? (() => { throw new Error(r.error); })() : r.args);
const flag = (args: string[], f: string) => { const i = args.indexOf(f); return i < 0 ? undefined : args[i + 1]; };

describe("[验收线 1] 默认表（产品默认，表里什么都没存）", () => {
  const want: Record<TaskTier, Record<CardRole, string>> = {
    security: { author: OPUS, reviewer: OPUS, "adversarial-reviewer": OPUS, "pm-reviewer": OPUS },
    code: { author: OPUS, reviewer: OPUS, "adversarial-reviewer": OPUS, "pm-reviewer": SONNET },
    ui: { author: SONNET, reviewer: OPUS, "adversarial-reviewer": OPUS, "pm-reviewer": SONNET },
    docs: { author: HAIKU, reviewer: OPUS, "adversarial-reviewer": OPUS, "pm-reviewer": SONNET },
  };
  test.each(TASK_TIERS.flatMap((t) => CARD_ROLES.map((r) => [t, r] as const)))("Claude %s × %s", (tier, role) => {
    expect(resolveTierModel(MISSING, tier, role, "claude").value).toBe(want[tier][role]);
  });

  test("Codex：security / code 沿用原档；ui / docs 作者已知原档降一档；审查员与 pm-reviewer 沿用原格", () => {
    const base = "high" as const;
    expect(resolveTierModel(MISSING, "security", "author", "codex", base).value).toBe("high");
    expect(resolveTierModel(MISSING, "code", "author", "codex", base).value).toBe("high");
    expect(resolveTierModel(MISSING, "ui", "author", "codex", base).value).toBe("medium");
    expect(resolveTierModel(MISSING, "docs", "author", "codex", "minimal").value).toBe("minimal");
    const t = withTable((x) => { x.roles.reviewer.codex = "xhigh"; });
    for (const tier of TASK_TIERS) expect(resolveTierModel(t, tier, "reviewer", "codex")).toMatchObject({ value: "xhigh", source: "role-settings" });
    expect(TIER_DEFAULTS.ui["pm-reviewer"].codex).toBe("inherit");
  });

  test("原档是 null（照 Codex 配置）或不可核实：不猜降档，照原样并注明", () => {
    expect(resolveTierModel(MISSING, "ui", "author", "codex")).toEqual({ value: null, source: "role-default", note: "原档不可核实，不猜降档" });
    expect(resolveTierModel(MISSING, "docs", "author", "codex", null)).toMatchObject({ value: null, note: expect.stringContaining("不猜") });
  });
});

describe("[验收线 1] 继承与旧配置", () => {
  test("缺省（不写）用产品默认；显式 inherit 用角色格；类型格写了值用类型格", () => {
    const roles = (tiers?: TierTable) => withTable((t) => { t.roles.author.claude = SONNET; t.roles.reviewer.claude = HAIKU; if (tiers) t.tiers = tiers; });
    expect(resolveTierModel(roles(), "code", "author", "claude")).toEqual({ value: OPUS, source: "tier-default" });
    expect(resolveTierModel(roles({ code: { author: { claude: "inherit" } } }), "code", "author", "claude")).toEqual({ value: SONNET, source: "role-settings" });
    expect(resolveTierModel(roles({ code: { author: { claude: HAIKU } } }), "code", "author", "claude")).toEqual({ value: HAIKU, source: "tier-settings" });
    expect(resolveTierModel(roles(), "code", "reviewer", "claude")).toEqual({ value: HAIKU, source: "role-settings" });
    expect(resolveTierModel(roles({ ui: { author: { codex: "low" } } }), "ui", "author", "codex", "high")).toEqual({ value: "low", source: "tier-settings" });
  });

  test("旧表（没有 tiers）照样有效，读取不改写；表坏时 tiers 不用", () => {
    const dir = mkdtempSync(join(tmpdir(), "tier3-old-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "role-model-settings.json"), old = { ...defaultRoleModels(), rev: 4 };
    old.roles.reviewer = { claude: SONNET, codex: "high" };
    const text = `${JSON.stringify(old, null, 2)}\n`;
    writeFileSync(path, text);
    expect(roleModelsProblem(old)).toBeNull();
    const read = readRoleModels(path);
    expect(read.status).toBe("ok");
    expect(resolveTierModel(read, "code", "reviewer", "claude").value).toBe(SONNET);
    expect(readFileSync(path, "utf8")).toBe(text);
    const bad: RoleModelRead = { status: "invalid", error: "x", table: defaultRoleModels() };
    expect(resolveTierModel(bad, "code", "author", "claude")).toEqual({ value: OPUS, source: "tier-default" });
  });
});

describe("[验收线 1] 本机各角色 argv（on）", () => {
  test("Claude：作者 / 审查员 / pm-reviewer 按类型传 --model，别的 argv 一字不动", () => {
    port("on");
    const ui = argsOf(applyCardRole(author(), { tier: ctx("ui") }));
    expect(flag(ui, "--model")).toBe(SONNET);
    const old = argsOf(applyCardRole(author())); // 不带类型上下文 = TIER1 旧路径（定义里的 Opus）
    expect(ui).toEqual(old.map((x, i) => (old[i - 1] === "--model" ? SONNET : x)));
    expect(flag(argsOf(applyCardRole(reviewer(), { tier: ctx("ui") })), "--model")).toBe(OPUS);
    expect(flag(argsOf(applyCardRole(pm(), { role: "pm-reviewer", tier: ctx("code") })), "--model")).toBe(SONNET);
    expect(flag(argsOf(applyCardRole(pm(), { role: "pm-reviewer", tier: ctx("security") })), "--model")).toBe(OPUS);
  });

  test("Codex：原档 --effort 就地换（ui 作者 high → medium），永不带 --model，runtime 不变；审查员沿用原格", () => {
    port("on", withTable((t) => { t.roles.reviewer.codex = "xhigh"; }));
    const a = argsOf(applyCardRole([...author(), ...CODEX], { tier: ctx("ui", { baseEffort: "high" }) }));
    expect(a).toEqual([...author(), ...CODEX].map((x, i, all) => (all[i - 1] === "--effort" ? "medium" : x)));
    expect(a.includes("--model")).toBe(false);
    expect(flag(argsOf(applyCardRole([...author(), ...CODEX], { tier: ctx("code", { baseEffort: "high" }) })), "--effort")).toBe("high");
    expect(flag(argsOf(applyCardRole([...reviewer(), ...CODEX], { tier: ctx("ui") })), "--effort")).toBe("xhigh");
    expect(flag(argsOf(applyCardRole([...reviewer(), ...CODEX], { tier: ctx("ui") })), "--runtime")).toBe("codex");
  });

  test("显式 --model / --effort 照旧优先（非 security）", () => {
    port("on");
    expect(flag(argsOf(applyCardRole(author("--model", HAIKU), { tier: ctx("code") })), "--model")).toBe(HAIKU);
    expect(flag(argsOf(applyCardRole([...author(), ...CODEX].map((x, i, all) => (all[i - 1] === "--effort" ? "xhigh" : x)),
      { tier: ctx("ui", { baseEffort: "high" }) })), "--effort")).toBe("xhigh");
  });

  test("docs 卡起不了；卡首声明与已存流程冲突也起不了（拒绝带原因）", () => {
    resetDocsTemplate(); // 同进程先跑的开卡测试可能已按缺省 on 挂上 docs（进程级）；本条前提是没注册
    port("on");
    expect(applyCardRole(author(), { tier: ctx("docs") })).toMatchObject({ error: expect.stringContaining("docs 还没有注册流程模板") });
    expect(applyCardRole(author(), { tier: ctx("code", { specText: "# x\n模板：ui\n" }) })).toMatchObject({ error: expect.stringContaining("冲突") });
  });

  test("审查换会话的 tierCreate：只加 --model，不加载角色定义；off 原样", async () => {
    const seen: string[][] = [];
    const create = async (...a: string[]) => (seen.push(a), { ok: true });
    const swap = ["create", "agent-task-rv-t1-r1", "/w", "--project", "p1", "--card", "T1", "--card-role", "reviewer", "--purpose", "复验"];
    port("on", withTable((t) => { t.roles.reviewer.claude = SONNET; }));
    await tierCreate(create, ctx("code"), "reviewer")(...swap);
    port("off");
    await tierCreate(create, ctx("code"), "reviewer")(...swap);
    expect(seen).toEqual([[...swap, "--model", SONNET], swap]);
  });
});

describe("扩展点 1：建作者前的档位覆盖", () => {
  test("on：拿到覆盖值就用（只作者）；低于 security 下限不用，照 Opus 起并注明；显式仍优先", () => {
    port("on");
    const asked: string[] = [];
    registerAuthorTierOverride((q) => (asked.push(`${q.project}/${q.card}/${q.tier}/${q.family}`), q.family === "claude" ? SONNET : "xhigh"));
    const code = applyCardRole(author(), { tier: ctx("code") });
    expect(flag(argsOf(code), "--model")).toBe(SONNET);
    expect("tierLaunch" in code && code.tierLaunch?.source).toBe("override");
    const sec = applyCardRole(author(), { tier: ctx("security") });
    expect(flag(argsOf(sec), "--model")).toBe(OPUS);
    expect("tierLaunch" in sec && sec.tierLaunch?.note).toContain("低于安全下限");
    expect(flag(argsOf(applyCardRole([...author(), ...CODEX], { tier: ctx("code", { baseEffort: "high" }) })), "--effort")).toBe("xhigh");
    expect(flag(argsOf(applyCardRole(author("--model", HAIKU), { tier: ctx("code") })), "--model")).toBe(HAIKU);
    expect(flag(argsOf(applyCardRole(reviewer(), { tier: ctx("code") })), "--model")).toBe(OPUS);
    expect(asked).toEqual(["p1/T1/code/claude", "p1/T1/security/claude", "p1/T1/code/codex", "p1/T1/code/claude"]);
  });

  test("off / observe 不调用覆盖", () => {
    let n = 0;
    registerAuthorTierOverride(() => (n++, SONNET));
    for (const m of ["off", "observe"] as const) { port(m); applyCardRole(author(), { tier: ctx("code") }); }
    expect(n).toBe(0);
  });
});
