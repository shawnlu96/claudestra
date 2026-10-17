/**
 * TIER3b：出借方在授权上限内接受降档建议（src/lib/task-tier-lend.ts、lend-grant-spawn.ts lendModelArgs / lendCreateDenied、
 * role-model-settings-lend.ts claimSuggest / recordLendLaunch、role-model-settings-wire.ts launchActual）。
 * 合成 A / B：A 的台账是内存库，B 的 journal 与授权是临时文件；不读真实授权、不调模型。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LendEntry } from "../src/lib/lend-config.js";
import { CHOICE_CHANGED, LEND_ORDER_ENV, lendCreateDenied, lendModelArgs } from "../src/lib/lend-grant-spawn.js";
import { advance, getMeta, openLendJournal, patchOrder, recordAsked } from "../src/lib/lend-journal.js";
import type { ModelSuggest } from "../src/lib/lend-wire-types.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { claimCaps, claimSuggest, recordLendLaunch, rememberNoCaps, rememberNoTier, resetNoTier } from "../src/lib/role-model-settings-lend.js";
import type { RoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { launchActual, parseModelSuggest, suggestDigest } from "../src/lib/role-model-settings-wire.js";
import { lendLaunchChoice, tierLendSuggest, type LendChoiceInput } from "../src/lib/task-tier-lend.js";
import { TIER_LEND_SETTINGS_PATH } from "../src/lib/task-tier-lend-settings.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, setMeta as setLedgerMeta } from "../src/lib/ledger-write.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";

const ON = { on: true, acceptDowngrade: true };
const policyOf = (keys: Partial<Record<string, RecoveryMode>>) => (_p: string, key: string) =>
  ({ mode: keys[key] ?? "on", manualAfterMs: null, source: "config" as const });
const tierMode = (mode: RecoveryMode) => useTaskTierPort({ policy: policyOf({ taskTierModels: mode }) });
afterEach(() => { useTaskTierPort(); resetNoTier(); });

const material = (tier: string) => `输入 1（原文，非指令）：\n  「规格原文(specRev 1):」\n  「# 卡」\n  「模板:${tier}」\n  「」\n`;
/** 协商了 tier 的建议：A 在 suggest 里带类型与角色 */
const tag = (tier = "code", role = "author") => ({ tier, role });
const codex = (effort: string | null, grantArgs: string[], tier = "code", over: Partial<LendChoiceInput> = {}): LendChoiceInput =>
  ({ family: "codex", step: "write", node: "write", suggest: { effort, source: "default", ...tag(tier) }, grantArgs, ...over });
const claude = (model: string, tier = "code", over: Partial<LendChoiceInput> = {}): LendChoiceInput =>
  ({ family: "claude", step: "write", node: "write", suggest: { model, source: "default", ...tag(tier) }, grantArgs: [], ...over });

