/**
 * TIER3c 自动升档：台账事实驱动下一轮作者经 TIER3 启动覆盖升一级（Claude Haiku→Sonnet→Opus、Codex 按 effort 表，不换家族）；
 * 重复 tick 只升一次、触顶只记、配置变化不回降；不碰当前会话，实际值证实才算已升档，旧档会话不冒充；基础档不可核实与安全拒绝不触发；
 * taskTierModels off 与未装升档逐字一致、不开库不记事件，历史保留、重新 on 接续；observe 只记 would-use。临时库，不调用真实模型。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCardRole } from "../src/lib/card-role-definitions.js";
import { closeLedger, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import type { RecoveryMode } from "../src/lib/recovery-policy.js";
import { useRoleModelPort } from "../src/lib/role-model-settings-local.js";
import { defaultRoleModels, type RoleModelRead } from "../src/lib/role-model-settings.js";
import { bindLaunchSession, recordLaunchAttempt } from "../src/lib/task-tier-launch-events.js";
import { decideTierLaunch, registerAuthorTierOverride, useTaskTierPort, type TierLaunchCtx } from "../src/lib/task-tier-models.js";
import { authorEscalationOverride, escalationStatus, escalationTick, installTaskTierEscalation, isStaleAuthorSession, useEscalationPort } from "../src/lib/task-tier-escalation.js";
import { cardState, closeEscalationStore, listNotes, openEscalationStore } from "../src/lib/task-tier-escalation-store.js";

const cleanups: (() => void)[] = [];
afterEach(() => { useTaskTierPort(); useRoleModelPort(); useEscalationPort(); registerAuthorTierOverride(null); for (const c of cleanups.splice(0)) c(); });

const table = (tiers?: Record<string, unknown>): RoleModelRead => {
  const t = defaultRoleModels();
  if (tiers) (t as { tiers?: unknown }).tiers = tiers;
  return { status: "ok", table: t };
};
function setup(mode: RecoveryMode = "on") {
  const dir = mkdtempSync(join(tmpdir(), "tier3c-")), ledgerPath = join(dir, "ledger.sqlite"), storePath = join(dir, "esc.sqlite");
  cleanups.push(() => { closeLedger(ledgerPath); closeEscalationStore(storePath); rmSync(dir, { recursive: true, force: true }); });
  const db = openLedger(ledgerPath);
  createTask(db, { actor: "owner" }, { id: "T1", project: "p1", title: "demo", kind: "code" });
  const s = { mode, read: table(), now: 5000, storeOpens: 0 };
  const policy = () => ({ mode: s.mode, manualAfterMs: null, source: "config" as const });
  useTaskTierPort({ policy, read: () => s.read });
  useRoleModelPort({ policy, read: () => s.read, observe: () => undefined });
  useEscalationPort({ store: () => (s.storeOpens++, openEscalationStore(storePath)), ledger: () => db, read: () => s.read, now: () => s.now });
  let ts = 100;
  const stage = (data: Record<string, unknown>) => insertEvent(db, { actor: "owner", now: ts++ }, { project: "p1", target: "T1", kind: "stage", text: "", data }, false);
  const fixReturn = (extra: Record<string, unknown> = {}) => stage({ from: "review", to: "fix", ...extra });
  return { db, s, storePath, stage, fixReturn, store: () => openEscalationStore(storePath) };
}
/** 两个本机作者入口都带 --effort high 作 Codex 原档 */
const ctx = (tier = "ui", family: "claude" | "codex" = "claude"): TierLaunchCtx => ({ project: "p1", card: "T1", tier, ...(family === "codex" ? { baseEffort: "high" } : {}) });
const pick = (family: "claude" | "codex" = "claude", tier = "ui") => {
  const d = decideTierLaunch(ctx(tier, family), "author", family, null, "a1");
  return d.mode === "on" && "value" in d ? d.value : d.mode === "on" ? `error:${d.error}` : d.mode;
};
const author = () => ["create", "a1", "/w", "--purpose", "T1 作者", "--task", "T1", "--card", "T1", "--card-role", "author", "--effort", "high", "--project", "p1"];

