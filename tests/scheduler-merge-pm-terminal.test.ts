/**
 * dispatch-recovery-MQWAKE2：合并已实际结清、只差 PM 部署收口的卡不再被误报「旧请求失效、重提请求」。UISDEL1 形状（请求 66521 → 正规 carry
 * 到新 head → 运行 merged 带合并提交 → 意图 done，卡仍在 merge）在 MQWAKE1 夹具（临时台账 + 只读 LedgerReader + 进程内正规 ledger CLI）上
 * 全程走正规命令：manual-merge-request / manual-merge-claim / scheduler-merge-step / scheduler-settle。合并回执是合成的，不碰 GitHub。
 * 线 1：旧谓词（requestRefusal 不带 run）判 head 已变 = 原误报来源；新候选 null，observe / on 调度 tick 与窄 CLI 事务重核都零写零发。
 * 线 2 / 3：已部署 / 原 head 合并不提示；S2W、旧请求 / 旧轮的合并、规格已变、resolved 人工结清、矛盾事实、submitted 照原边界。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestAt, requestRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { carryReceipt, getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergePmCandidate } from "../src/lib/scheduler-merge-pm-wait.js";
import { getTask } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { writePolicy } from "./manual-merge-queue-world.test.js";
import { business, DIGEST, FPM, manualCard, mergeCard, ok, P, PM, pmEvents, request, s2w, setFeaturePm, setMode, sha, world, type World } from "./scheduler-merge-pm-kit.test.js";

const MAIN = sha(0x3a1), MERGED = sha(0xa541), NEW = sha(0xc242);
let w: World;
beforeEach(() => { w = world(); writePolicy("on"); });
afterEach(() => { w.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const S = (...a: string[]) => w.as("scheduler", ...a);
type Card = { id: string; head: string; request: number };

/** 正规合并运行：claim（同事务 begin）→ [update-branch + carry 到 newHead] → await_ci → merging → merged；settle = 意图结成 done（不自动部署） */
async function mergeThrough(c: Card, o: { carry?: string; settle?: boolean; mergeSha?: string; beforeMerging?: (id: string) => void } = {}) {
  const id = `mmq:${c.request}`, m = o.mergeSha ?? MERGED;
  expect(await ok(S("manual-merge-claim", P, "--mode", "on", "--train", "none", "--required-checks", "ci"))).toMatchObject({ claimed: true, intentId: id });
  const step = (from: string, to: string, ...extra: string[]) =>
    ok(S("scheduler-merge-step", id, "--from", from, "--to", to, "--rev", String(getMergeRun(w.db, id)!.rev), ...extra));
  if (o.carry) {
    await step("ready", "updating");
    const hop = [{ previousHead: c.head, head: o.carry, mainParent: MAIN }];
    await step("updating", "await_ci", "--receipt", carryReceipt({ oldHead: c.head, newHead: o.carry, mainParent: MAIN, mainHead: MAIN, diffHash: "cd".repeat(32) }) +
      carryChainSuffix(hop), "--new-head", o.carry);
  } else await step("ready", "await_ci", "--receipt", "等待 CI");
  o.beforeMerging?.(id);
  await step("await_ci", "merging", "--receipt", "CI 全绿：ci");
  await step("merging", "merged", "--receipt", `PR 已合并 ${m.slice(0, 12)}，待 PM 部署`, "--merge-sha", m);
  if (o.settle !== false) {
    await ok(S("scheduler-settle", id, "--from", "submitted", "--to", "done", "--receipt", `merge:${m}; 不自动部署（流程被暂停、规格已变或合并意图不再有效），待 PM 部署`));
  }
  return id;
}

const cand = (id: string) => mergePmCandidate(w.db, id, w.clock);