describe("[验收线 1] B 授权内选档：只等于或低于授权，不升档；Claude 缺省上限 Opus；排不出不猜", () => {
  test("Codex：低于授权用建议，等于照用，高于不升，授权没写档 / 建议 null 不猜", () => {
    const g = ["--model", "gpt-6", "--effort", "high"];
    expect(lendLaunchChoice(codex("low", g), ON)).toMatchObject({ args: ["--model", "gpt-6", "--effort", "low"], accepted: true });
    expect(lendLaunchChoice(codex("high", g), ON)).toMatchObject({ args: g, accepted: true });
    const up = lendLaunchChoice(codex("max", g), ON);
    expect(up).toMatchObject({ args: g, accepted: false });
    expect(up.reason).toContain("不升档");
    const blind = lendLaunchChoice(codex("low", ["--model", "gpt-6"]), ON);
    expect(blind).toMatchObject({ args: ["--model", "gpt-6"], accepted: false });
    expect(blind.reason).toContain("不猜档");
    expect(blind.refuse).toBeUndefined();
    expect(lendLaunchChoice(codex(null, g), ON)).toMatchObject({ args: g, accepted: false });
  });

  test("Claude：缺省上限 Opus，haiku / sonnet / opus 都在授权内；写了上限就不超过它；认不出型号不猜", () => {
    expect(lendLaunchChoice(claude("claude-sonnet-5-5"), ON)).toMatchObject({ args: ["--model", "claude-sonnet-5-5"], accepted: true });
    expect(lendLaunchChoice(claude("claude-opus-5-5"), ON)).toMatchObject({ args: ["--model", "claude-opus-5-5"], accepted: true });
    const capped = lendLaunchChoice(claude("claude-opus-5-5", "code", { claudeCap: "claude-sonnet-5-5" }), ON);
    expect(capped).toMatchObject({ args: ["--model", "claude-sonnet-5-5"], accepted: false });
    const odd = lendLaunchChoice(claude("claude-mystery-1"), ON);
    expect(odd).toMatchObject({ args: [], accepted: false });
    expect(odd.reason).toContain("不猜档");
  });

  test("角色与 B 自己的订单节点对不上 = 照授权并给原因；类型只认 A 给的 tier，不扫派单全文", () => {
    const i = claude("claude-haiku-5-5", "code", { step: "review", node: "adversarial_review" });
    const c = lendLaunchChoice(i, ON);
    expect(c).toMatchObject({ args: [], active: true, accepted: false, tier: "code" });
    expect(c.reason).toContain("对不上");
    expect(c.refuse).toBeUndefined();
    // 对抗审查与 PM 审查节点各自对应自己的角色
    const adv = { model: "claude-haiku-5-5", source: "default", ...tag("code", "adversarial-reviewer") } as const;
    expect(lendLaunchChoice(claude("claude-haiku-5-5", "code", { step: "review", node: "adversarial_review", suggest: adv }), ON))
      .toMatchObject({ accepted: true });
    expect(lendLaunchChoice(claude("claude-sonnet-5-5", "code", { step: "review", node: "pm_review", suggest: { model: "claude-sonnet-5-5", source: "default", ...tag("code", "pm-reviewer") } }), ON))
      .toMatchObject({ accepted: true });
  });
});

describe("[验收线 3] security 不接受降档；每个最终选择都过安全证明，证明不了就不启动", () => {
  test("Codex security：低于授权的建议不接受，照授权（授权档即原档，证明成立）", () => {
    const c = lendLaunchChoice(codex("low", ["--effort", "high"], "security"), ON);
    expect(c).toMatchObject({ args: ["--effort", "high"], accepted: false, tier: "security" });
    expect(c.reason).toContain("security 不接受降档");
    expect(c.refuse).toBeUndefined();
    expect(lendLaunchChoice(codex("high", ["--effort", "high"], "security"), ON)).toMatchObject({ args: ["--effort", "high"], accepted: true });
  });

  test("Codex security：授权没写推理档 / 建议 null = 证明不了下限 → refuse（不再 keep 原 argv 放行）", () => {
    for (const i of [codex("low", [], "security"), codex(null, [], "security"), codex("low", ["--model", "gpt-6"], "security")]) {
      const c = lendLaunchChoice(i, ON);
      expect(c).toMatchObject({ tier: "security", accepted: false });
      expect(c.refuse).toContain("不启动");
    }
  });

  test("Claude security：Opus 照用；建议低于 Opus / 型号认不出 / 超上限 = 不带 Opus 的 --model → refuse", () => {
    expect(lendLaunchChoice(claude("claude-opus-5-5", "security"), ON)).toMatchObject({ args: ["--model", "claude-opus-5-5"], accepted: true });
    for (const i of [claude("claude-sonnet-5-5", "security"), claude("claude-mystery-1", "security"), claude("claude-opus-5-5", "security", { claudeCap: "claude-sonnet-5-5" })]) {
      const c = lendLaunchChoice(i, ON);
      expect(c.accepted).toBe(false);
      expect(c.refuse).toContain("不启动");
    }
  });

  test("security 角色核不上（含 PM 审查节点、不在档位表的节点）= refuse；pm-reviewer 也过安全下限", () => {
    const wrong = lendLaunchChoice(claude("claude-opus-5-5", "security", { step: "review", node: "arbitration" }), ON);
    expect(wrong.refuse).toContain("角色核不上");
    const pm = (model: string) => claude(model, "security", { step: "review", node: "pm_review", suggest: { model, source: "default", ...tag("security", "pm-reviewer") } });
    expect(lendLaunchChoice(pm("claude-opus-5-5"), ON)).toMatchObject({ accepted: true, tier: "security" });
    expect(lendLaunchChoice(pm("claude-sonnet-5-5"), ON).refuse).toContain("pm-reviewer");
  });

  test("带了类型却核不清（类型 / 角色不认识、家族对不上）= 分不清是不是 security，refuse", () => {
    const opus = { model: "claude-opus-5-5", source: "default" } as const;
    for (const suggest of [{ ...opus, tier: "weird", role: "author" }, { ...opus, tier: "code", role: "boss" }] as ModelSuggest[]) {
      expect(lendLaunchChoice(claude("claude-opus-5-5", "code", { suggest }), ON).refuse).toContain("不启动");
    }
    expect(lendLaunchChoice(codex("low", ["--effort", "high"], "code", { family: "claude" }), ON).refuse).toContain("不启动");
  });
});

