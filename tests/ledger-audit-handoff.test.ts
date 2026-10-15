/** AUDH2-1：已交给仓库方合并（merge_handoff）的 merge 卡，ship_stalled / merge_ready 按交接口径判；没交接的卡照旧。 */
import { describe, expect, test } from "bun:test";
import { auditLedger, type AuditSnapshot } from "../src/lib/ledger-audit.js";
import { collectHandoffPr, HANDOFF_STALL_MS, readHandoffPr, type HandoffInputs, type HandoffPrFact } from "../src/lib/ledger-audit-handoff.js";
import type { MergeCiFact, MergeReadyInputs } from "../src/lib/ledger-audit-merge-ready.js";
import type { EventKind, LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import type { MergeTrainInputs } from "../src/lib/ledger-audit-train.js";
import type { RecoveryPolicyPort } from "../src/lib/recovery-policy.js";

const MIN = 60_000, NOW = 100_000 * MIN, PM = "agent-pm", H = "a".repeat(40), M = "d".repeat(40);
const PR_URL = "https://github.com/o/r/pull/1";
let seq = 0;
const ev = (ts: number, kind: EventKind, data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq: ++seq, ts, actor: "scheduler", project: "p", target: "T1", kind, text: "", data, dedupKey: null });
const task = (over: Partial<LedgerTask> = {}): LedgerTask => ({ id: "T1", project: "p", itemId: null, title: "T1", kind: "code", stage: "merge",
  stageBefore: null, round: 1, agent: "agent-x", pm: PM, branch: "b", pr: PR_URL, headSHA: H, spec: null, specRev: 1,
  model: null, rev: 3, extra: {}, createdAt: 0, updatedAt: 0, assigneeKind: "agent", assignee: "agent-x", ...over });
const review = (at: number) => ev(at, "review", { round: 1, head: H, verdict: "pass", reviewer: "agent-rv", reviewerSessionId: "s",
  reviewerFamily: "codex", path: "r.md", findings: [], p0: 0, p1: 0, p2: 0 });
/** 进 merge 于 stageAt；handoff = 同时记交接事件（SYN-2 / FUP-1 的形状）；之后的事件由调用方追加（seq 要更晚） */
const card = (stageAt: number, handoff: boolean, over: Partial<LedgerTask> = {}) => ({ task: task(over), events: [
  ev(0, "task", { op: "new" }), review(stageAt - MIN), ev(stageAt, "stage", { from: "review", to: "merge" }),
  ...(handoff ? [ev(stageAt, "scheduler", { op: "merge_handoff", evidence: { pr: PR_URL, head: H } })] : [])] });
const ci: MergeCiFact = { head: H, state: "green", source: "live", checkedAt: NOW, blockers: [] };
type Snap = AuditSnapshot & MergeReadyInputs & HandoffInputs & MergeTrainInputs;
const snap = (tasks: AuditSnapshot["tasks"], pr?: HandoffPrFact | null, over: Partial<Snap> = {}): Snap =>
  ({ project: "p", pms: [PM], tasks, agents: [], reviewers: [], held: [], ownerInbox: [], mergeCi: { T1: ci },
    ...(pr === undefined ? {} : { handoffPr: { T1: pr } }), ...over });
let trainMode: "on" | "observe" = "observe";
const policy: RecoveryPolicyPort = (_p, key) => ({ mode: key === "auditTrainQueue" ? trainMode : "observe", manualAfterMs: null, source: "config" });
const run = (s: Snap, now = NOW) => auditLedger(s, now, policy);
const rules = (s: Snap, now = NOW) => run(s, now).findings.filter((f) => f.rule === "ship_stalled" || f.rule === "merge_ready_idle");
const open: HandoffPrFact = { state: "OPEN", mergeSha: null, mergedAt: null, base: "main", head: H };
/** 合进 main、合并时 head 就是交接的 head、本机 main 证实含合并提交：调度器能落 live 的那组事实 */
const merged: HandoffPrFact = { state: "MERGED", mergeSha: M, mergedAt: NOW - 40 * MIN, base: "main", head: H, landing: { ok: true } };
const kept = (s: Snap) => run(s).keep.some((k) => k.startsWith("p|ship_stalled|T1|merge|") && k.includes("|handoff|"));

