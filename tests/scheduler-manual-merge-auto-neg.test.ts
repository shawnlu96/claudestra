/**
 * merge-arch-MANAUTOQ1 验收线 2：不代排的情况每种一例。manualMergeAuto / manualMergeQueue 都是 on，跑完整自动开卡 tick：不推阶段、不记请求、
 * 不写代排 note 或样本；RVWAKE1 提醒照旧（它此前会提醒的卡，缺省 observe 照样记一条 would；它本来就不提醒的卡照样不提醒）。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createTask } from "../src/lib/ledger-write.js";
import { setWorkflow } from "../src/lib/ledger-scheduler-write.js";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { REQUEST_OP, REVOKE_OP } from "../src/lib/manual-merge-queue-facts.js";
import * as exemption from "../src/lib/manual-merge-review-exemption.js";
import * as poolProof from "../src/lib/pool-review-proof.js";
import { manualMergeReadiness } from "../src/lib/scheduler-manual-merge-ready.js";
import { reviewPmCandidate } from "../src/lib/scheduler-review-pm-wait.js";
import { H1 } from "./scheduler-auto-helpers.js";
import { autoNotes, clearPolicy, manualAs, policy, readyWorld, requests, samples, type AutoWorld } from "./scheduler-manual-merge-auto-kit.test.js";
import { ok, P1ROW, P2ROW, PM, pmEvents } from "./scheduler-review-pm-kit.test.js";

let w: AutoWorld | undefined;
afterEach(() => { w?.close(); w = undefined; clearPolicy(); });

const now = () => w!.f.tickDeps.now!();

/** 判定拒因、跑一轮 tick、零代排；rvwake = RVWAKE1 此刻是否提醒（与本功能无关，照旧） */
async function skipped(why: RegExp, rvwake: boolean, taskId = "T1") {
  const r = manualMergeReadiness(w!.db, taskId, now());
  expect("why" in r ? r.why : "（成立）").toMatch(why);
  const reqs = requests(w!).length, stage = w!.f.task().stage;
  expect(!!reviewPmCandidate(w!.db, "T1", now())).toBe(rvwake);
  expect(await w!.tick()).toEqual([]);
  expect(w!.f.task().stage).toBe(stage);
  expect(requests(w!)).toHaveLength(reqs);
  expect(autoNotes(w!)).toEqual([]);
  expect(samples(w!)).toEqual([]);
  expect(pmEvents(w!.db).map((e) => e.data.kind)).toEqual(rvwake ? ["would"] : []);
}

const bindingOf = (seq: number) => ({ head: H1, specRev: 1, round: 1, uiDigest: null,
  review: { seq, actor: "peer:mate", reviewer: "peer:mate", sessionId: "s", family: "codex", reportPath: "r.md", verdict: "pass" } });
const fileRequest = (seq: number) => insertEvent(w!.db, w!.f.at(PM), { project: "p", target: "T1", kind: "decision", text: "PM 排队",
  data: { op: REQUEST_OP, ...bindingOf(seq), frozen: false } }, false);

describe("[验收线 2] 同家族", () => {
  // 池回执绑定的是派单时的作者家族：改成同族后来源证明先拒。下面把池回执判据桩成成立，只看家族这一道
  const poolOk = () => spyOn(poolProof, "poolReviewRefusal").mockReturnValue(null);

  test("同家族审查（作者也是 codex）：不代排，RVWAKE1 本来就不提醒", async () => {
    w = await readyWorld({ family: "codex" });
    await skipped(/审查来源证明不成立/, false);
    const spy = poolOk();
    try {
      await skipped(/不是跨模型/, false);
    } finally { spy.mockRestore(); }
  });

  test("MANEX1 同族豁免成立（审查门放行）：自动路径仍不认，只走提醒", async () => {
    w = await readyWorld({ family: "codex" });
    const spies = [poolOk(), spyOn(exemption, "manualFamilyRefusal").mockReturnValue(null)];
    try {
      await skipped(/同家族审查/, true);
    } finally { for (const s of spies) s.mockRestore(); }
  });
});