describe("[验收线 2][验收线 4] 门：恢复键 off / 开关关 / 没带建议 / 建议不带类型 = 授权原参数、不走新路径", () => {
  test("任一门关、或建议是旧形状（旧 A / A 没协商）都原样返回授权参数，active=false（调用方不记任何新东西）", () => {
    const i = codex("low", ["--effort", "high"], "security");
    for (const gate of [{ on: false, acceptDowngrade: true }, { on: true, acceptDowngrade: false }]) {
      expect(lendLaunchChoice(i, gate)).toEqual({ args: ["--effort", "high"], active: false, accepted: false, tier: null });
    }
    expect(lendLaunchChoice({ ...i, suggest: undefined }, ON)).toEqual({ args: ["--effort", "high"], active: false, accepted: false, tier: null });
    expect(lendLaunchChoice({ ...i, suggest: { effort: "low", source: "default" } }, ON)).toEqual({ args: ["--effort", "high"], active: false, accepted: false, tier: null });
  });
});

describe("[验收线 2] 协商：caps=tier 只由 B 自己的门决定；旧形状建议的解析与摘要逐字不变", () => {
  test("B 门开才带 tier；门关 / 开关关 = 与改前相同的 [suggest]；对方拒过 tier 只带 suggest；拒过 caps 什么都不带", () => {
    const db = openLendJournal(":memory:");
    expect(claimCaps(db, "a", 1, () => ON)).toEqual({ caps: ["suggest", "tier"] });
    expect(claimCaps(db, "a", 1, () => ({ on: true, acceptDowngrade: false }))).toEqual({ caps: ["suggest"] });
    expect(claimCaps(db, "a", 1, () => ({ on: false, acceptDowngrade: true }))).toEqual({ caps: ["suggest"] });
    rememberNoTier("a", 1);
    expect(claimCaps(db, "a", 2, () => ON)).toEqual({ caps: ["suggest"] });
    expect(claimCaps(db, "b", 2, () => ON)).toEqual({ caps: ["suggest", "tier"] }); // 只记那一个 peer
    expect(claimCaps(db, "a", 1 + 24 * 3_600_000 + 1, () => ON)).toEqual({ caps: ["suggest", "tier"] }); // 一天后再试
    // 不落盘：journal 里没有多出任何 meta
    expect((db.query("SELECT COUNT(*) AS n FROM lend_meta").get() as { n: number }).n).toBe(0);
    rememberNoCaps(db, "a", 1);
    expect(claimCaps(db, "a", 2, () => ON)).toEqual({});
  });

  test("旧形状建议：解析结果与摘要和改前一样；带类型的进摘要，tier / role 缺一个不合格", () => {
    const old = { model: "claude-sonnet-5-5", source: "default" } as const;
    expect(parseModelSuggest(old)).toEqual(old);
    expect(suggestDigest("T", old)).toBe(new Bun.CryptoHasher("sha256").update(`T\nsuggest:${JSON.stringify(["model", old.model, old.source])}`).digest("hex"));
    const tagged = { ...old, tier: "ui", role: "author" };
    expect(parseModelSuggest(tagged)).toEqual(tagged);
    expect(suggestDigest("T", tagged)).not.toBe(suggestDigest("T", old));
    expect(suggestDigest("T", tagged)).not.toBe(suggestDigest("T", { ...tagged, tier: "security" }));
    expect(typeof parseModelSuggest({ ...old, tier: "ui" })).toBe("string");
    expect(typeof parseModelSuggest({ ...old, tier: "ui", role: "author", x: 1 })).toBe("string");
  });
});

