/**
 * dispatch-recovery-MQWAKE2：合并已实际结清、只差 PM 部署收口的卡不再被误报「旧请求失效、重提请求」。UISDEL1 形状（请求 66521 → 正规 carry
 * 到新 head → 运行 merged 带合并提交 → 意图 done，卡仍在 merge）在 MQWAKE1 夹具（临时台账 + 只读 LedgerReader + 进程内正规 ledger CLI）上
 * 全程走正规命令：manual-merge-request / manual-merge-claim / scheduler-merge-step / scheduler-settle。合并回执是合成的，不碰 GitHub。
 * 线 1：旧谓词（requestRefusal 不带 run）判 head 已变 = 原误报来源；新候选 null，observe / on 调度 tick 与窄 CLI 事务重核都零写零发。
 * 线 2 / 3：已部署 / 原 head 合并不提示；S2W、旧请求 / 旧轮的合并、规格已变、resolved 人工结清、矛盾事实、submitted 照原边界。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { requestAt, requestRefusal } from "../src/lib/manual-merge-queue-facts.js";
import { RECOVERY_POLICY_PATH } from "../src/lib/recovery-policy.js";
import { carryChainSuffix } from "../src/lib/review-main-carry-manual-auto.js";
import { carryReceipt, getMergeRun } from "../src/lib/scheduler-merge.js";
import { mergePmCandidate } from "../src/lib/scheduler-merge-pm-wait.js";
import { getTask } from "../src/lib/ledger-store.js";
import { writePolicy } from "./manual-merge-queue-world.test.js";
import { business, DIGEST, FPM, manualCard, mergeCard, ok, P, PM, pmEvents, request, s2w, setFeaturePm, setMode, sha, world, type World } from "./scheduler-merge-pm-kit.test.js";

const MAIN = sha(0x3a1), MERGED = sha(0xa541), NEW = sha(0xc242);
let w: World;
beforeEach(() => { w = world(); writePolicy("on"); });
afterEach(() => { w.close(); rmSync(RECOVERY_POLICY_PATH, { force: true }); });

const S = (...a: string[]) => w.as("scheduler", ...a);
type Card = { id: string; head: string; request: number };

/** 正规合并运行：claim（同事务 begin）→ [update-branch + carry 到 newHead] → await_ci → merging → merged；settle = 意图结成 done（不自动部署） */
async function mergeThrough(c: Card, o: { carry?: string; settle?: boolean; mergeSha?: string } = {}) {
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