describe("[验收线 2] 审查结论", () => {
  test("verdict changes（只有 P2）：不代排，RVWAKE1 照旧提醒", async () => {
    w = await readyWorld({ verdict: { verdict: "changes", findings: [P2ROW] } });
    await skipped(/不是 pass/, true);
  });

  test("P1>0：不代排", async () => {
    w = await readyWorld({ verdict: { verdict: "changes", findings: [P1ROW] } });
    await skipped(/P0 \/ P1/, false);
  });

  test("有新审查在跑（结论之后又派了审查步骤）：不代排", async () => {
    w = await readyWorld();
    insertEvent(w.db, w.f.at(PM), { project: "p", target: "T1", kind: "step", data: { op: "assign", step: "review", round: 1, executor: "agent-x" } }, false);
    await skipped(/新审查在跑/, false);
  });
});

describe("[验收线 2] hold / sticky", () => {
  test("standing hold（PM 再设 manual 留人工）：不代排，RVWAKE1 照旧提醒", async () => {
    w = await readyWorld();
    await manualAs(w, "runtime_unavailable", "claude", "PM 留人工再看看");
    await skipped(/留在人工/, true);
  });

  for (const code of ["pm_hold", "owner_hold", "pm_takeover", "safety_refusal"]) {
    test(`入 manual 事件带 ${code}：不代排，RVWAKE1 照旧提醒`, async () => {
      w = await readyWorld({ code });
      await skipped(new RegExp(code), true);
    });
  }
});

describe("[验收线 2] 已有请求 / 撤销", () => {
  test("已有活的人工合并请求：不代排", async () => {
    w = await readyWorld();
    fileRequest(w.reviewSeq);
    await skipped(/活的人工合并请求/, true);
  });

  test("同绑定的请求被撤销过：显式停止，不再自动请求", async () => {
    w = await readyWorld();
    const req = fileRequest(w.reviewSeq);
    insertEvent(w.db, w.f.at(PM), { project: "p", target: "T1", kind: "decision", text: "PM 撤销", data: { op: REVOKE_OP, request: req.seq, intent: null } }, false);
    await skipped(/撤销过/, true);
  });
});

describe("[验收线 2] 开关 / UI / peer / feature", () => {
  test("manualMergeQueue 不是 on（observe）：不推到没有消费者的队列", async () => {
    w = await readyWorld({ keys: { manualMergeQueue: "observe" } });
    await skipped(/manualMergeQueue/, true);
  });

  test("ownerVisual 卡没有 owner 批准：跳过，调度器不自己批", async () => {
    w = await readyWorld();
    w.db.run("UPDATE task_workflows SET template = 'ui' WHERE taskId = 'T1'");
    const extra = { ...w.f.task().extra, screenshotsDigest: "d".repeat(64), ownerVisual: true };
    await ok(w.as(PM, "task-set", "T1", "--rev", String(w.f.task().rev), "--extra", JSON.stringify(extra)));
    await skipped(/UI 验收.*owner/, true);
    expect(w.db.query("SELECT COUNT(*) AS n FROM asks WHERE taskId = 'T1'").get()).toEqual({ n: 0 });
  });

  test("peer PR 卡：extra.peerPr 登记的卡不碰", async () => {
    w = await readyWorld();
    w.db.run(`UPDATE tasks SET extra = json_set(extra, '$.peerPr', json('{"peer":"mate","number":7}')) WHERE id = 'T1'`);
    await skipped(/peer PR/, true);
  });

  test("peer PR 卡：卡号 PR<数字> 不碰", async () => {
    w = await readyWorld();
    createTask(w.db, w.f.at("owner"), { project: "p", id: "PR12", title: "peer", kind: "code", agent: "agent-task-one" });
    setWorkflow(w.db, w.f.at("owner"), { taskId: "PR12", taskRev: 1, template: "code", templateVersion: 2, mode: "manual", authorFamily: "claude",
      fallback: "只报错不修", reason: "runtime_unavailable: 测试" });
    w.db.run("UPDATE tasks SET stage = 'review', headSHA = ? WHERE id = 'PR12'", [H1]);
    expect(getWorkflow(w.db, "PR12")?.mode).toBe("manual");
    expect((manualMergeReadiness(w.db, "PR12", now()) as { why: string }).why).toMatch(/peer PR/);
    policy({ manualMergeAuto: "on" });
    await w.tick();
    expect(w.db.query("SELECT stage FROM tasks WHERE id = 'PR12'").get()).toEqual({ stage: "review" });
  });

  test("feature 暂停：不代排，RVWAKE1 照旧提醒", async () => {
    w = await readyWorld();
    w.db.run("UPDATE features SET status = 'paused' WHERE id = ?", [w.fid]);
    await skipped(/暂停/, true);
  });
});