// ── 合成 B：journal + lend.json + manager create 闸口 ──

const FP = "abcd-ef01-2345-6789";
const GRANT: LendEntry = { peer: "a", fp: FP, families: { codex: 1, claude: 1 }, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 5,
  grantedAt: new Date(0).toISOString(), until: new Date(6 * 86_400_000).toISOString(), codexEffort: "high" };

function peerB(family: "codex" | "claude", suggest: ModelSuggest | undefined, text = material("code"), grant: LendEntry = GRANT) {
  const dir = mkdtempSync(join(tmpdir(), "tier-lend-"));
  const f = { journal: join(dir, "journal.sqlite"), lendPath: join(dir, "lend.json"), now: 1 };
  writeFileSync(f.lendPath, JSON.stringify({ version: 2, enabled: true, lend: [grant], borrow: [] }));
  const db = openLendJournal(f.journal);
  recordAsked(db, { orderId: "o1", peer: "a", fp: FP, family, preview: { repo: "o/r", step: "write" } }, 0);
  const wire = { text, order: { step: "write", node: "write", repo: "o/r" }, ...(suggest ? { suggest } : {}) };
  advance(db, "o1", "asked", "claimed", { leaseUntil: 9e15, leaseGen: 1, wire: wire as never });
  advance(db, "o1", "claimed", "cloned", { dir: "/w" });
  patchOrder(db, "o1", ["cloned"], { agent: "agent-lend-x" });
  const gate = (argv: string[]) => {
    const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
    return lendCreateDenied("agent-lend-x", { ...f, env: { [LEND_ORDER_ENV]: "o1" }, choice: { model: at("--model"), effort: at("--effort") } });
  };
  return { db, dir, args: () => lendModelArgs(db, "o1", f.lendPath), gate };
}