describe("线 1：UISDEL1 形状（正规 carry → 实际 merged → 意图 done，卡仍 merge）", () => {
  test("旧谓词把它判成 head 已变（原误报来源）；新候选 null，observe / on tick 零写零发", async () => {
    const fid = w.feature();
    await setFeaturePm(w, fid, FPM);
    const c = await manualCard(w, "UD1", { featureId: fid });
    const intent = await mergeThrough(c, { carry: NEW });
    const t = getTask(w.db, c.id)!;
    expect([t.stage, t.headSHA]).toEqual(["merge", NEW]);
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(intent)).toEqual({ status: "done" });
    expect(getMergeRun(w.db, intent)).toMatchObject({ phase: "merged", mergeSha: MERGED, reviewedHead: NEW });
    // 旧候选读的是 run=false 的 requestRefusal：carry 后 head ≠ 请求 head → void「head 已变」，于是叫 PM 重提请求
    expect(requestRefusal(w.db, requestAt(w.db, c.request)!, w.clock)).toEqual({ kind: "void", why: `head 已变成 ${NEW.slice(0, 12)}` });
    expect(cand(c.id)).toBeNull();

    for (const mode of ["observe", "on"]) {
      await setMode(w, mode);
      const snap = business(w.db);
      expect(await w.tick()).toEqual([]);
      w.clock += 10 * 60 * 60_000;
      expect(await w.tick()).toEqual([]);
      expect(business(w.db)).toEqual(snap); // 事件（除本功能外）与业务表都不动
    }
    expect(w.sent).toEqual([]);
    expect(pmEvents(w.db, c.id)).toEqual([]);
  });

  test("调度窄 CLI 事务重核同源：拿旧候选会算出的阻塞键记 would / try 一律 conflict，不写", async () => {
    const c = await manualCard(w, "UD2");
    await mergeThrough(c, { carry: NEW });
    // 旧候选的阻塞键（scheduler-merge-pm-wait.ts 同一算法）：卡 + 请求 + 当前 head / specRev / 轮次 / 审查 / 摘要 + 原因 head
    const stale = createHash("sha256").update(JSON.stringify({ taskId: c.id, project: P, request: c.request, head: NEW, specRev: 1, round: 1,
      reviewSeq: c.reviewSeq, digest: null, reasons: ["head"] })).digest("hex").slice(0, 16);
    for (const mode of ["observe", "on"]) {
      await setMode(w, mode);
      const before = business(w.db);
      const r = await S("scheduler-autostart", "merge-pm", c.id, "record", stale, "--mode", mode, "--pm", PM);
      expect(r).toMatchObject({ ok: false, code: "conflict" });
      expect(business(w.db)).toEqual(before);
    }
    expect(pmEvents(w.db, c.id)).toEqual([]);
  });
});

/** 本功能以外的写只有 setMode；observe / on 各跑两轮（隔 10 小时），不该有任何 merge_pm_wait 记录或发送 */
async function silent(id: string) {
  for (const mode of ["observe", "on"]) {
    await setMode(w, mode);
    const snap = business(w.db);
    await w.tick();
    w.clock += 10 * 60 * 60_000;
    await w.tick();
    expect(business(w.db)).toEqual(snap);
  }
  expect(w.sent.filter((s) => s.text.includes(id))).toEqual([]);
  expect(pmEvents(w.db, id)).toEqual([]);
}
const reasons = (id: string) => cand(id)?.reasons ?? null;
const sql = (q: string, ...a: (string | number)[]) => w.db.query(q).run(...a);