describe("AUDH2-1 交接后巡检", () => {
  test("SYN-2 形状：交接后 40 分钟、PR 开着 → 不报 ship_stalled / merge_ready，key keep 住", () => {
    const r = run(snap([card(NOW - 40 * MIN, true)], open));
    expect(r.findings.filter((f) => f.rule === "ship_stalled" || f.rule === "merge_ready_idle")).toEqual([]);
    expect(r.keep.some((k) => k.startsWith("p|ship_stalled|T1|merge|"))).toBe(true);
    // 61 分钟（merge_ready 原阈值之后）与 11 小时也不报；PR 状态没读到同口径
    expect(rules(snap([card(NOW - 61 * MIN, true)], open))).toEqual([]);
    expect(rules(snap([card(NOW - 11 * 60 * MIN, true)], null))).toEqual([]);
    expect(rules(snap([card(NOW - 11 * 60 * MIN, true)]))).toEqual([]);
  });

  test("PR 开着超过 12 小时 → 只报一条 ship_stalled，说去问仓库方、不说补做合并部署；key 在同一次交接里不变", () => {
    const t = card(NOW - HANDOFF_STALL_MS - MIN, true);
    const f = rules(snap([t], open));
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("ship_stalled");
    expect(f[0]!.detail).toContain("仓库方合并队列停了 12 小时");
    expect(f[0]!.suggestion).toContain("去问仓库方");
    expect(f[0]!.suggestion).not.toContain("补做合并部署，做完推阶段");
    // 一小时后、PR 期间被合入 main（carry）也还是同一个 key：store 按 key 去重，不重推
    const later = rules(snap([{ ...t, events: [...t.events, ev(NOW + 30 * MIN, "scheduler", { op: "merge_handoff_carry" })] }], null), NOW + 60 * MIN);
    expect(later.map((x) => x.key)).toEqual([f[0]!.key]);
    expect(later[0]!.detail).toContain("PR 状态这轮没读到");
  });

  test("FUP-1 形状：PR 已合并、本机未部署 → 不出现「走正式合并入口」，提示需要部署 / manager update 后推 live", () => {
    const f = rules(snap([card(NOW - 2 * 60 * MIN, true)], merged));
    expect(f.map((x) => x.rule)).toEqual(["ship_stalled"]);
    expect(f[0]!.detail).toContain(`已由仓库方合并 ${M.slice(0, 12)}`);
    expect(f[0]!.suggestion).toContain("需要部署");
    expect(f[0]!.suggestion).toContain("manager update");
    expect(f.some((x) => x.suggestion.includes("走正式合并入口"))).toBe(false);
    // 刚合并（未满 mergeStallMs）：等调度器自己落 live，不报
    expect(rules(snap([card(NOW - 2 * 60 * MIN, true)], { ...merged, mergedAt: NOW - 5 * MIN }))).toEqual([]);
  });

  test("审查 P1：冻结 / 列车排队中照原规则不报、keep 住（PR 开着满 12 小时、已合并满 30 分钟都一样）", () => {
    for (const pr of [open, merged]) {
      const t = card(NOW - HANDOFF_STALL_MS - MIN, true);
      expect(rules(snap([t], pr, { queueFrozen: true }))).toEqual([]);
      expect(kept(snap([t], pr, { queueFrozen: true }))).toBe(true);
      trainMode = "on";
      const train = { mergeTrain: { active: [], freedAt: null }, trainFacts: { holder: { taskId: "T9", intentId: "i", phase: "ci", merged: false },
        cards: { T1: { stage: "merge", merged: false, phase: "ready" } } } };
      expect(rules(snap([t], pr, train))).toEqual([]);
      expect(kept(snap([t], pr, train))).toBe(true);
      trainMode = "observe";
    }
  });

  test("验收追加 6：①PR OPEN、交接 24 小时、queueFrozen → 不报；②PR MERGED 60 分钟、5 分钟前解冻 → 缓冲期内不报；两种都 keep 同一 key", () => {
    const frozen = snap([card(NOW - 24 * 60 * MIN, true)], open, { queueFrozen: true });
    expect(rules(frozen)).toEqual([]);
    expect(kept(frozen)).toBe(true);
    const t = card(NOW - 2 * 60 * MIN, true), mergedHour = { ...merged, mergedAt: NOW - 60 * MIN };
    const buffer = snap([t], mergedHour, { unfrozenAt: NOW - 5 * MIN });
    expect(rules(buffer)).toEqual([]);
    expect(kept(buffer)).toBe(true);
    // 缓冲期过了照报，且就是缓冲期里 keep 的那个 key（不重发新 key）
    const key = run(buffer).keep.find((k) => k.includes("|handoff|"))!;
    const after = rules(snap([t], mergedHour, { unfrozenAt: NOW - 5 * MIN }), NOW + 26 * MIN);
    expect(after.map((f) => f.key)).toEqual([key]);
    expect(after[0]!.suggestion).toContain("需要部署");
  });

  test("审查 P1：只有合进 main、head 对得上、本机 main 证实含合并提交才提示部署；证不了只提示核查", () => {
    const t = card(NOW - 2 * 60 * MIN, true);
    for (const [pr, why] of [[{ ...merged, base: "release" }, "合进的是 release"], [{ ...merged, base: null }, "读不出的分支"],
      [{ ...merged, head: "e".repeat(40) }, "不是交接后跟的"], [{ ...merged, landing: undefined }, "没核对本机 main"],
      [{ ...merged, landing: { ok: false, reason: "main（x）还不含合并提交 y" } }, "还不含合并提交"]] as const) {
      const f = rules(snap([t], pr));
      expect(f).toHaveLength(1);
      expect(f[0]!.detail).toContain(why);
      expect(f[0]!.suggestion).toContain("证实前不要部署、不要推 live");
      expect(f[0]!.suggestion).not.toContain("manager update");
    }
    // 交接后 PR 只合入了 main（调度器记的 carry）：跟的 head 前移，合并时 head 对上 carry 后的就算对得上
    const C = "c".repeat(40), first = card(NOW - 2 * 60 * MIN, true);
    const carried = { ...first, events: [...first.events, ev(NOW - 90 * MIN, "scheduler", { op: "merge_handoff_carry", handoffSeq: first.events[3]!.seq, from: H, to: C })] };
    expect(rules(snap([carried], { ...merged, head: C }))[0]!.suggestion).toContain("需要部署");
    expect(rules(snap([carried], merged))[0]!.suggestion).toContain("证实前不要部署");
  });

  test("审查 P2：PR 被关掉没合并 → 30 分钟就报，说关闭了、要退回或作废，不说合并队列停了", () => {
    const closed: HandoffPrFact = { ...open, state: "CLOSED" };
    expect(rules(snap([card(NOW - 20 * MIN, true)], closed))).toEqual([]);
    const f = rules(snap([card(NOW - 40 * MIN, true)], closed));
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toContain("被关闭、没有合并");
    expect(f[0]!.detail).not.toContain("合并队列停了");
    expect(f[0]!.suggestion).toContain("退回 fix");
  });

  test("推进到 live 之后交接口径的 key 不再出现（live 照原规则另算）", () => {
    const first = card(NOW - 2 * HANDOFF_STALL_MS, true, { stage: "live" });
    const t = { ...first, events: [...first.events, ev(NOW - 10 * MIN, "stage", { from: "merge", to: "live" })] };
    const r = run(snap([t], open));
    expect(r.findings.filter((f) => f.rule === "ship_stalled")).toEqual([]);
    expect(r.keep.some((k) => k.includes("handoff"))).toBe(false);
  });

  test("回到 merge 后旧交接不算数：新的这次停留没有交接事件 → 照原规则报", () => {
    const first = card(NOW - 5 * 60 * MIN, true); // 先建卡再追加：事件 seq 要比第一次交接晚
    const t = { ...first, events: [...first.events, ev(NOW - 4 * 60 * MIN, "stage", { from: "merge", to: "fix" }),
      ev(NOW - 3 * 60 * MIN, "stage", { from: "fix", to: "review" }), ev(NOW - 2 * 60 * MIN, "stage", { from: "review", to: "merge" })] };
    expect(rules(snap([t], open)).map((f) => f.suggestion)).toContain("补做合并部署，做完推阶段");
  });

  test("不带 merge_handoff 的卡照旧：30 分钟报 ship_stalled「补做合并部署」，60 分钟报 merge_ready「走正式合并入口」", () => {
    const f = rules(snap([card(NOW - 61 * MIN, false)]));
    expect(f.find((x) => x.rule === "ship_stalled")?.suggestion).toBe("补做合并部署，做完推阶段");
    expect(f.find((x) => x.rule === "merge_ready_idle")?.suggestion).toContain("走正式合并入口");
  });
});