describe("[验收线 1][验收线 3] 合成 B：起 worker 的参数、闸口与启动事实", () => {
  beforeEach(() => rmSync(TIER_LEND_SETTINGS_PATH, { force: true }));

  test("Codex 降档建议：参数用建议、闸口放行、actual 报 suggest 且只记一条启动事实", () => {
    tierMode("on");
    const b = peerB("codex", { effort: "low", source: "default", ...tag() });
    const args = b.args();
    expect(args).toEqual(["--effort", "low"]);
    expect(b.gate(args)).toBeNull();
    expect(b.gate(["--effort", "high"])).toBe(CHOICE_CHANGED);
    expect(recordLendLaunch(b.db, "o1", "s1", ["create", "agent-lend-x", "/w", ...args])).toBeNull();
    const fact = JSON.parse(getMeta(b.db, "role-model-launch:o1")!);
    expect(fact).toMatchObject({ sessionId: "s1", actual: { model: null, effort: "low", source: "suggest" }, choice: { accepted: true, tier: "code" } });
  });

  test("Claude 降档建议：带 --model；security 低于 Opus 的建议 = 闸口拒起并给原因", () => {
    tierMode("on");
    const b = peerB("claude", { model: "claude-haiku-5-5", source: "default", ...tag() });
    expect(b.args()).toEqual(["--model", "claude-haiku-5-5"]);
    expect(b.gate(["--model", "claude-haiku-5-5"])).toBeNull();
    expect(launchActual("claude", { model: "claude-haiku-5-5", source: "default" }, ["--model", "claude-haiku-5-5"]).actual)
      .toEqual({ model: "claude-haiku-5-5", effort: null, source: "suggest" });
    const s = peerB("claude", { model: "claude-sonnet-5-5", source: "default", ...tag("security") });
    expect(s.args()).toEqual([]);
    expect(s.gate([])).toContain("不启动");
  });

  test("security 规格正文里出现别的模板示例也不影响：类型只看 A 给的 tier；Codex 授权没写档也拒起", () => {
    tierMode("on");
    const s = peerB("claude", { model: "claude-sonnet-5-5", source: "default", ...tag("security") }, `${material("security")}正文示例：\n模板:ui\n`);
    expect(s.gate([])).toContain("不启动");
    const { codexEffort: _drop, ...noEffort } = GRANT; // 授权里没写推理档
    const c = peerB("codex", { effort: "low", source: "default", ...tag("security") }, material("security"), noEffort as LendEntry);
    expect(c.args()).toEqual([]);
    expect(c.gate([])).toContain("不启动");
  });

  test("偏离原因随启动事实落下：高于授权的建议照授权起，reason 可追溯", () => {
    tierMode("on");
    const b = peerB("codex", { effort: "ultra", source: "default", ...tag() });
    const args = b.args();
    expect(args).toEqual(["--effort", "high"]);
    expect(recordLendLaunch(b.db, "o1", "s1", ["create", ...args])).toContain("不升档");
    expect(JSON.parse(getMeta(b.db, "role-model-launch:o1")!)).toMatchObject({ actual: { effort: "high", source: "grant" }, choice: { accepted: false } });
  });

  test("[验收线 4] B 本机恢复键 off / observe、开关关：参数与旧路径逐字一致，不写选择记录", () => {
    for (const [mode, setting] of [["off", true], ["observe", true], ["on", false]] as const) {
      tierMode(mode);
      writeFileSync(TIER_LEND_SETTINGS_PATH, JSON.stringify({ v: 1, acceptDowngrade: setting, rev: 1, updatedAt: 1, updatedBy: "owner" }));
      for (const fam of ["codex", "claude"] as const) {
        const b = peerB(fam, fam === "codex" ? { effort: "low", source: "default", ...tag("security") } : { model: "claude-haiku-5-5", source: "default", ...tag("security") });
        const args = b.args();
        expect(args).toEqual(fam === "codex" ? ["--effort", "high"] : []);
        expect(b.gate(args)).toBeNull();
        expect(getMeta(b.db, "tier-lend-choice:o1")).toBeNull();
        recordLendLaunch(b.db, "o1", "s1", ["create", ...args]);
        expect(Object.keys(JSON.parse(getMeta(b.db, "role-model-launch:o1")!))).toEqual(["sessionId", "actual"]);
      }
    }
  });

  test("旧 A（没给建议 / 给的是不带类型的旧形状建议）：恢复键 on 也走旧路径，security 正文也不改启动参数", () => {
    tierMode("on");
    for (const [fam, suggest, want] of [["codex", undefined, ["--effort", "high"]], ["codex", { effort: "low", source: "default" }, ["--effort", "high"]],
      ["claude", { model: "claude-sonnet-5-5", source: "default" }, []]] as const) {
      const b = peerB(fam, suggest as ModelSuggest | undefined, material("security"));
      expect(b.args()).toEqual([...want]);
      expect(b.gate([...want])).toBeNull();
      expect(getMeta(b.db, "tier-lend-choice:o1")).toBeNull();
    }
  });
});

// ── 合成 A：claim 的建议 ──

const roleRead = (author: { claude: string; codex: "high" | null }): RoleModelRead => {
  const t = defaultRoleModels();
  t.rev = 1; t.roles.author = author;
  return { status: "ok", table: t };
};
function ledgerA(template?: string): Database {
  const db = new Database(":memory:");
  if (template) {
    db.exec("CREATE TABLE task_workflows (taskId TEXT PRIMARY KEY, project TEXT, template TEXT, specRev INTEGER)");
    db.query("INSERT INTO task_workflows VALUES ('T1', 'p', ?, 1)").run(template);
  }
  return db;
}
const roleModelOn = (read: RoleModelRead, roleModel: RecoveryMode = "on"): RoleModelPort =>
  ({ policy: policyOf({ roleModel }) as RoleModelPort["policy"], read: () => read, observe: () => undefined });
