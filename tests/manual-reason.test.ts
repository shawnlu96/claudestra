/** dispatch-recovery-MAN1 manual-reason (pure side): parsing, the fixed classification of existing callers' texts, read-only diagnosis. */
import { describe, expect, test } from "bun:test";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { diagnoseManual, manualEntry, manualResumeMode, MANUAL_REASON_CODES, parseManualReason, type ManualReasonRecord } from "../src/lib/manual-reason.js";

describe("parseManualReason", () => {
  test("explicit code with release / event fields; every listed code parses", () => {
    expect(parseManualReason("deps_not_live: T0 还没上线；解除：T0 live；事件：#12")).toEqual({
      code: "deps_not_live", text: "T0 还没上线", release: "T0 live", eventSeq: 12, explicit: true });
    for (const c of MANUAL_REASON_CODES) expect(parseManualReason(`${c}：说明`)?.code).toBe(c);
  });

  test("the spec's minimum set is all distinct codes", () => {
    const need = ["safety_refusal", "materials_gate", "questionnaire", "review_source_missing", "merge_unknown", "write_lease_ended", "deps_not_live",
      "owner_hold", "ui_evidence_stale"];
    expect(need.filter((c) => !(MANUAL_REASON_CODES as readonly string[]).includes(c))).toEqual([]);
  });

  test("missing, empty and unrecognised reasons are null (the writer refuses them)", () => {
    for (const r of [undefined, null, "", "   ", "x", "随便", "safety_refusal:", "deps_not_live：；解除：x", "foo: bar"]) expect(parseManualReason(r)).toBeNull();
  });

  test("an explicit unknown code is null even when the text has table keywords; inherited names are not codes", () => {
    for (const r of ["bogus_code: owner 等待", "xyz：依赖 T0", "nope: PM 接管", "constructor: 依赖", "toString：owner"]) expect(parseManualReason(r)).toBeNull();
    expect(parseManualReason("owner 等待")?.code).toBe("owner_hold"); // no code head: the existing callers' sentence table still applies
  });

  test("planner escalations `<code>：<reason>` map through the fixed table", () => {
    const cases: [string, string][] = [
      ["model_safety_hold：本卡有未处置的模型安全拒绝", "safety_refusal"],
      ["merge_retry_requires_pm：合并意图 i1 已取消，先由 PM 核对外部结果", "merge_unknown"],
      ["merge_review_unproven：合并前缺本轮跨模型审查 session 与派单回执", "review_source_missing"],
      ["review_unsolicited：审查结论找不到本轮、同 head 与 session 的派单回执", "review_source_missing"],
      ["ui_stale：截图许可绑定的 head/specRev 已过期", "ui_evidence_stale"],
      ["placement_lease：写租约已结束", "write_lease_ended"],
      ["pool_order_open：池单 o1 仍在对方手里或待领，先对账", "write_lease_ended"],
      ["file_scope：自动卡缺明确的文件范围 glob", "materials_gate"],
      ["review_round_cap：三轮仍有 P1", "review_unresolved"],
      ["three_p1_rounds：连续三轮 P1", "review_unresolved"],
      ["workflow_drift：流程模板、任务类型或规格版本已变，自动推进暂停", "spec_drift"],
    ];
    for (const [text, code] of cases) expect([text, parseManualReason(text)?.code]).toEqual([text, code]);
  });

  test("existing callers' fixed sentences (auto tick, merge handoff, peer PR, supervisor, start rollback, PM) all classify", () => {
    const cases: [string, string][] = [
      ["author session：peer 委托（agent-x@far）本段不自动派，退回 manual", "runtime_unavailable"],
      ["Pi 会话没有已核实的模型家族配对，不自动派", "runtime_unavailable"],
      ["未知 runtime gemini，不猜派单路径", "runtime_unavailable"],
      ["ACP 路径只承载 Codex 会话", "runtime_unavailable"],
      ["已绑定的 session 不能用：gone", "runtime_unavailable"],
      ["agent-rv 不在本机 registry", "runtime_unavailable"],
      ["审查 worktree /x 有已跟踪文件被改过（审查员不该改被审代码），不覆盖：a.ts", "review_source_missing"],
      ["派审意图没有 head", "review_source_missing"],
      ["卡上没有交付 head，审查 worktree 不知道固定到哪", "review_source_missing"],
      ["agent-rv 的审查目录有未提交改动（a.ts）：结论会被拒，审的也不再是 commit abc", "review_source_missing"],
      ["T1 没有前后两张截图（extra.screenshots），不能请 owner 只看一串摘要", "ui_evidence_stale"],
      ["截图 ask 已过期或被撤下，没人能再答：PM 决定重开还是接管", "ui_evidence_stale"],
      ["agent-rv 报了归不到派单上的失败（quota），本单可能也没跑：x", "runtime_unavailable"],
      ["agent-one 撞额度：limit", "runtime_unavailable"],
      ["agent-one 回合失败：provider 拒绝了请求，不再换提供方", "safety_refusal"],
      ["本项目合并交仓库方，本机不执行合并意图 i1（submitted）：PM 核对后结清", "merge_unknown"],
      ["合并要交给仓库方，但卡上没有 PR 或 head", "merge_unknown"],
      ["交接后 PR head 变了（abc → def），本机审查证据只覆盖交接的 head", "merge_unknown"],
      ["PR #12 在合并队列外被合并了", "merge_unknown"],
      ["PR #12 已关闭", "spec_drift"],
      ["PR #12 的 base 改成了 dev", "spec_drift"],
      ["PR #12 改成了跨仓 / head 仓库 owner 不对", "spec_drift"],
      ["第 3 轮审查后仍有 P1，复验轮次到顶（maxRounds 3）", "review_unresolved"],
      ["第 2 轮结论后 PR head 又变了，复验轮次已到顶（maxRounds 3）", "review_unresolved"],
      ["[监护] agent-one 卡住，T1 的 build停着：自动处置已做 2/2 次，没恢复", "runtime_unavailable"],
      ["自动开卡中途失败，回滚", "start_rollback"],
      ["start_node 中途失败，回滚", "start_rollback"],
      ["owner 要亲自盯", "owner_hold"],
      ["PM 暂停", "pm_hold"],
      ["temporary resource handoff", "pm_hold"],
      ["PM 接手核对", "pm_takeover"],
      ["接管", "pm_takeover"],
      ["核对调度配置", "pm_takeover"],
      ["peer 委派", "runtime_unavailable"],
    ];
    for (const [text, code] of cases) expect([text, parseManualReason(text)?.code]).toEqual([text, code]);
  });
});

