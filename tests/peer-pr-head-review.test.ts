/**
 * merge-arch-PEERHEAD1：peer PR 审查通过后作者又推。真台账 + 真 ledger CLI（调度身份，进程内）+ 真 peer tick，GitHub / bridge / git 是假的。
 * 到顶只按连续未解决 P1 轮数算（PR1602 不再误判、PR1603 照旧到顶）；manual 卡受限自动复审（结清未发出的人工合并、只审增量）；
 * 增量复审通过后调度器代排（on）或只记样本 + PM 一次（observe）；hold / 暂停 / 冻结 / 待答审批全挡；两个键 off 回到现状。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { openAsk, type NewAsk } from "../src/lib/ledger-asks.ts";
import { getWorkflow } from "../src/lib/ledger-scheduler.ts";
import type { LedgerTask } from "../src/lib/ledger-stages.ts";
import { getTask, listEvents } from "../src/lib/ledger-store.ts";
import { insertEvent } from "../src/lib/ledger-tx.ts";
import { moveStage, setFrozen } from "../src/lib/ledger-write.ts";
import { claimManualMerge, listOpenRequests, manualTurn } from "../src/lib/manual-merge-queue.ts";
import { listRequests, revokeOf } from "../src/lib/manual-merge-queue-facts.ts";
import { proveRecovery } from "../src/lib/manual-recovery-release.ts";
import { extensionMode } from "../src/lib/manual-recovery-policy.ts";
import { PEER_PR_CONFIG_PATH } from "../src/lib/peer-pr-config.ts";
import { entryHead, PEER_PR_HEAD_RESUME } from "../src/lib/peer-pr-head-review-resume.ts";
import { manualEntry } from "../src/lib/manual-reason.ts";
import type { OpenPr, PeerPrGithub } from "../src/lib/peer-pr-github.ts";
import { headLineage } from "../src/lib/peer-pr-head-review-git.ts";
import {
  configureHeadReviewPolicy, HEAD_REVIEW_OP, headReviewMode, registrationScope, roundVerdicts, unresolvedP1Rounds, type Lineage,
} from "../src/lib/peer-pr-head-review.ts";
import type { PeerPrDeps } from "../src/lib/peer-pr-notice.ts";
import { peerPrTick } from "../src/lib/peer-pr-tick.ts";
import { statePath } from "../src/lib/paths.ts";
import { RECOVERY_POLICY_PATH, type RecoveryMode } from "../src/lib/recovery-policy.ts";
import { convergeOrderLines } from "../src/lib/review-converge-order.ts";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.ts";
import { getMergeRun } from "../src/lib/scheduler-merge.ts";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.ts";
import { intakeGithub } from "../src/manager/ledger-peer-pr-cmds.ts";
import { autoFixture, P1, P2 } from "./scheduler-auto-helpers.ts";

const H1 = "a1".repeat(20), H2 = "b2".repeat(20), H3 = "c3".repeat(20), H4 = "d4".repeat(20);
const FP = "0a1b-2c3d-4e5f-6a7b";
const PEER_PRS = { enabled: true, project: "p", fromNumber: 400, pollSec: 30, headSettleSec: 0, replyTo: "agent-pm@me",
  peers: [{ peer: "he", fp: FP, agent: "agent-x", githubLogins: ["he-dev"], authorFamily: "claude" }] };

const modes: { peerPrHeadReview: RecoveryMode; peerPrRequeue: RecoveryMode } = { peerPrHeadReview: "on", peerPrRequeue: "on" };
const setModes = (head: RecoveryMode, requeue: RecoveryMode) => {
  modes.peerPrHeadReview = head; modes.peerPrRequeue = requeue;
  configureHeadReviewPolicy((_p, key) => ({ mode: modes[key as keyof typeof modes] ?? "off", manualAfterMs: null, source: "config" }));
};
let lineage: Lineage = "successor";
const realLineage = headLineage.read;

beforeAll(() => {
  writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
    projects: { p: { maxActiveWorkers: 2, requiredChecks: ["check"], repoDir: statePath() } } }));
  writeFileSync(PEER_PR_CONFIG_PATH, JSON.stringify(PEER_PRS));
  headLineage.read = async () => lineage;
});
afterAll(() => {
  rmSync(SCHEDULER_CONFIG_PATH, { force: true });
  rmSync(PEER_PR_CONFIG_PATH, { force: true });
  headLineage.read = realLineage;
});
afterEach(() => { configureHeadReviewPolicy(null); lineage = "successor"; rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const pr = (): OpenPr => ({ number: 401, url: "https://github.com/o/r/pull/401", title: "修一个小问题", login: "he-dev",
  branch: "fix/small", head: H1, base: "main", crossRepo: false, headOwner: "o", draft: false });

function world() {
  const f = autoFixture();
  f.advance(3_600_000);
  const open: OpenPr[] = [];
  const notices: string[] = [];
  const ownerPushes: string[] = [];
  const github: PeerPrGithub = {
    repo: async () => "o/r", listOpen: async () => open.map((p) => ({ ...p })), files: async () => [{ path: "src/lib/plain-thing.ts" }],
    body: async () => "PR 说明", fetchHead: async () => null,
    view: async (_r, n) => { const p = open.find((x) => x.number === n) ?? pr(); return { state: "OPEN", url: p.url, login: p.login, title: p.title,
      head: p.head, base: p.base, branch: p.branch, crossRepo: p.crossRepo, headOwner: p.headOwner, draft: p.draft }; },
  };
  intakeGithub.make = () => github;
  const deps: PeerPrDeps = {
    github, manager: f.tickDeps.manager, commits: async (shas) => new Set(shas.filter((s) => [H1, H2, H3, H4].includes(s))),
    bridge: async () => ({ ok: true, result: { status: 202 } }),
    notifyPm: async (_p, text) => { notices.push(text); },
    readReport: () => ({ text: "报告" }), identity: { username: "nobodyhere", hostname: "nohost" }, now: f.tickDeps.now,
  };
  const peerTick = async () => {
    const r = await peerPrTick(f.db, { deps: () => deps });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.log;
  };
  const autoTick = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2 } }, f.tickDeps);
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
  };
  const pmActions: string[] = [];
  const notifyPm = f.tickDeps.notifyPm;
  f.tickDeps.notifyPm = async (task, text, level) => { if (level !== "info") pmActions.push(text); return notifyPm(task, text, level); };
  const card = () => getTask(f.db, "PR401")!;
  const events = () => listEvents(f.db, { project: "p", target: "PR401" });
  /** A manual card's verdict is recorded by PM through `ledger review` naming the reviewer (the official manual path). */
  const review = async (verdict: "pass" | "changes", head: string, rows: object[], by?: string) => {
    const actor = by ?? (getWorkflow(f.db, "PR401")?.mode === "manual" ? "pm" : "agent-rv-t1");
    const p = `${f.dir}/findings-${head.slice(0, 4)}-${card().round}.json`;
    writeFileSync(p, JSON.stringify(rows));
    f.reviewerCheckoutAt(head);
    const r = await f.cli(actor, "review", "PR401", "--reviewer", "agent-rv-t1", "--verdict", verdict, "--p0", "0",
      "--p1", String(rows.filter((x) => (x as { severity: string }).severity === "P1").length),
      "--p2", String(rows.filter((x) => (x as { severity: string }).severity === "P2").length),
      "--head", head, "--session", "s-rv", "--family", "codex", "--findings", p, "--path", `reviews/PR401-r${card().round}/report.md`);
    if (r.ok !== true) throw new Error(JSON.stringify(r));
    return r;
  };
  const poll = () => f.advance(31_000);
  /** The author pushes `head`; two polls later (headSettleSec 0) the tick has seen it stable. */
  const push = async (head: string) => {
    open[0]!.head = head;
    poll(); await peerTick();
    poll(); await peerTick();
  };
  const settle = async () => { poll(); await peerTick(); };
  return { f, open, notices, pmActions, ownerPushes, deps, peerTick, autoTick, card, events, review, poll, push, settle };
}
type W = ReturnType<typeof world>;