const ORDER = { project: "p", taskId: "T1", step: "write", wire: { node: "write" } };

const TIER_CAPS = ["suggest", "tier"];

describe("[验收线 1] 合成 A：suggest 来自类型 × 角色有效值（只在协商了 tier 时）", () => {
  test("caps=tier + taskTierModels on：ui 作者的 Claude 建议是类型默认 Sonnet（不是角色格 Opus），suggest 里带类型与角色", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-opus-5-5", codex: "high" });
    const r = claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, TIER_CAPS, 1, roleModelOn(read));
    expect(r.suggest).toEqual({ model: "claude-sonnet-5-5", source: "default", tier: "ui", role: "author" });
    expect(r.note.suggestTier).toEqual({ tier: "ui", role: "author", source: "tier-default" });
    const cx = claimSuggest(ledgerA("ui"), { ...ORDER, family: "codex" }, TIER_CAPS, 1, roleModelOn(read));
    expect(cx.suggest).toEqual({ effort: "medium", source: "default", tier: "ui", role: "author" });
  });

  test("security：Claude 建议 Opus，Codex 沿用角色格原档；没有流程记录按 code；PM 审查节点按 pm-reviewer", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    expect(tierLendSuggest(ledgerA("security"), { taskId: "T1", family: "claude" }, "author", read))
      .toMatchObject({ suggest: { model: "claude-opus-5-5", tier: "security", role: "author" }, info: { tier: "security" } });
    expect(tierLendSuggest(ledgerA("security"), { taskId: "T1", family: "codex" }, "author", read))
      .toMatchObject({ suggest: { effort: "high", source: "settings" } });
    expect(tierLendSuggest(ledgerA(), { taskId: "T1", family: "claude" }, "author", read)).toMatchObject({ info: { tier: "code" } });
    const pm = claimSuggest(ledgerA("security"), { ...ORDER, step: "review", wire: { node: "pm_review" }, family: "claude" }, TIER_CAPS, 1, roleModelOn(read));
    expect(pm.suggest).toMatchObject({ model: "claude-opus-5-5", tier: "security", role: "pm-reviewer" });
  });

  test("[验收线 2] 旧 B（caps 只有 suggest）：taskTierModels on 也与旧角色格路径逐字一致，claim note 不多字段", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-opus-5-5", codex: "high" });
    const r = claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, ["suggest"], 1, roleModelOn(read));
    expect(r).toEqual({ suggest: { model: "claude-opus-5-5", source: "settings" }, note: { suggest: { model: "claude-opus-5-5", source: "settings" } } });
    // 旧路径照旧不认 PM 审查节点
    expect(claimSuggest(ledgerA("ui"), { ...ORDER, step: "review", wire: { node: "pm_review" }, family: "claude" }, ["suggest"], 1, roleModelOn(read))).toEqual({ suggest: null, note: {} });
  });

  test("[验收线 4] A 的 taskTierModels off / observe：带了 tier 也与旧角色格路径逐字一致", () => {
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    for (const mode of ["off", "observe"] as const) {
      tierMode(mode);
      const r = claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, TIER_CAPS, 1, roleModelOn(read));
      expect(r).toEqual({ suggest: { model: "claude-sonnet-5-5", source: "settings" }, note: { suggest: { model: "claude-sonnet-5-5", source: "settings" } } });
    }
  });

  test("[验收线 4] 旧 roleModel off / 对方不带 caps：taskTierModels on 也不给建议", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    expect(claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, TIER_CAPS, 1, roleModelOn(read, "off"))).toEqual({ suggest: null, note: {} });
    expect(claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, undefined, 1, roleModelOn(read))).toEqual({ suggest: null, note: {} });
  });
});

// ── 合成 A 的正式领单（ledger lend-offer / lend-claim，本机内存台账，对方是合成 peer「mate」）：三种兼容情形与改前逐字一致 ──