describe("[验收线 1] 两次失败 → 下一轮升一级", () => {
  test("两次 fix 退回：ui 作者 Sonnet → Opus（经 TIER3 启动覆盖，来源 override）", () => {
    const t = setup();
    installTaskTierEscalation();
    t.fixReturn();
    expect(pick()).toBe("claude-sonnet-5-5");
    t.fixReturn();
    expect(pick()).toBe("claude-opus-5-5");
    expect(decideTierLaunch(ctx(), "author", "claude", null, "a1")).toMatchObject({ plan: { source: "override" } });
    expect(pick("claude", "code")).toBe("claude-opus-5-5"); // code 作者本来就是 Opus：不覆盖
  });

  test("CI 连续两次终态失败升级；中间合入成功清连红，冲突与没链接的 CI 退回不计", () => {
    const t = setup();
    installTaskTierEscalation();
    const ci = (run: number | null) => t.stage({ from: "merge", to: "fix", mergeBounce: { cause: "ci_fail", checks: [{ name: "c", link: run ? `https://github.com/o/r/actions/runs/${run}` : "" }] } });
    ci(1); t.stage({ from: "merge", to: "live" }); ci(2);
    t.stage({ from: "merge", to: "fix", mergeBounce: { cause: "conflict", checks: [] } }); ci(null);
    expect(pick()).toBe("claude-sonnet-5-5");
    ci(3);
    expect(pick()).toBe("claude-opus-5-5");
  });

  test("Codex 按既有 effort 表升一级、不换家族：ui 作者 down1 的 medium → high", () => {
    const t = setup();
    installTaskTierEscalation();
    expect(pick("codex")).toBe("medium");
    t.fixReturn(); t.fixReturn();
    expect(pick("codex")).toBe("high");
  });
});

describe("[验收线 2] 只升一次、触顶、不回降", () => {
  test("重复 tick / 反复启动只升一次；再两次新失败升到触顶后只记触顶", () => {
    const t = setup();
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    for (let i = 0; i < 3; i++) { escalationTick("p1", "T1"); expect(pick("codex")).toBe("high"); }
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(1);
    t.fixReturn(); t.fixReturn();
    expect(pick()).toBe("claude-opus-5-5");
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(2);
    expect(listNotes(t.store(), "p1", "T1").map((n) => n.key)).toEqual(["topped:claude:2"]);
    t.fixReturn(); t.fixReturn();
    expect(pick()).toBe("claude-opus-5-5");
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(2); // 最近用过的家族已在最高档：只记触顶
  });

  test("配置把基础档调低：已升档的卡不回降", () => {
    const t = setup();
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    expect(pick()).toBe("claude-opus-5-5");
    t.s.read = table({ ui: { author: { claude: "claude-haiku-5-5" } } });
    expect(pick()).toBe("claude-opus-5-5");
  });
});