async function intake(w: W) {
  w.open.push(pr());
  await w.peerTick();
  w.poll();
  await w.peerTick();
  expect(w.card().stage).toBe("review");
}
async function until(w: W, stage: LedgerTask["stage"]) {
  for (let i = 0; i < 3 && w.card().stage !== stage; i++) await w.autoTick();
  expect(w.card().stage).toBe(stage);
}
async function firstRound(w: W, verdict: "pass" | "changes") {
  await intake(w);
  await w.autoTick();
  await w.autoTick();
  await w.review(verdict, H1, verdict === "pass" ? [P2] : [P1]);
  await w.peerTick();
  await until(w, verdict === "pass" ? "merge" : "fix");
}
const pm = (w: W) => ({ actor: "pm", now: w.f.tickDeps.now() });
const rounds = (w: W) => w.notices.filter((n) => n.includes("复验轮次到顶"));
const registrations = (w: W) => w.events().filter((e) => e.kind === "note" && e.data.op === HEAD_REVIEW_OP);
const headIntents = (w: W, head: string) => w.f.db.query("SELECT action, status FROM scheduler_intents WHERE taskId = 'PR401' AND head = ? ORDER BY eventSeq")
  .all(head) as { action: string; status: string }[];
const reviewSeq = (w: W) => w.events().findLast((e) => e.kind === "review")!.seq;