describe("AUDH2-1 交接卡 PR 取数", () => {
  test("只读 merge 阶段有交接事件、带 PR 的卡；单卡读失败 / 抛错记 null", async () => {
    const asked: string[] = [];
    const got = await collectHandoffPr([card(NOW, true), { ...card(NOW, false), task: task({ id: "T2" }) },
      { ...card(NOW, true), task: task({ id: "T3", pr: "https://github.com/o/r/pull/3" }) }], async (u) => {
      asked.push(u);
      if (u.endsWith("/3")) throw new Error("gh down");
      return open;
    });
    expect(asked).toEqual([PR_URL, "https://github.com/o/r/pull/3"]);
    expect(got).toEqual({ T1: open, T3: null });
  });

  test("gh 输出解析：MERGED 带合并提交、时刻、base、head；失败 / 不合规 = null", async () => {
    const out = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: "", timedOut: false } as never);
    expect(await readHandoffPr(PR_URL, out(JSON.stringify({ state: "MERGED", mergeCommit: { oid: M }, mergedAt: "2026-10-15T12:00:00Z",
      baseRefName: "main", headRefOid: H })))).toEqual({ state: "MERGED", mergeSha: M, mergedAt: Date.parse("2026-10-15T12:00:00Z"), base: "main", head: H });
    expect(await readHandoffPr(PR_URL, out(JSON.stringify({ state: "OPEN", mergeCommit: null, mergedAt: null, baseRefName: "dev", headRefOid: "zz" }))))
      .toEqual({ state: "OPEN", mergeSha: null, mergedAt: null, base: "dev", head: null });
    expect(await readHandoffPr(PR_URL, out("", 1))).toBeNull();
    expect(await readHandoffPr(PR_URL, out("not json"))).toBeNull();
    expect(await readHandoffPr(PR_URL, out(JSON.stringify({ state: "DRAFT" })))).toBeNull();
  });
});