describe("[验收线 3] 当前会话不动、证实才算升档", () => {
  test("旧档会话不冒充；带新档启动但实际 unknown 只算 launched；实际值证实才 applied", () => {
    const t = setup();
    const old = decideTierLaunch(ctx(), "author", "claude", null, "a1");
    if (old.mode !== "on") throw new Error("on");
    recordLaunchAttempt(t.db, old.plan, 1000);
    bindLaunchSession(t.db, { project: "p1", card: "T1", role: "author", agent: "a1", sessionId: "old" }, 1001);
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    expect(escalationTick("p1", "T1")).toMatchObject({ mode: "on" });
    expect(isStaleAuthorSession("p1", "T1", "old")).toBe(false); // 还没发出新档：没有可比的
    const next = decideTierLaunch(ctx(), "author", "claude", null, "a2");
    if (next.mode !== "on" || !("value" in next)) throw new Error("on");
    expect(escalationStatus("p1", "T1")).toMatchObject({ steps: 1, state: "pending", plan: { value: "claude-opus-5-5" } });
    expect(isStaleAuthorSession("p1", "T1", "old")).toBe(true);
    recordLaunchAttempt(t.db, next.plan, 6000);
    bindLaunchSession(t.db, { project: "p1", card: "T1", role: "author", agent: "a2", sessionId: "new" }, 6001);
    escalationTick("p1", "T1");
    expect(escalationStatus("p1", "T1")).toMatchObject({ state: "launched", sessionId: "new" });
    expect(isStaleAuthorSession("p1", "T1", "new")).toBe(false);
    expect(isStaleAuthorSession("p1", "T1", "old")).toBe(true);
  });

  test("运行时证实实际值 = 新档 → applied", () => {
    const t = setup();
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    const next = decideTierLaunch(ctx(), "author", "claude", null, "a2");
    if (next.mode !== "on") throw new Error("on");
    recordLaunchAttempt(t.db, next.plan, 6000);
    bindLaunchSession(t.db, { project: "p1", card: "T1", role: "author", agent: "a2", sessionId: "new",
      actual: { model: "claude-opus-5-5", effort: null, source: "runtime" } as never }, 6001);
    escalationTick("p1", "T1");
    expect(escalationStatus("p1", "T1").state).toBe("applied");
  });

  test("基础档不可核实：记原因、不覆盖不猜；安全拒绝的退回不计", () => {
    const t = setup();
    t.s.read = table({ ui: { author: { claude: "claude-custom-9" } } });
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn({ cause: "provider_refusal" });
    expect(pick()).toBe("claude-custom-9");
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(0);
    t.fixReturn();
    expect(pick()).toBe("claude-custom-9");
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(1);
    expect(listNotes(t.store(), "p1", "T1").map((n) => n.key)).toEqual(["unknown:claude:claude-custom-9"]);
    expect(escalationStatus("p1", "T1").state).toBe("none");
  });
});

describe("[验收线 4] taskTierModels 门控", () => {
  test("off：与未装升档逐字一致，不开库、不记事件、不消费证据；历史保留，重新 on 接续", () => {
    const t = setup();
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    expect(pick("codex")).toBe("high");
    t.s.mode = "off";
    t.fixReturn(); t.fixReturn();
    const opens = t.s.storeOpens, events = listEvents(t.db, { project: "p1" }).length;
    const withEsc = applyCardRole(author(), { tier: ctx() });
    registerAuthorTierOverride(null);
    expect(applyCardRole(author(), { tier: ctx() })).toEqual(withEsc);
    installTaskTierEscalation();
    expect(escalationTick("p1", "T1")).toEqual({ mode: "off" });
    expect(authorEscalationOverride({ project: "p1", card: "T1", tier: "ui", family: "claude" })).toBeNull();
    expect(t.s.storeOpens).toBe(opens);
    expect(listEvents(t.db, { project: "p1" }).length).toBe(events);
    expect(cardState(t.store(), "p1", "T1")).toEqual({ fix: 0, ci: 0, steps: 1 });
    t.s.mode = "on";
    expect(escalationTick("p1", "T1")).toMatchObject({ mode: "on", added: 2 });
    expect(cardState(t.store(), "p1", "T1")?.steps).toBe(2);
    expect(pick("codex")).toBe("xhigh");
  });

  test("off 从未开过：库文件都不建", () => {
    const t = setup("off");
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    expect(escalationTick("p1", "T1")).toEqual({ mode: "off" });
    expect(t.s.storeOpens).toBe(0);
    expect(existsSync(t.storePath)).toBe(false);
  });

  test("observe：只记一条 would-use（重复 tick 不重记），启动参数不变、库不变", () => {
    const t = setup("observe");
    installTaskTierEscalation();
    t.fixReturn(); t.fixReturn();
    for (let i = 0; i < 3; i++) expect(escalationTick("p1", "T1")).toMatchObject({ mode: "observe", grants: [{ n: 1 }] });
    expect(pick()).toBe("observe");
    expect(cardState(t.store(), "p1", "T1")).toBeNull();
    const notes = listEvents(t.db, { project: "p1", target: "T1" }).filter((e) => String(e.data.actionKey).startsWith("task-tier-escalate:"));
    expect(notes.length).toBe(1);
  });
});