/** The planner's escalation the peer samples entered manual with (MAN1 code review_unresolved). */
const ROUND_CAP = "review_round_cap：第 2 轮审查后仍有 P1，复验轮次到顶";
const resumes = (w: W) => w.events().filter((e) => e.kind === "scheduler" && e.data.op === "workflow_resume");
/** peerPrRequeue (and the manualRecovery umbrella it is read with) as PM sets it. */
async function requeueKey(w: W, mode: RecoveryMode) {
  for (const key of ["manualRecovery", "peerPrRequeue"]) {
    if (key === "manualRecovery" && mode !== "on") continue;
    expect(await w.f.cli("pm", "scheduler-recovery", "p", mode, "--key", key, "--reason", `PEERHEAD1 测试 ${key} ${mode}`)).toMatchObject({ ok: true });
  }
}
const prove = (w: W) => proveRecovery(w.f.db, w.card(), getWorkflow(w.f.db, "PR401"), PEER_PR_HEAD_RESUME, null);

/** r1 pass → merge (auto) → the path hands the card back (manual, review_unresolved) → PM queues it by hand: the state PR1593/1598/1602 were in. */
async function manualQueued(w: W, reason = ROUND_CAP) {
  await firstRound(w, "pass");
  expect((await w.f.cli("scheduler", "scheduler-fallback-manual", "PR401", "--reason", reason)).ok).toBe(true);
  expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
  const c = w.card();
  const r = await w.f.cli("pm", "manual-merge-request", "PR401", "--head", c.headSHA!, "--spec-rev", String(c.specRev), "--round", String(c.round),
    "--review-seq", String(reviewSeq(w)), "--reason", "PM 排合并");
  expect(r).toMatchObject({ ok: true, duplicate: false });
  return Number(r.request);
}