describe("线 2：已实际合并的各种收口状态都不提示重提 / 重拍 / 重审批", () => {
  test("PM 已登记部署（ledger deploy）但卡还没推 live：仍不提示", async () => {
    const c = await manualCard(w, "UD-deployed");
    await mergeThrough(c, { carry: NEW });
    await ok(w.as(PM, "deploy", c.id, "--version", MERGED));
    expect(getTask(w.db, c.id)!.stage).toBe("merge");
    expect(cand(c.id)).toBeNull();
    await silent(c.id);
  });

  test("无 carry、原 head 实际合并，之后截图摘要变了：旧谓词判截图摘要已变，新候选 null（已合并不叫重拍）", async () => {
    const c = await manualCard(w, "UD-ui", { ui: true });
    await mergeThrough(c);
    expect(getMergeRun(w.db, `mmq:${c.request}`)!.reviewedHead).toBe(c.head);
    expect(cand(c.id)).toBeNull();
    sql("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?), rev = rev + 1 WHERE id = ?", "cd".repeat(32), c.id);
    expect(requestRefusal(w.db, requestAt(w.db, c.request)!, w.clock)).toEqual({ kind: "void", why: "UI 截图摘要已变" });
    expect(cand(c.id)).toBeNull();
    await silent(c.id);
  });

  test("没有人工请求的分支（合并后转 auto 的 UI 卡，截图门不过）：本卡最新合并意图已 merged + done → 不叫 PM", async () => {
    const c = await manualCard(w, "UD-auto", { ui: true });
    await mergeThrough(c); // UI 卡截图不随 carry 继承（S2W），实际合并的是原 head
    sql("UPDATE task_workflows SET mode = 'auto' WHERE taskId = ?", c.id);
    sql("UPDATE tasks SET extra = json_set(extra, '$.screenshotsDigest', ?), rev = rev + 1 WHERE id = ?", "cd".repeat(32), c.id);
    expect(cand(c.id)).toBeNull();
    sql("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?", `mmq:${c.request}`); // 同一形状但意图不是 done：照原分支提醒
    expect(reasons(c.id)).toEqual(["ui"]);
  });
});

