/**
 * dispatch-recovery-AUD 的规则侧（ledger-audit.ts recoveryAudit）：恢复事实由快照给（这里手写），规则只管开关、去重和首轮基线。
 * on 满阈值才推；observe 只落库不推；off / 读不了不评估、旧发现留着不推；两把开关（audit 与机制自己的键）取保守的；
 * 已推过又关掉的同一状态不重开；没建基线时不让首轮静默吞掉提醒。真实取数与 CLI 在 tests/recovery-audit-integration.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { auditLedger, type RecoveryAuditInputs, type RecoveryCandidate } from "../src/lib/ledger-audit.js";
import type { RecoveryMode, RecoveryPolicy, RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const P = "proj", PM = "agent-pm", DISP = "agent-dispatch", NOW = 10_000_000;
type Recovery = NonNullable<RecoveryAuditInputs["recovery"]>;
type Store = NonNullable<Recovery["store"]>;

const card = (over: Partial<RecoveryCandidate> = {}): RecoveryCandidate =>
  ({ keyParts: ["T1", "t3:w2:e9", "fp1"], taskId: "T1", since: NOW - 1000, due: true, detail: "manual 停滞", suggestion: "PM 推进", ...over });
const gap = (over: Partial<RecoveryCandidate> = {}): RecoveryCandidate =>
  ({ keyParts: ["gapfp"], taskId: null, since: NOW - 1000, due: true, detail: "【计划不足】", suggestion: "补规格", ...over });
const store = (over: Partial<Store> = {}): Store => ({ baseline: ["recovery_manual_stalled", "recovery_plan_gap"], open: [], told: [], ...over });
const policy = (modes: Partial<Record<string, RecoveryMode>> = {}, fallback: RecoveryMode = "on"): RecoveryPolicyPort =>
  (_project, key) => ({ mode: modes[key] ?? fallback, manualAfterMs: 1, source: "config" }) as RecoveryPolicy;

function run(recovery: Recovery | undefined, port: RecoveryPolicyPort = policy()) {
  const r = auditLedger({ project: P, pms: [DISP, PM], tasks: [], agents: [], reviewers: [], held: [], ownerInbox: [], recovery }, NOW, port);
  const mine = (rule: string) => rule.startsWith("recovery_");
  return { found: r.findings.filter((f) => mine(f.rule)), evaluated: r.evaluated.filter(mine), skipped: r.skipped.filter((s) => mine(s.rule)),
    keep: r.keep.filter((k) => k.includes("|recovery_")) };
}
const facts = (manual: Recovery["facts"]["recovery_manual_stalled"], plan: Recovery["facts"]["recovery_plan_gap"] = { found: [] }, s: Store | null = store()): Recovery =>
  ({ store: s, facts: { recovery_manual_stalled: manual, recovery_plan_gap: plan } });
const KEY = `${P}|recovery_manual_stalled|T1|t3:w2:e9|fp1`, GAP = `${P}|recovery_plan_gap|gapfp`;

describe("开关", () => {
  test("没取恢复事实：两条规则不跑也不列（旧快照、单测默认）", () => {
    expect(run(undefined)).toEqual({ found: [], evaluated: [], skipped: [], keep: [] });
  });

  test("on：满阈值的出发现，推给 PM（不是调度助理），不 keep", () => {
    const r = run(facts({ found: [card()] }, { found: [gap()] }));
    expect(r.found.map((f) => [f.key, f.notify, f.taskId])).toEqual([[KEY, PM, "T1"], [GAP, PM, null]]);
    expect(r.evaluated).toEqual(["recovery_manual_stalled", "recovery_plan_gap"]);
    expect([r.keep, r.skipped]).toEqual([[], []]);
  });

  test("observe：落库但 keep 住不推，skipped 列稳定的「观察中:」", () => {
    const r = run(facts({ found: [card()] }), policy({ manualStall: "observe" }));
    expect(r.found.map((f) => f.key)).toEqual([KEY]);
    expect(r.keep).toEqual([KEY]);
    expect(r.skipped).toEqual([{ rule: "recovery_manual_stalled", reason: "观察中:T1|t3:w2:e9|fp1 已满阈值，observe 不推" }]);
    expect(r.evaluated).toContain("recovery_manual_stalled");
  });

  test("总开关 audit 与机制键取保守的：任一 off 就不评估，开着的旧发现留着不推", () => {
    const open = [{ key: KEY, rule: "recovery_manual_stalled", firstSeen: 1, told: false }];
    for (const port of [policy({ audit: "off" }), policy({ manualStall: "off" })]) {
      const r = run(facts({ found: [card()] }, { found: [] }, store({ open })), port);
      expect(r.found).toEqual([]);
      expect(r.keep).toEqual([KEY]);
      expect(r.evaluated).not.toContain("recovery_manual_stalled");
      expect(r.skipped.find((s) => s.rule === "recovery_manual_stalled")?.reason).toContain("为 off 或读不了");
    }
    expect(run(facts({ found: [card()] }), policy({ audit: "observe" })).keep).toEqual([KEY]); // audit observe + 机制 on = observe
  });

  test("策略抛错、返回错误来源或不认识的值：按 off", () => {
    const broken: RecoveryPolicyPort[] = [
      () => { throw new Error("cfg 坏了"); },
      () => ({ mode: "off", manualAfterMs: null, source: "error", diagnostic: "文件坏了" }),
      () => ({ mode: "ON", manualAfterMs: null, source: "config" }) as unknown as RecoveryPolicy,
    ];
    for (const port of broken) {
      const r = run(facts({ found: [card()] }, { found: [gap()] }), port);
      expect([r.found, r.evaluated]).toEqual([[], []]);
      expect(r.skipped.map((s) => s.rule)).toEqual(["recovery_manual_stalled", "recovery_plan_gap"]);
    }
  });
});

describe("取不到数", () => {
  test("某个机制读不了：只跳过它并留住旧发现，另一条照常评估", () => {
    const open = [{ key: KEY, rule: "recovery_manual_stalled", firstSeen: 1, told: true }];
    const r = run(facts({ unread: "manual 停滞事实读不了" }, { found: [gap()] }, store({ open })));
    expect(r.keep).toEqual([KEY]);
    expect(r.skipped).toEqual([{ rule: "recovery_manual_stalled", reason: "manual 停滞事实读不了" }]);
    expect(r.evaluated).toEqual(["recovery_plan_gap"]);
    expect(r.found.map((f) => f.key)).toEqual([GAP]);
  });

  test("巡检库读不了：两条都不评估（不评估就不会关掉旧发现）", () => {
    const r = run(facts({ found: [card()] }, { found: [gap()] }, null));
    expect([r.found, r.evaluated]).toEqual([[], []]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["巡检库的基线 / 旧发现读不了", "巡检库的基线 / 旧发现读不了"]);
  });

  test("owner 没设阈值：快照只给一句说明，规则列进「观察中:」，不出发现", () => {
    const r = run(facts({ found: [], note: "owner 未设 manualStallHours：2 张非等待类 manual 卡只观察、不判停滞" }));
    expect(r.found).toEqual([]);
    expect(r.skipped).toEqual([{ rule: "recovery_manual_stalled", reason: "观察中:owner 未设 manualStallHours：2 张非等待类 manual 卡只观察、不判停滞" }]);
    expect(r.evaluated).toContain("recovery_manual_stalled");
  });
});

describe("阈值与去重", () => {
  test("计划不足没满阈值：on 也只落库计时（keep 住不推）", () => {
    const r = run(facts({ found: [] }, { found: [gap({ due: false })] }));
    expect(r.found.map((f) => f.key)).toEqual([GAP]);
    expect(r.keep).toEqual([GAP]);
    expect(r.skipped).toEqual([{ rule: "recovery_plan_gap", reason: "观察中:gapfp 未满阈值，只计时" }]);
  });

  test("已推过又关掉的同一状态不再出（不重开重推）；状态变了是新 key，照常出", () => {
    const told = store({ told: [KEY] });
    expect(run(facts({ found: [card()] }, { found: [] }, told)).found).toEqual([]);
    const next = run(facts({ found: [card({ keyParts: ["T1", "t3:w2:e12", "fp2"] })] }, { found: [] }, told));
    expect(next.found.map((f) => f.key)).toEqual([`${P}|recovery_manual_stalled|T1|t3:w2:e12|fp2`]);
  });
});

describe("首轮不吞提醒（规则还没建基线）", () => {
  const fresh = (over: Partial<Store> = {}) => store({ baseline: [], ...over });

  test("on 且有没推过的发现：照出但不进 evaluated（不建基线、不被静默），别的旧发现 keep 住", () => {
    const stale = `${P}|recovery_manual_stalled|T9|t1:w1:e1|old`;
    const open = [{ key: stale, rule: "recovery_manual_stalled", firstSeen: 1, told: false }];
    const r = run(facts({ found: [card()] }, { found: [] }, fresh({ open })));
    expect(r.found.map((f) => f.key)).toEqual([KEY]);
    expect(r.evaluated).toEqual(["recovery_plan_gap"]);
    expect(r.keep).toEqual([stale]);
  });

  test("这轮的发现都已推过（或一条没有）：才进 evaluated 建基线", () => {
    const open = [{ key: KEY, rule: "recovery_manual_stalled", firstSeen: 1, told: true }];
    expect(run(facts({ found: [card()] }, { found: [] }, fresh({ open }))).evaluated).toContain("recovery_manual_stalled");
    expect(run(facts({ found: [] }, { found: [] }, fresh())).evaluated).toEqual(["recovery_manual_stalled", "recovery_plan_gap"]);
  });

  test("observe 在基线建好前不落库：否则首轮静默会把它记成已推，改成 on 后再也推不出来", () => {
    const r = run(facts({ found: [card()] }, { found: [] }, fresh()), policy({ manualStall: "observe" }));
    expect([r.found, r.keep]).toEqual([[], []]);
    expect(r.evaluated).toContain("recovery_manual_stalled");
    expect(r.skipped.map((s) => s.reason)).toEqual(["观察中:T1|t3:w2:e9|fp1 已满阈值，observe 不推"]);
  });

  test("没满阈值的计时行也算没推过：基线等它推完再建", () => {
    const r = run(facts({ found: [] }, { found: [gap({ due: false })] }, fresh()));
    expect(r.found.map((f) => f.key)).toEqual([GAP]);
    expect(r.keep).toEqual([GAP]);
    expect(r.evaluated).toEqual(["recovery_manual_stalled"]);
  });
});