describe("纯函数：连续未解决 P1 轮数（验收线 1）", () => {
  test("只数末尾连续的 P1 轮；pass 断开；没结论的轮不算也不断；block / 读不出的结论算未解决", () => {
    expect(unresolvedP1Rounds([])).toBe(0);
    expect(unresolvedP1Rounds([{ round: 1, verdict: "changes", p1: 1 }, { round: 2, verdict: "pass", p1: 0 }])).toBe(0); // PR1602
    expect(unresolvedP1Rounds([{ round: 1, verdict: "changes", p1: 1 }, { round: 2, verdict: "changes", p1: 2 }])).toBe(2); // PR1603
    expect(unresolvedP1Rounds([{ round: 1, verdict: "changes", p1: 1 }, { round: 2, verdict: "pass", p1: 0 }, { round: 3, verdict: "changes", p1: 1 }])).toBe(1);
    expect(unresolvedP1Rounds([{ round: 2, verdict: "changes", p1: 1 }, { round: 3, verdict: null, p1: 0 }, { round: 1, verdict: "changes", p1: 1 }])).toBe(2);
    expect(unresolvedP1Rounds([{ round: 1, verdict: "block", p1: 0 }, { round: 2, verdict: "unknown", p1: 0 }])).toBe(2);
    expect(unresolvedP1Rounds([{ round: 1, verdict: "changes", p1: 0 }])).toBe(0);
  });

  test("roundVerdicts：只看本 specRev 进 review 的轮，取每轮最后一条结论，规划器降级的 P1 不算", () => {
    const ev = (seq: number, kind: string, data: Record<string, unknown>) => ({ seq, ts: seq, actor: "x", project: "p", target: "T", kind, text: "", data }) as never;
    const events = [
      ev(1, "stage", { to: "review", round: 1, specRev: 1 }), ev(2, "review", { round: 1, verdict: "changes", findings: [{ findingId: "a", severity: "P1" }] }),
      ev(3, "stage", { to: "review", round: 2, specRev: 2 }), ev(4, "review", { round: 2, verdict: "changes", findings: [{ findingId: "b", severity: "P1" }] }),
      ev(5, "scheduler", { op: "review_downgrade", round: 2, findingIds: ["b"] }),
    ];
    expect(roundVerdicts(events, 1)).toEqual([{ round: 1, verdict: "changes", p1: 1 }]);
    expect(roundVerdicts(events, 2)).toEqual([{ round: 2, verdict: "changes", p1: 0 }]);
  });

  test("只审增量的条件：后继提交且规格没变；force-push / 对象缺失 / 规格变了改全量并写明原因", () => {
    expect(registrationScope("successor", 1, 1)).toEqual({ scope: "incremental", why: null });
    expect(registrationScope("force", 1, 1)).toMatchObject({ scope: "full", why: expect.stringContaining("force-push") });
    expect(registrationScope("missing", 1, 1)).toMatchObject({ scope: "full", why: expect.stringContaining("增量对象缺失") });
    expect(registrationScope("successor", 1, 2)).toEqual({ scope: "full", why: "规格变了" });
  });

  test("未配置：peerPrHeadReview 缺省 on，peerPrRequeue 缺省 observe（验收线 7）", () => {
    configureHeadReviewPolicy(null);
    expect([headReviewMode("p"), extensionMode("p", "peerPrRequeue").mode]).toEqual(["on", "observe"]);
  });
});

