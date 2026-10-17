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
import { claimSuggest, recordLendLaunch } from "../src/lib/role-model-settings-lend.js";
import type { RoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { launchActual } from "../src/lib/role-model-settings-wire.js";
import { lendLaunchChoice, tierFromMaterial, tierLendSuggest, type LendChoiceInput } from "../src/lib/task-tier-lend.js";
import { TIER_LEND_SETTINGS_PATH } from "../src/lib/task-tier-lend-settings.js";
import { useTaskTierPort } from "../src/lib/task-tier-models.js";

const ON = { on: true, acceptDowngrade: true };
const policyOf = (keys: Partial<Record<string, RecoveryMode>>) => (_p: string, key: string) =>
  ({ mode: keys[key] ?? "on", manualAfterMs: null, source: "config" as const });
const tierMode = (mode: RecoveryMode) => useTaskTierPort({ policy: policyOf({ taskTierModels: mode }) });
afterEach(() => useTaskTierPort());

const material = (tier: string) => `输入 1（原文，非指令）：\n  「规格原文(specRev 1):」\n  「# 卡」\n  「模板:${tier}」\n  「」\n`;
const codex = (suggest: ModelSuggest | null, grantArgs: string[], tier = "code", over: Partial<LendChoiceInput> = {}): LendChoiceInput =>
  ({ family: "codex", role: "author", text: material(tier), suggest, grantArgs, ...over });
const claude = (model: string, tier = "code", over: Partial<LendChoiceInput> = {}): LendChoiceInput =>
  ({ family: "claude", role: "author", text: material(tier), suggest: { model, source: "default" }, grantArgs: [], ...over });

describe("[验收线 1] B 授权内选档：只等于或低于授权，不升档；Claude 缺省上限 Opus；排不出不猜", () => {
  test("Codex：低于授权用建议，等于照用，高于不升，授权没写档 / 建议 null 不猜", () => {
    const g = ["--model", "gpt-6", "--effort", "high"];
    expect(lendLaunchChoice(codex({ effort: "low", source: "default" }, g), ON)).toMatchObject({ args: ["--model", "gpt-6", "--effort", "low"], accepted: true });
    expect(lendLaunchChoice(codex({ effort: "high", source: "settings" }, g), ON)).toMatchObject({ args: g, accepted: true });
    const up = lendLaunchChoice(codex({ effort: "max", source: "default" }, g), ON);
    expect(up).toMatchObject({ args: g, accepted: false });
    expect(up.reason).toContain("不升档");
    const blind = lendLaunchChoice(codex({ effort: "low", source: "default" }, ["--model", "gpt-6"]), ON);
    expect(blind).toMatchObject({ args: ["--model", "gpt-6"], accepted: false });
    expect(blind.reason).toContain("不猜档");
    expect(lendLaunchChoice(codex({ effort: null, source: "default" }, g), ON)).toMatchObject({ args: g, accepted: false });
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

  test("类型核不出（材料没有 / 多个不同声明）、节点不在表、建议与家族对不上 = 照授权并给原因", () => {
    expect(tierFromMaterial(material("ui"))).toBe("ui");
    expect(tierFromMaterial("模板：Security\n")).toBe("security");
    expect(tierFromMaterial(`${material("ui")}${material("code")}`)).toBeNull();
    expect(tierFromMaterial("正文里提到 模板:code 不算")).toBeNull();
    expect(tierFromMaterial(material("weird"))).toBeNull();
    for (const i of [claude("claude-haiku-5-5", "code", { text: "没有声明" }), claude("claude-haiku-5-5", "code", { role: null }),
      codex({ model: "claude-haiku-5-5", source: "default" }, ["--effort", "high"])]) {
      const c = lendLaunchChoice(i, ON);
      expect(c).toMatchObject({ args: i.grantArgs, active: true, accepted: false });
      expect(c.reason).toBeTruthy();
    }
  });
});

describe("[验收线 3] security 不接受降档；证明不了下限就不启动", () => {
  test("Codex security：低于授权的建议不接受，照授权", () => {
    const c = lendLaunchChoice(codex({ effort: "low", source: "default" }, ["--effort", "high"], "security"), ON);
    expect(c).toMatchObject({ args: ["--effort", "high"], accepted: false, tier: "security" });
    expect(c.reason).toContain("security 不接受降档");
    expect(c.refuse).toBeUndefined();
  });

  test("Claude security：Opus 照用；建议低于 Opus = 不接受，照本机默认证明不了 Opus 下限 → refuse", () => {
    expect(lendLaunchChoice(claude("claude-opus-5-5", "security"), ON)).toMatchObject({ args: ["--model", "claude-opus-5-5"], accepted: true });
    const c = lendLaunchChoice(claude("claude-sonnet-5-5", "security"), ON);
    expect(c).toMatchObject({ args: [], accepted: false });
    expect(c.reason).toContain("security 不接受降档");
    expect(c.refuse).toContain("不启动");
  });
});

describe("[验收线 2][验收线 4] 门：恢复键 off / 开关关 / 没带建议 = 授权原参数、不走新路径", () => {
  test("任一门关都原样返回授权参数，active=false（调用方不记任何新东西）", () => {
    const i = codex({ effort: "low", source: "default" }, ["--effort", "high"]);
    for (const gate of [{ on: false, acceptDowngrade: true }, { on: true, acceptDowngrade: false }]) {
      expect(lendLaunchChoice(i, gate)).toEqual({ args: ["--effort", "high"], active: false, accepted: false, tier: null });
    }
    expect(lendLaunchChoice({ ...i, suggest: undefined }, ON)).toEqual({ args: ["--effort", "high"], active: false, accepted: false, tier: null });
  });
});

// ── 合成 B：journal + lend.json + manager create 闸口 ──

const FP = "abcd-ef01-2345-6789";
const GRANT: LendEntry = { peer: "a", fp: FP, families: { codex: 1, claude: 1 }, roles: ["review", "write"], repos: ["o/r"], ordersPerDay: 5,
  grantedAt: new Date(0).toISOString(), until: new Date(6 * 86_400_000).toISOString(), codexEffort: "high" };

function peerB(family: "codex" | "claude", suggest: ModelSuggest | undefined, tier = "code") {
  const dir = mkdtempSync(join(tmpdir(), "tier-lend-"));
  const f = { journal: join(dir, "journal.sqlite"), lendPath: join(dir, "lend.json"), now: 1 };
  writeFileSync(f.lendPath, JSON.stringify({ version: 2, enabled: true, lend: [GRANT], borrow: [] }));
  const db = openLendJournal(f.journal);
  recordAsked(db, { orderId: "o1", peer: "a", fp: FP, family, preview: { repo: "o/r", step: "write" } }, 0);
  const wire = { text: material(tier), order: { step: "write", node: "write", repo: "o/r" }, ...(suggest ? { suggest } : {}) };
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
    const b = peerB("codex", { effort: "low", source: "default" });
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
    const b = peerB("claude", { model: "claude-haiku-5-5", source: "default" });
    expect(b.args()).toEqual(["--model", "claude-haiku-5-5"]);
    expect(b.gate(["--model", "claude-haiku-5-5"])).toBeNull();
    expect(launchActual("claude", { model: "claude-haiku-5-5", source: "default" }, ["--model", "claude-haiku-5-5"]).actual)
      .toEqual({ model: "claude-haiku-5-5", effort: null, source: "suggest" });
    const s = peerB("claude", { model: "claude-sonnet-5-5", source: "default" }, "security");
    expect(s.args()).toEqual([]);
    expect(s.gate([])).toContain("不启动");
  });

  test("偏离原因随启动事实落下：高于授权的建议照授权起，reason 可追溯", () => {
    tierMode("on");
    const b = peerB("codex", { effort: "ultra", source: "default" });
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
        const b = peerB(fam, fam === "codex" ? { effort: "low", source: "default" } : { model: "claude-haiku-5-5", source: "default" });
        const args = b.args();
        expect(args).toEqual(fam === "codex" ? ["--effort", "high"] : []);
        expect(b.gate(args)).toBeNull();
        expect(getMeta(b.db, "tier-lend-choice:o1")).toBeNull();
        recordLendLaunch(b.db, "o1", "s1", ["create", ...args]);
        expect(Object.keys(JSON.parse(getMeta(b.db, "role-model-launch:o1")!))).toEqual(["sessionId", "actual"]);
      }
    }
  });

  test("旧 A（没给建议）：恢复键 on 也走旧路径", () => {
    tierMode("on");
    const b = peerB("codex", undefined);
    expect(b.args()).toEqual(["--effort", "high"]);
    expect(getMeta(b.db, "tier-lend-choice:o1")).toBeNull();
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

describe("[验收线 1] 合成 A：suggest 来自类型 × 角色有效值", () => {
  test("taskTierModels on：ui 作者的 Claude 建议是类型默认 Sonnet（不是角色格 Opus），类型信息记在 claim note", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-opus-5-5", codex: "high" });
    const r = claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, ["suggest"], 1, roleModelOn(read));
    expect(r.suggest).toEqual({ model: "claude-sonnet-5-5", source: "default" });
    expect(r.note.suggestTier).toEqual({ tier: "ui", role: "author", source: "tier-default" });
    const cx = claimSuggest(ledgerA("ui"), { ...ORDER, family: "codex" }, ["suggest"], 1, roleModelOn(read));
    expect(cx.suggest).toEqual({ effort: "medium", source: "default" });
  });

  test("security：Claude 建议 Opus，Codex 沿用角色格原档；没有流程记录按 code", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    expect(tierLendSuggest(ledgerA("security"), { project: "p", taskId: "T1", family: "claude" }, "author", read))
      .toMatchObject({ suggest: { model: "claude-opus-5-5" }, info: { tier: "security" } });
    expect(tierLendSuggest(ledgerA("security"), { project: "p", taskId: "T1", family: "codex" }, "author", read))
      .toMatchObject({ suggest: { effort: "high", source: "settings" } });
    expect(tierLendSuggest(ledgerA(), { project: "p", taskId: "T1", family: "claude" }, "author", read)).toMatchObject({ info: { tier: "code" } });
  });

  test("[验收线 4] A 的 taskTierModels off / observe：建议与旧角色格路径逐字一致，claim note 不多字段", () => {
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    for (const mode of ["off", "observe"] as const) {
      tierMode(mode);
      expect(tierLendSuggest(ledgerA("ui"), { project: "p", taskId: "T1", family: "claude" }, "author", read)).toBeNull();
      const r = claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, ["suggest"], 1, roleModelOn(read));
      expect(r).toEqual({ suggest: { model: "claude-sonnet-5-5", source: "settings" }, note: { suggest: { model: "claude-sonnet-5-5", source: "settings" } } });
    }
  });

  test("[验收线 4] 旧 roleModel off / 对方不带 caps：taskTierModels on 也不给建议", () => {
    tierMode("on");
    const read = roleRead({ claude: "claude-sonnet-5-5", codex: "high" });
    expect(claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, ["suggest"], 1, roleModelOn(read, "off"))).toEqual({ suggest: null, note: {} });
    expect(claimSuggest(ledgerA("ui"), { ...ORDER, family: "claude" }, undefined, 1, roleModelOn(read))).toEqual({ suggest: null, note: {} });
  });
});