// ── diagnosis ──

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, text = "", ts = 0): LedgerEvent =>
  ({ seq: ++seq, ts, project: "p", target: "T1", kind, actor: "pm", text, data } as unknown as LedgerEvent);
const task = (over: Partial<LedgerTask> = {}): LedgerTask =>
  ({ id: "T1", project: "p", stage: "build", rev: 5, specRev: 1, headSHA: "h1", extra: {}, ...over } as unknown as LedgerTask);
const rec = (code: ManualReasonRecord["code"], over: Partial<ManualReasonRecord> = {}): ManualReasonRecord =>
  ({ v: 1, code, label: code, text: "说明", blocking: null, release: "r", node: "n", approval: false, specRev: 1, head: "h1", uiDigest: null, ...over });
const auto = () => ev("scheduler", { op: "workflow", mode: "auto" });
const toManual = (r: ManualReasonRecord | null, extra: Record<string, unknown> = {}) =>
  ev("scheduler", { op: "workflow", mode: "manual", takeover: r?.text ?? "x", ...(r ? { manualReason: r } : {}), ...extra });

describe("manualEntry / diagnoseManual", () => {
  test("a first configuration into manual is an entry too (no reason = alarmable); auto→manual and resume→fallback do", () => {
    expect(manualEntry([ev("scheduler", { op: "workflow", mode: "manual" })])).toMatchObject({ code: null, record: null });
    expect(manualEntry([toManual(rec("pm_takeover"))])).toMatchObject({ code: "pm_takeover" });
    const e = [auto(), toManual(rec("deps_not_live"))];
    expect(manualEntry(e)?.code).toBe("deps_not_live");
    expect(manualEntry([...e, ev("scheduler", { op: "workflow_resume" })])).toBeNull();
    const fb = [auto(), ev("scheduler", { op: "fallback_manual", reason: "Pi 会话没有已核实的模型家族配对" })];
    expect(manualEntry(fb)).toMatchObject({ code: "runtime_unavailable", record: null });
    expect(manualEntry([auto(), ev("scheduler", { op: "merge_resolve", outcome: "failed", receipt: "PR closed" })])?.code).toBe("merge_unknown");
  });

  test("deps_not_live: would-resume only once deps are read and clear; planned / CI-green deps and an unread source never pass", () => {
    const e = [auto(), toManual(rec("deps_not_live"))];
    expect(diagnoseManual({ task: task(), events: e, blockedBy: [] })).toMatchObject({ wouldResume: true, gaps: [] });
    expect(diagnoseManual({ task: task(), events: e, blockedBy: ["T0"] })).toMatchObject({ wouldResume: false, gaps: ["前置未上线：T0"] });
    expect(diagnoseManual({ task: task(), events: e })).toMatchObject({ wouldResume: false, gaps: ["依赖没读到"] });
  });

  test("merge_unknown: still unknown or journal unread = no would-resume", () => {
    const e = [auto(), toManual(rec("merge_unknown"))];
    expect(diagnoseManual({ task: task(), events: e, mergeUnknown: ["T1"] })?.wouldResume).toBe(false);
    expect(diagnoseManual({ task: task(), events: e })?.gaps).toContain("合并 journal 没读到");
    expect(diagnoseManual({ task: task(), events: e, mergeUnknown: [] })?.wouldResume).toBe(true);
  });

  test("safety refusal / owner hold / PM hold are never liftable here, whatever the facts", () => {
    for (const c of ["safety_refusal", "owner_hold", "pm_hold", "pm_takeover"] as const) {
      const d = diagnoseManual({ task: task(), events: [auto(), toManual(rec(c))], blockedBy: [], mergeUnknown: [] });
      expect([c, d?.wouldResume, d?.gaps.some((g) => g.includes("只由人解除"))]).toEqual([c, false, true]);
    }
  });

  test("head / spec / UI drift, an open old order and a fake review each void would-resume", () => {
    const base = [auto(), toManual(rec("deps_not_live", { uiDigest: "d1" }))];
    const ok = { blockedBy: [] as string[] };
    const t = task({ extra: { screenshotsDigest: "d1" } });
    expect(diagnoseManual({ task: t, events: base, ...ok })?.wouldResume).toBe(true);
    expect(diagnoseManual({ task: { ...t, specRev: 2 }, events: base, ...ok })?.gaps).toContain("规格已变（specRev 1→2）");
    expect(diagnoseManual({ task: { ...t, headSHA: "h2" }, events: base, ...ok })?.gaps).toContain("head 已变");
    expect(diagnoseManual({ task: { ...t, extra: { screenshotsDigest: "d2" } }, events: base, ...ok })?.gaps).toContain("UI 截图摘要已变");
    const old = [ev("scheduler", { op: "plan", id: "old:1" }), ...base];
    expect(diagnoseManual({ task: t, events: old, ...ok })).toMatchObject({ wouldResume: false, gaps: ["未结意图 / 旧订单：old:1"] });
    const settled = [...old, ev("scheduler", { op: "settle", id: "old:1", to: "cancelled" })];
    expect(diagnoseManual({ task: t, events: settled, ...ok })?.wouldResume).toBe(true);
    const fake = [...base, ev("review", { verdict: "pass", witness: { mismatch: ["cwd"] } })];
    expect(diagnoseManual({ task: t, events: fake, ...ok })?.wouldResume).toBe(false);
  });

  test("a legacy entry without a structured record is diagnosed but never would-resume; no reason at all names the gap", () => {
    const legacy = diagnoseManual({ task: task(), events: [auto(), toManual(null, { takeover: "依赖 T0" })], blockedBy: [] });
    expect(legacy).toMatchObject({ code: "deps_not_live", structured: false, wouldResume: false });
    const none = diagnoseManual({ task: task(), events: [auto(), ev("scheduler", { op: "workflow", mode: "manual" })], blockedBy: [] });
    expect(none).toMatchObject({ code: null, label: "无理由", gaps: ["进入 manual 时没记理由"], wouldResume: false });
    expect(none?.next).toContain("--reason");
    expect(diagnoseManual({ task: task({ stage: "done" }), events: [auto(), toManual(rec("deps_not_live"))], blockedBy: [] })).toBeNull();
  });
});

describe("manualResumeMode", () => {
  test("on is only observe here (MAN2 executes); off, a throwing port, CFG's unreadable answer or an unknown mode = off", () => {
    expect(manualResumeMode(() => ({ mode: "off", manualAfterMs: null, source: "error", diagnostic: "读不了" }), "p")).toBe("off");
    expect(manualResumeMode(() => ({ mode: "observe" }), "p")).toBe("observe");
    expect(manualResumeMode(() => ({ mode: "on" }), "p")).toBe("observe");
    expect(manualResumeMode(() => ({ mode: "off" }), "p")).toBe("off");
    expect(manualResumeMode(() => ({ mode: "bogus" }), "p")).toBe("off");
    expect(manualResumeMode(() => { throw new Error("bad file"); }, "p")).toBe("off");
  });
});