describe("自动卡：到顶判定读结论（验收线 1 / 7）", () => {
  /** PR1602：r1 P1 → r2 pass → 作者新推、卡退 fix（不是合并闸的正规退回）。 */
  async function pr1602(w: W) {
    await firstRound(w, "changes");
    await w.push(H2);
    await w.autoTick();
    await w.autoTick();
    await w.review("pass", H2, []);
    await w.peerTick();
    moveStage(w.f.db, pm(w), { taskId: "PR401", from: "review", to: "fix", asPm: true, text: "作者又推：退 fix" });
    expect(w.card()).toMatchObject({ stage: "fix", round: 2, headSHA: H2 });
  }

  test("PR1602：r2 pass 后新 head 退 fix，一轮 tick 不再判『仍有 P1』，进 review 第 3 轮，登记增量", async () => {
    setModes("on", "on");
    const w = world();
    await pr1602(w);
    await w.push(H3);
    expect(rounds(w)).toEqual([]);
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("auto");
    expect(w.card()).toMatchObject({ stage: "review", round: 3, headSHA: H3 });
    expect(registrations(w).map((e) => [e.data.oldHead, e.data.newHead, e.data.scope, e.data.cause])).toEqual([[H1, H2, "incremental", "author_push"], [H2, H3, "incremental", "author_push"]]);
    w.f.close();
  });

  test("off：逐字回到现状——PR1602 照旧误判到顶、不登记", async () => {
    setModes("off", "off");
    const w = world();
    await pr1602(w);
    await w.settle();
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
    expect(rounds(w).filter((n) => n.includes("仍有 P1"))).toHaveLength(1);
    expect(registrations(w)).toEqual([]);
    w.f.close();
  });

  test("PR1603：r2 changes / P1 → 新 head → 退 fix，照旧判到顶，PM 只听一次", async () => {
    setModes("on", "on");
    const w = world();
    await firstRound(w, "changes");
    await w.push(H2);
    await w.autoTick();
    await w.autoTick();
    await w.review("changes", H2, [P1]);
    await w.peerTick();
    await until(w, "fix");
    await w.push(H3);
    await w.settle();
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
    expect(rounds(w)).toHaveLength(1);
    expect(w.card()).toMatchObject({ stage: "fix", round: 2, headSHA: H2 });
    w.f.close();
  });

  test("自动卡冻结（on）：作者新推不换 head、不进轮、不登记；off 照旧收新 head（验收线 6 / 7）", async () => {
    for (const mode of ["on", "off"] as const) {
      setModes(mode, mode);
      const w = world();
      await firstRound(w, "changes");
      setFrozen(w.f.db, pm(w), { project: "p", frozen: true, reason: "冻一下" });
      await w.push(H2);
      await w.settle();
      expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("auto");
      if (mode === "on") expect(w.card()).toMatchObject({ stage: "fix", round: 1, headSHA: H1 });
      else expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
      expect(registrations(w)).toEqual([]);
      w.f.close();
    }
  });
});

