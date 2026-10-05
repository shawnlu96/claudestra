/**
 * dispatch-recovery-MANUAL, pure side: the policy port (missing = observe, broken = off, the wide CFG signature fits), and
 * decideManual — waiting classes and a null threshold are never a stall, the hand-back needs every proof plus open switches,
 * the card is addressed by class (provider refusal → owner, never an approval), and one state version + evidence = one fingerprint.
 */
import { describe, expect, test } from "bun:test";
import {
  actionCardText, decideManual, isWaiting, manualStallPolicy, manualStallRetryAfter, type ManualClass, type ManualFacts, type RecoveryPolicy,
} from "../src/lib/recovery-manual.js";

const MIN = 60_000, NOW = 10 * 3600_000;
const ON: RecoveryPolicy = { mode: "on", manualAfterMs: 30 * MIN };

const facts = (over: Partial<ManualFacts> = {}): ManualFacts => ({
  project: "p", taskId: "t1", stage: "build", agent: "agent-x", taskRev: 3, workflowRev: 2, lastSeq: 40, lastTs: NOW - 2 * 3600_000, lastActor: "pm-a",
  cls: "pm_takeover", why: "转人工：worker 会话丢了", origin: { seq: 38, op: "workflow", reason: "worker 会话丢了" }, unknownIntents: [],
  resume: { ok: false, why: "workflow 不是 manual" }, block: null, ...over,
});
const card = (d: ReturnType<typeof decideManual>) => {
  if (d.kind !== "card") throw new Error(`expected card, got ${JSON.stringify(d)}`);
  return d.card;
};

describe("policy port", () => {
  test("missing port observes with no threshold; throwing or garbage is off with a diagnostic", () => {
    expect(manualStallPolicy(undefined, "p")).toMatchObject({ mode: "observe", manualAfterMs: null, diag: expect.stringContaining("CFG") });
    expect(manualStallPolicy(() => { throw new Error("cfg 坏"); }, "p")).toMatchObject({ mode: "off", diag: expect.stringContaining("cfg 坏") });
    expect(manualStallPolicy(() => ({ mode: "yes" }) as unknown as RecoveryPolicy, "p")).toMatchObject({ mode: "off" });
    expect(manualStallPolicy(() => ({ mode: "on", manualAfterMs: Number.NaN }), "p")).toMatchObject({ mode: "off" });
    expect(manualStallPolicy(() => ({ mode: "on", manualAfterMs: -1 }), "p")).toMatchObject({ mode: "off" });
    expect(manualStallPolicy(() => null as unknown as RecoveryPolicy, "p")).toMatchObject({ mode: "off" });
  });

  test("CFG's wide recoveryPolicy(project, mechanism) is assignable and asked for manualStall only", () => {
    const asked: string[] = [];
    const cfg = (project: string, mechanism: "planGap" | "manualStall" | "audit"): RecoveryPolicy => (asked.push(`${project}:${mechanism}`), { mode: "on", manualAfterMs: 0 });
    expect(manualStallPolicy(cfg, "p")).toEqual({ mode: "on", manualAfterMs: 0, diag: null });
    expect(asked).toEqual(["p:manualStall"]);
  });
});

describe("decideManual", () => {
  test("waiting classes are never stalled, however long they sit", () => {
    for (const cls of ["frozen", "held", "approval_wait", "external_wait", "deps_wait"] as ManualClass[]) {
      expect(isWaiting(cls)).toBe(true);
      expect(decideManual(facts({ cls, lastTs: 0 }), ON, NOW)).toMatchObject({ kind: "wait" });
    }
  });

  test("a null threshold only observes: no private default hours", () => {
    expect(decideManual(facts({ lastTs: 0 }), { mode: "on", manualAfterMs: null }, NOW)).toMatchObject({ kind: "fresh", why: expect.stringContaining("未设") });
  });

  test("below the threshold is fresh; at it the card is prepared", () => {
    expect(decideManual(facts({ lastTs: NOW - 29 * MIN }), ON, NOW)).toMatchObject({ kind: "fresh" });
    expect(decideManual(facts({ lastTs: NOW - 30 * MIN }), ON, NOW)).toMatchObject({ kind: "card" });
  });

  test("PM takeover → PM card with the formal workflow-resume command carrying this version's revs", () => {
    const c = card(decideManual(facts(), ON, NOW));
    expect(c).toMatchObject({ audience: "pm", cls: "pm_takeover", version: "t3:w2:e40", stage: "build", agent: "agent-x" });
    expect(c.command).toBe("ledger workflow-resume t1 --rev 3 --workflow-rev 2 --reason <核对结论>");
    expect(c.evidence.join("\n")).toContain("转人工事件 #38");
    const text = actionCardText(c);
    expect(text).toContain("下一步：");
    expect(text).toContain(c.fingerprint);
  });

  test("provider refusal → owner card with no command and no approval; never a hand-back", () => {
    const c = card(decideManual(facts({ cls: "provider_refusal", why: "模型安全拒绝留证 #39 未处置" }), ON, NOW));
    expect(c).toMatchObject({ audience: "owner", command: null });
    expect(c.step).toContain("须 owner 自己批准");
    expect(c.step).toContain("不代批");
  });

  test("merge revoked: never handed back here; still manual past N with every proof → PM card with the formal resume command", () => {
    const ok = { ok: true as const, facts: { trigger: 30, deliver: 39, head: "b".repeat(40), revoked: "a".repeat(40) } };
    const f = facts({ cls: "merge_revoked", resume: ok });
    const stuck = card(decideManual(f, ON, NOW));
    expect(stuck).toMatchObject({ audience: "pm", command: expect.stringContaining("ledger workflow-resume t1 --rev 3") });
    expect(stuck.step).toContain("既有自动交回（scheduler-auto-resume）没有交回成功");
    expect(card(decideManual({ ...f, block: "调度服务没对项目 p 开自动派单" }, ON, NOW)).step).toContain("开关不允许");
    const unknown = card(decideManual({ ...f, unknownIntents: ["i9"] }, ON, NOW));
    expect(unknown.step).toContain("先对账结果不明的意图 i9");
    const waiting = card(decideManual(facts({ cls: "merge_revoked", resume: { ok: false, why: "撤销后还没有交付" } }), ON, NOW));
    expect(waiting.step).toContain("催 agent-x 在 build 交付新 head");
  });

  test("unknown origin is never handed back", () => {
    const c = card(decideManual(facts({ cls: "unknown_origin", origin: null }), ON, NOW));
    expect(c).toMatchObject({ audience: "pm", command: null });
    expect(c.step).toContain("不自动交回");
  });

  test("fingerprint: same version + evidence is stable as time passes; a new event or new evidence changes it", () => {
    const a = card(decideManual(facts(), ON, NOW)), later = card(decideManual(facts(), ON, NOW + 3600_000));
    expect(later.fingerprint).toBe(a.fingerprint);
    expect(card(decideManual(facts({ lastSeq: 41 }), ON, NOW)).fingerprint).not.toBe(a.fingerprint);
    expect(card(decideManual(facts({ unknownIntents: ["i2"] }), ON, NOW)).fingerprint).not.toBe(a.fingerprint);
  });

  test("retry backoff doubles from 5 min, capped at 6 h", () => {
    expect(manualStallRetryAfter(1)).toBe(5 * MIN);
    expect(manualStallRetryAfter(2)).toBe(10 * MIN);
    expect(manualStallRetryAfter(30)).toBe(6 * 3600_000);
  });
});