describe("[验收线 2][验收线 4] 旧 B / B 关 / A 关：领单材料、suggestDigest、claim 事件与改前逐字一致", () => {
  const P = "claude-orchestrator";
  const H = "a".repeat(40);
  const dir = mkdtempSync(join(tmpdir(), "tier-lend-claim-"));
  const spec = join(dir, "T9.md");
  writeFileSync(spec, "模板:security\n规格：只改 src/lib/x.ts\n");
  const CLAIM = { v: 1, orderId: "lend:T9:s1:r1:a0", worker: "agent-lend-0123456789" };
  const read = (): RoleModelRead => { const t = defaultRoleModels(); t.rev = 3; t.roles["adversarial-reviewer"].codex = "high"; return { status: "ok", table: t }; };

  /** 一本新台账：挂一张对抗审查单，按给定的 A 端 taskTierModels 与 B 带来的 caps 领单；返回对方收到的正文与本机 claim 事件 */
  async function claimWith(aTier: RecoveryMode, caps: string[] | null) {
    const db = openLedger(":memory:");
    try {
      tierMode(aTier);
      useRoleModelPort({ policy: () => ({ mode: "on", manualAfterMs: null, source: "config" }), read, observe: () => undefined });
      const deps = (actor: string) => ({ db, actor, projectIds: [P], loadRegistry: async () => ({ socket: "", agents: {} }) as unknown as Registry, saveRegistry: async () => {}, now: () => 1_000_000,
        lend: { borrow: async () => [{ peer: "mate", projects: [P], roles: ["review" as const], maxOpen: 2 }], notifyPm: async () => {} } });
      setLedgerMeta(db, { actor: "owner", now: 1_000_000 }, { project: P, key: "pms", value: ["agent-pm"] });
      createTask(db, { actor: "owner", now: 1_000_000 }, { project: P, id: "T9", title: "T9", kind: "code", spec });
      db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T9'`);
      await runLedger(["lend-offer", "T9", "--peer", "mate", "--repo", "shawnlu96/claudestra", "--pr", "12"], deps("agent-pm") as never);
      const req = JSON.stringify({ ...CLAIM, ...(caps ? { caps } : {}) });
      const { ok: _ok, notified: _n, ...body } = await runLedger(["lend-claim", "--", "mate", req], deps("owner") as never) as Record<string, unknown>;
      const claimEvents = listEvents(db, { project: P, target: "T9" }).filter((e) => (e.data.lend as { op?: string } | undefined)?.op === "claim").map((e) => e.data);
      return { body: JSON.stringify(body), events: JSON.stringify(claimEvents) };
    } finally {
      useRoleModelPort();
      closeLedger(":memory:");
    }
  }

  test("对照：改前路径（A 键 off、caps 只有 suggest）；三种兼容情形与它逐字相同，只有双方都开时才带类型", async () => {
    const before = await claimWith("off", ["suggest"]);
    expect(JSON.parse(before.body).suggest).toEqual({ effort: "high", source: "settings" });
    // 旧 B：只认 suggest（A 键 on 也不走类型）
    expect(await claimWith("on", ["suggest"])).toEqual(before);
    // B 关：B 的门关时 claimCaps 只带 suggest，A 收到的就是旧 B 那一份
    const bOff = claimCaps(openLendJournal(":memory:"), "a", 1, () => ({ on: true, acceptDowngrade: false }));
    expect(bOff).toEqual({ caps: ["suggest"] });
    expect(await claimWith("on", bOff.caps!)).toEqual(before);
    // A 关：B 带了 tier，A 键 off / observe = 旧路径
    expect(await claimWith("off", ["suggest", "tier"])).toEqual(before);
    expect(await claimWith("observe", ["suggest", "tier"])).toEqual(before);
    // 正对照：双方都开 = 建议带类型（security 卡首声明不改卡上流程：没开卡流程按 code），摘要随之不同
    const both = await claimWith("on", ["suggest", "tier"]);
    expect(JSON.parse(both.body).suggest).toMatchObject({ effort: "high", tier: "code", role: "adversarial-reviewer" });
    expect(JSON.parse(both.body).sha256).not.toBe(JSON.parse(before.body).sha256);
  });
});