describe("manual 卡：登记新 head → peerPrHeadResume 交回自动（验收线 2–8）", () => {
  test("on：merge + queued 请求 + 最近 pass + 后继提交：结清旧请求、登记、交回 auto、派增量审；pass 走自动合并绑新 head；不推送（验收线 2 / 3 / 8）", async () => {
    setModes("on", "on");
    const w = world();
    await requeueKey(w, "on");
    const old = await manualQueued(w);
    const actionsBefore = w.pmActions.length;
    await w.push(H2);
    expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
    const req = listRequests(w.f.db, "p", "PR401").find((r) => r.seq === old)!;
    expect(revokeOf(w.f.db, req)?.data).toMatchObject({ byScheduler: "peerPrHeadReview" });
    expect(listOpenRequests(w.f.db, "p")).toEqual([]); // 复审期间旧请求占不了槽
    expect(manualTurn(w.f.db, "p", "none", Date.now()).kind).toBe("none");
    const reg = registrations(w).at(-1)!;
    expect(reg.data).toMatchObject({ cause: "author_push", oldHead: H1, newHead: H2, priorReviewSeq: reviewSeq(w), scope: "incremental", settled: { requests: [old] } });

    await w.autoTick(); // the registry (manual-recovery-release.ts) hands it back through scheduler-manual-resume --mechanism
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("auto");
    expect(resumes(w).map((e) => (e.data.recoveryProof as { mechanism: string; head: string; round: number })))
      .toEqual([expect.objectContaining({ mechanism: PEER_PR_HEAD_RESUME, head: H2, round: 2 })]);
    for (let i = 0; i < 3 && !headIntents(w, H2).length; i++) await w.autoTick();
    expect(headIntents(w, H2).map((i) => i.action)).toEqual(["review"]); // the review order really went out, for the new head
    const lines = convergeOrderLines(2, w.events(), H2).join("\n");
    expect(lines).toContain(`git diff ${H1.slice(0, 12)}..${H2.slice(0, 12)}`);
    expect(lines).not.toContain(H2); // 工单里只写短号

    await w.review("pass", H2, []); // the bound reviewer's own verdict (the card is auto)
    await w.peerTick();
    await until(w, "merge");
    for (let i = 0; i < 3 && !headIntents(w, H2).some((x) => x.action === "merge"); i++) await w.autoTick();
    expect(headIntents(w, H2).map((i) => i.action)).toContain("merge"); // the automatic merge, bound to the new head
    expect(w.f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'PR401' AND action = 'merge' AND head != ?").get(H2)).toEqual({ n: 0 });
    // 重复 tick / 重启：只登记一次、只交回一次
    await w.settle();
    await peerPrTick(w.f.db, { deps: () => w.deps, state: { heads: new Map(), lastPoll: 0, repo: null, noticeFailAt: new Map(), verifyAt: new Map() } });
    await w.autoTick();
    expect([registrations(w).length, resumes(w).length]).toEqual([1, 1]);
    expect(w.notices).toEqual([]); // 验收线 8：peer 路径 PM 通知 0 次
    expect(w.pmActions.slice(actionsBefore)).toEqual([]); // 调度器侧没有要 PM 动手（action）的通知；注册表交回的那条是 info（只记卡片、不送 PM）
    expect(w.ownerPushes).toEqual([]);
    w.f.close();
  });

  test("on：交回后复审 changes 回 fix，不合并（验收线 3）", async () => {
    setModes("on", "on");
    const w = world();
    await requeueKey(w, "on");
    await manualQueued(w);
    await w.push(H2);
    for (let i = 0; i < 4 && !headIntents(w, H2).length; i++) await w.autoTick();
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("auto");
    await w.review("changes", H2, [P1]);
    await w.peerTick();
    await until(w, "fix");
    expect(w.card()).toMatchObject({ stage: "fix", round: 2, headSHA: H2 });
    expect(headIntents(w, H2).filter((i) => i.action === "merge")).toEqual([]);
    w.f.close();
  });

  test("审查中又推：旧审查绑旧 head；结论（pass）出来后不合并，按最新 head 再登记一轮；force-push 全量并写明原因（验收线 5）", async () => {
    setModes("on", "on");
    const w = world();
    await requeueKey(w, "on");
    await manualQueued(w);
    await w.push(H2);
    for (let i = 0; i < 4 && !headIntents(w, H2).length; i++) await w.autoTick();
    lineage = "force";
    await w.push(H3); // 第 2 轮还没结论
    expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
    await w.review("pass", H2, []);
    await w.settle();
    await w.settle();
    await w.autoTick();
    expect(w.card()).toMatchObject({ stage: "review", round: 3, headSHA: H3 });
    expect(w.f.db.query("SELECT COUNT(*) AS n FROM scheduler_intents WHERE taskId = 'PR401' AND action = 'merge'").get()).toEqual({ n: 0 }); // 中间版本的 pass 不授权
    expect(registrations(w).at(-1)!.data).toMatchObject({ oldHead: H2, newHead: H3, scope: "full" });
    const lines = convergeOrderLines(3, w.events(), H3).join("\n");
    expect(lines).toContain("不能只审增量");
    expect(lines).toContain("force-push");
    w.f.close();
  });

  test("peerPrRequeue 未配置 = observe：不交回，一条『本会交回』样本，PM 一次通知；重复 tick 不再记、不再发（验收线 7）", async () => {
    setModes("on", "observe");
    const w = world();
    await manualQueued(w);
    await w.push(H2);
    for (let i = 0; i < 3; i++) { await w.autoTick(); await w.settle(); }
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
    expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
    expect(headIntents(w, H2)).toEqual([]);
    const samples = w.events().filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "peerPrRequeue");
    expect(samples).toHaveLength(1);
    expect(samples[0]!.data.recoveryProof).toMatchObject({ mechanism: PEER_PR_HEAD_RESUME, head: H2, round: 2, subreason: "author_push" });
    const n = w.notices.filter((x) => x.includes("本会交回 auto"));
    expect(n).toHaveLength(1);
    expect(n[0]).toContain("新 head 已登记到 review");
    expect(w.notices).toHaveLength(1);
    w.f.close();
  });

  test("peerPrRequeue off：照样登记进 review，但不交回、不记样本、不通知", async () => {
    setModes("on", "observe");
    const w = world();
    await requeueKey(w, "off");
    await manualQueued(w);
    await w.push(H2);
    for (let i = 0; i < 3; i++) { await w.autoTick(); await w.settle(); }
    expect(getWorkflow(w.f.db, "PR401")?.mode).toBe("manual");
    expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
    expect(w.events().filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "peerPrRequeue")).toEqual([]);
    expect(w.notices).toEqual([]);
    w.f.close();
  });

  test("不交回：sticky 码（PM 接管）；PR1603 那类最近结论不是 pass；登记后 head 又变；登记的 oldHead 对不上进 manual 的 head（验收线 6）", async () => {
    setModes("on", "on");
    // sticky：PM 接管进的 manual，照样登记，但注册表不交回
    const w = world();
    await requeueKey(w, "on");
    await manualQueued(w, "PM 接管");
    await w.push(H2);
    expect(w.card()).toMatchObject({ stage: "review", round: 2 });
    for (let i = 0; i < 3; i++) await w.autoTick();
    expect([getWorkflow(w.f.db, "PR401")?.mode, resumes(w).length]).toEqual(["manual", 0]);
    expect(prove(w)).toMatchObject({ kind: "refused", why: expect.stringContaining("pm_takeover") });
    w.f.close();

    // PR1603：review_unresolved，但最近结论是 changes / P1：不登记、不交回
    const v = world();
    await requeueKey(v, "on");
    await firstRound(v, "changes");
    expect((await v.f.cli("scheduler", "scheduler-fallback-manual", "PR401", "--reason", ROUND_CAP)).ok).toBe(true);
    await v.push(H2);
    for (let i = 0; i < 3; i++) await v.autoTick();
    expect([getWorkflow(v.f.db, "PR401")?.mode, v.card().headSHA, registrations(v).length, resumes(v).length]).toEqual(["manual", H1, 0, 0]);
    v.f.close();

    // 登记后 head 又变（H2 → H3，没有登记）：entryHead 不担保，manualBase 照旧拒「head 已变」
    const u = world();
    await requeueKey(u, "observe");
    await manualQueued(u);
    await u.push(H2);
    expect(prove(u)).toMatchObject({ kind: "candidate", proof: { mechanism: PEER_PR_HEAD_RESUME, head: H2, round: 2, evidenceSeq: registrations(u).at(-1)!.seq } });
    const entry = manualEntry(u.events())!;
    expect(entryHead(u.card(), u.events(), entry.event.seq, entry.record!)).toBe(H1);
    // 登记的 oldHead 对不上进 manual 时记的 head：不担保
    expect(entryHead(u.card(), u.events(), entry.event.seq, { ...entry.record!, head: H4 })).toBeNull();
    // 登记早于这次进 manual：不担保
    expect(entryHead(u.card(), u.events(), registrations(u).at(-1)!.seq + 1, entry.record!)).toBeNull();
    u.f.db.query("UPDATE tasks SET headSHA = ? WHERE id = 'PR401'").run(H3);
    expect(entryHead(u.card(), u.events(), entry.event.seq, entry.record!)).toBeNull();
    expect(prove(u)).toMatchObject({ kind: "refused", why: "head 已变" });
    u.f.close();
  });

  test("合并已发出 / 运行 unknown 的不碰；纯合 main 的新 head 不算作者改动", async () => {
    setModes("on", "on");
    const w = world();
    const seq = await manualQueued(w);
    const c = w.card();
    w.f.db.prepare(`INSERT INTO scheduler_intents (id, taskId, project, node, action, recipient, causalSeq, taskRev, specRev, head, templateVersion, status,
      attempts, reason, createdAt, updatedAt) VALUES (?, 'PR401', 'p', 'manual_merge', 'merge', NULL, 0, ?, ?, ?, 2, 'unknown', 1, 'x', 1, 1)`)
      .run(`mmq:${seq}`, c.rev, c.specRev, c.headSHA);
    await w.push(H2);
    await w.settle();
    expect(w.card()).toMatchObject({ stage: "merge", round: 1, headSHA: H1 });
    expect(revokeOf(w.f.db, listRequests(w.f.db, "p", "PR401")[0]!)).toBeNull();
    w.f.db.prepare("DELETE FROM scheduler_intents WHERE id = ?").run(`mmq:${seq}`);
    lineage = "main_merge";
    w.f.advance(600_000);
    await w.settle();
    expect(w.card()).toMatchObject({ stage: "merge", round: 1, headSHA: H1 });
    expect(registrations(w)).toEqual([]);
    w.f.close();
  });

  test("已占槽、没发出的运行（ready）同一事务结清；合并已发出（merging）的不碰（验收线 4）", async () => {
    setModes("on", "on");
    writeFileSync(RECOVERY_POLICY_PATH, JSON.stringify({ projects: { p: { keys: { manualMergeQueue: "on" } } } }));
    try {
      for (const phase of ["ready", "merging"] as const) {
        const w = world();
        const seq = await manualQueued(w);
        expect(claimManualMerge(w.f.db, { actor: "scheduler", now: Date.now() }, { project: "p", mode: "on", train: "none", requiredChecks: ["check"] }))
          .toMatchObject({ claimed: true, intentId: `mmq:${seq}` });
        if (phase === "merging") w.f.db.prepare("UPDATE scheduler_merges SET phase = 'merging' WHERE intentId = ?").run(`mmq:${seq}`);
        await w.push(H2);
        const run = getMergeRun(w.f.db, `mmq:${seq}`)!;
        if (phase === "ready") {
          expect(w.card()).toMatchObject({ stage: "review", round: 2, headSHA: H2 });
          expect(run.phase).toBe("resolved");
          expect(w.f.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(`mmq:${seq}`)).toEqual({ status: "cancelled" });
          expect(w.f.db.query("SELECT 1 FROM scheduler_resources WHERE intentId = ?").get(`mmq:${seq}`)).toBeNull();
        } else {
          expect(w.card()).toMatchObject({ stage: "merge", round: 1, headSHA: H1 });
          expect(run.phase).toBe("merging");
          expect(revokeOf(w.f.db, listRequests(w.f.db, "p", "PR401")[0]!)).toBeNull();
        }
        w.f.close();
      }
    } finally {
      rmSync(RECOVERY_POLICY_PATH, { force: true });
    }
  });

  test("hold / 冻结 / 待答审批：一律不登记、不排队", async () => {
    setModes("on", "on");
    for (const block of ["frozen", "ask", "hold"] as const) {
      const w = world();
      await manualQueued(w);
      if (block === "frozen") setFrozen(w.f.db, pm(w), { project: "p", frozen: true, reason: "冻一下" });
      if (block === "ask") {
        openAsk(w.f.db, { project: "p", taskId: "PR401", source: "human", kind: "decide", title: "能合吗",
          options: [{ type: "buttons", buttons: [{ id: "go", label: "好" }] }] } as NewAsk);
      }
      if (block === "hold") insertEvent(w.f.db, pm(w), { project: "p", target: "PR401", kind: "scheduler", text: "留人工", data: { op: "workflow", mode: "manual", hold: true } }, false);
      await w.push(H2);
      await w.settle();
      expect([block, w.card().stage, w.card().headSHA]).toEqual([block, "merge", H1]);
      expect(registrations(w)).toEqual([]);
      w.f.close();
    }
  });

  test("peerPrHeadReview off：manual 卡逐字回到现状（不登记、不碰请求）", async () => {
    setModes("off", "on");
    const w = world();
    await manualQueued(w);
    await w.push(H2);
    await w.settle();
    expect(w.card()).toMatchObject({ stage: "merge", round: 1, headSHA: H1 });
    expect(revokeOf(w.f.db, listRequests(w.f.db, "p", "PR401")[0]!)).toBeNull();
    expect(w.events().filter((e) => e.data.op === "recovery_observe")).toEqual([]);
    w.f.close();
  });
});