describe("线 2 / 3：真实阻塞仍是候选，原边界不变", () => {
  test("S2W：截图不继承、合并未发出、意图 cancelled → 仍候选（截图门、head 已变）", async () => {
    const c = await s2w(w, null);
    expect(getMergeRun(w.db, c.intent)).toBeNull();
    expect(reasons(c.id)).toEqual(["ui", "head"]);
  });

  test("合并已 merged 但意图仍 submitted（部署在途 / 未结清）：照旧不候选（未结意图），不靠本卡的谓词", async () => {
    const c = await manualCard(w, "UD-open");
    await mergeThrough(c, { carry: NEW, settle: false });
    expect(cand(c.id)).toBeNull();
    await silent(c.id);
  });

  test("旧轮的合并结果不压当前阻塞：merged 之后卡回 review、新 head 第 2 轮再进 merge，旧请求仍是最新请求 → 候选", async () => {
    const c = await manualCard(w, "UD-round");
    await mergeThrough(c);
    const head2 = sha(0xbeef);
    sql("UPDATE tasks SET stage = 'review', round = 2, headSHA = ?, rev = rev + 1 WHERE id = ?", head2, c.id);
    const r2 = await review(c.id, head2);
    expect(reasons(c.id)).toEqual(["head", "round", "review"]);
    // 第 2 轮提交新请求、又被 head 变化作废：最新请求是它，它自己的意图不存在 → 仍候选，旧请求的 merged 不算
    await request(w, c.id, r2);
    sql("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?", sha(0xbef0), c.id);
    expect(cand(c.id)!.request).toBeGreaterThan(c.request);
    expect(reasons(c.id)).toEqual(["unreviewed", "head"]);
  });

  test("merged 后又换了阶段（退 fix 再回 merge，head 不变）：merged 早于最后一次换阶段 → 照原判定", async () => {
    const c = await manualCard(w, "UD-stage");
    await mergeThrough(c, { carry: NEW });
    await ok(w.as(PM, "stage", c.id, "--from", "merge", "--to", "fix"));
    expect(cand(c.id)).toBeNull(); // 不在 merge：原边界
    sql("UPDATE tasks SET stage = 'review', rev = rev + 1 WHERE id = ?", c.id);
    await ok(w.as(PM, "stage", c.id, "--from", "review", "--to", "merge"));
    expect(reasons(c.id)).toContain("head");
  });

  test("规格已变：合并结果绑定的规格不是当前的 → 候选（规格版本已变）", async () => {
    const c = await manualCard(w, "UD-spec");
    await mergeThrough(c, { carry: NEW });
    sql("UPDATE tasks SET specRev = 2, rev = rev + 1 WHERE id = ?", c.id);
    sql("UPDATE task_workflows SET specRev = 2 WHERE taskId = ?", c.id);
    expect(reasons(c.id)).toContain("spec");
  });

  test("结果不明后 PM 人工结清成 done（运行 resolved、回执是人话）：不当 merged，照原判定提醒", async () => {
    const c = await manualCard(w, "UD-resolved");
    const id = `mmq:${c.request}`;
    await ok(S("manual-merge-claim", P, "--mode", "on", "--train", "none", "--required-checks", "ci"));
    const step = (from: string, to: string, ...extra: string[]) =>
      ok(S("scheduler-merge-step", id, "--from", from, "--to", to, "--rev", String(getMergeRun(w.db, id)!.rev), ...extra));
    await step("ready", "await_ci", "--receipt", "等待 CI");
    await step("await_ci", "merging", "--receipt", "CI 全绿：ci");
    await step("merging", "unknown", "--receipt", "GitHub 超时，合并结果不明");
    await ok(w.as(PM, "scheduler-merge-resolve", id, "--outcome", "done", "--receipt", `PR 已合并 ${MERGED}`));
    expect(w.db.query("SELECT status FROM scheduler_intents WHERE id = ?").get(id)).toEqual({ status: "done" });
    expect(getMergeRun(w.db, id)!.phase).toBe("resolved");
    sql("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?", NEW, c.id);
    expect(reasons(c.id)).toContain("head");
  });

  test("矛盾 / 缺失事实不谎称已合并：合并提交与 merged 事件对不上、意图被改成 cancelled、卡 head 已不是合并的 head → 候选", async () => {
    const c = await manualCard(w, "UD-bad");
    const id = await mergeThrough(c, { carry: NEW });
    expect(cand(c.id)).toBeNull();
    sql("UPDATE scheduler_merges SET mergeSha = ? WHERE intentId = ?", sha(0xdead), id);
    expect(reasons(c.id)).toEqual(["head"]);
    sql("UPDATE scheduler_merges SET mergeSha = ? WHERE intentId = ?", MERGED, id);
    sql("UPDATE scheduler_intents SET status = 'cancelled' WHERE id = ?", id);
    expect(reasons(c.id)).toEqual(["head"]);
    sql("UPDATE scheduler_intents SET status = 'done' WHERE id = ?", id);
    expect(cand(c.id)).toBeNull();
    sql("UPDATE tasks SET round = 2, rev = rev + 1 WHERE id = ?", c.id); // 轮次与请求绑定不一致（不经换阶段事件）
    expect(reasons(c.id)).toContain("round");
    sql("UPDATE tasks SET round = 1, rev = rev + 1 WHERE id = ?", c.id);
    expect(cand(c.id)).toBeNull();
    sql("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?", sha(0xbeef), c.id);
    expect(reasons(c.id)).toEqual(["unreviewed", "head"]);
  });

  test("carry 不是调度身份写的（伪造的 review_carry）：链不成立 → 候选", async () => {
    const c = await manualCard(w, "UD-forged");
    // merging 之前追加一条 PM 身份的 review_carry（形状齐全），合并后再把运行与卡的 head 改成它指向的 head
    const id = await mergeThrough(c, { beforeMerging: (intentId) => insertEvent(w.db, { actor: PM, now: w.clock }, { project: P, target: c.id, kind: "scheduler",
      text: "", data: { op: "review_carry", intentId, from: c.head, to: NEW, round: 1, specRev: 1 } }, false) });
    expect(cand(c.id)).toBeNull();
    sql("UPDATE scheduler_merges SET reviewedHead = ? WHERE intentId = ?", NEW, id);
    sql("UPDATE tasks SET headSHA = ?, rev = rev + 1 WHERE id = ?", NEW, c.id);
    expect(reasons(c.id)).toEqual(["unreviewed", "head"]);
  });
});

/** PM 经 `ledger review` 在当前 head 登记跨族审查并进 merge，返回审查事件 seq */
async function review(id: string, head: string) {
  await ok(w.as(PM, "review", id, "--reviewer", "agent-review", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--head", head,
    "--session", `rs-${id}-2`, "--family", "codex", "--findings", findingsFile(), "--path", "r.md", "--to", "merge"));
  return (w.db.query("SELECT MAX(seq) AS s FROM events WHERE target = ? AND kind = 'review'").get(id) as { s: number }).s;
}
const findingsFile = () => { const f = join(w.dir, `f-${Math.random().toString(16).slice(2)}.json`); writeFileSync(f, "[]"); return f; };
