/**
 * ONB-2 验收 5 / 7 的单卡部分：localMerge 项目的卡进 merge 后，自动 tick 不建合并意图、不占合并槽、不读 PR，只记一条 local_merge_ready
 * 并通知 PM 一次（再跑、重启都不重发）；留下的合并意图交 PM；就绪记录只有调度身份能写；本地项目的 manual-merge-request 被拒并提示
 * local-merge；本地项目的标准答复不提 run 链接。整轮（真实 schedulerPass + 假 GitHub）见 local-merge-pass.test.ts。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { getWorkflow } from "../src/lib/ledger-scheduler.js";
import { listEvents } from "../src/lib/ledger-store.js";
import { standardAnswers } from "../src/lib/order-standard-answers.js";
import { SCHEDULER_CONFIG_PATH } from "../src/lib/scheduler-config.js";
import { schedulerAutoTick } from "../src/lib/scheduler-auto-tick.js";
import { autoFixture, H1, toBuild } from "./scheduler-auto-helpers.js";

async function atMerge() {
  const f = autoFixture();
  await toBuild(f);
  await f.tick();
  await f.cli("agent-task-one", "deliver", "T1", "--from", "build", "--head", H1);
  await f.tick();
  await f.tick();
  await f.review("pass", H1, []);
  expect(await f.tick()).toMatchObject({ step: "stage", detail: "review→merge" });
  const reads: string[] = [], ready: string[][] = [];
  /** One pass of the auto tick for a localMerge project; `fresh` = a restarted service (new deps, same ledger). */
  const local = async () => {
    const r = await schedulerAutoTick(f.db, { p: { maxActiveWorkers: 2, localMerge: true } }, { ...f.tickDeps,
      manager: async (...args) => { if (args[1] === "scheduler-local-merge-ready") ready.push(args); return f.tickDeps.manager(...args); },
      prState: async (ref) => { reads.push(ref); throw new Error("本地项目不该读 PR"); } });
    if (r.failed.length) throw new Error(JSON.stringify(r.failed));
    return r.cards[0];
  };
  const readyEvents = () => listEvents(f.db, { project: "p", target: "T1" }).filter((e) => e.data.op === "local_merge_ready");
  const mergeIntents = () => f.intents().filter((i) => i.action === "merge");
  return { f, local, reads, ready, readyEvents, mergeIntents };
}

describe("ONB-2 自动 tick：本地项目停在 merge 等 PM", () => {
  test("记一条 local_merge_ready、通知 PM 一次；再跑和重启都不重发；不建合并意图、不占槽、不读 PR", async () => {
    const h = await atMerge(), { f } = h;
    try {
      const notices = f.notices.length;
      expect(await h.local()).toMatchObject({ step: "local_ready", detail: `审查通过，等 PM 跑 ledger local-merge T1 --head ${H1}` });
      expect(h.readyEvents()).toMatchObject([{ actor: "scheduler", kind: "scheduler", data: { op: "local_merge_ready", head: H1 } }]);
      expect(f.notices.slice(notices)).toEqual([`[调度引擎] T1 审查通过，等 PM 跑 ledger local-merge T1 --head ${H1}（本地合并项目，没有 PR）`]);
      for (let i = 0; i < 3; i++) expect(await h.local()).toMatchObject({ step: "waiting" });
      expect(h.ready).toHaveLength(1); // a waiting card reads the ledger only: no CLI call per pass
      expect(f.notices.length).toBe(notices + 1);
      expect(h.readyEvents()).toHaveLength(1);
      // the CLI itself is idempotent per stay in merge and head (a restart that raced the ledger read)
      expect(await f.tickDeps.manager("ledger", "scheduler-local-merge-ready", "T1", "--head", H1)).toMatchObject({ ok: true, duplicate: true });
      expect(h.reads).toEqual([]);
      expect(h.mergeIntents()).toEqual([]);
      expect(f.db.query("SELECT * FROM scheduler_resources WHERE resource = 'merge:p'").all()).toEqual([]);
      expect(f.task().stage).toBe("merge");
      expect(getWorkflow(f.db, "T1")?.mode).toBe("auto");
    } finally { f.close(); }
  });

  test("切到本地合并前留下的合并意图不执行，交 PM", async () => {
    const h = await atMerge(), { f } = h;
    try {
      const t = f.task();
      f.db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
        VALUES ('m-old','T1','p','merge_deploy','merge',1,99999,?,1,?,2,'pending','merge',1,1)`).run(t.rev, H1);
      expect(await h.local()).toMatchObject({ step: "manual", detail: expect.stringContaining("本地合并（localMerge），不执行合并意图 m-old") });
      expect(getWorkflow(f.db, "T1")?.mode).toBe("manual");
      expect(h.readyEvents()).toEqual([]);
    } finally { f.close(); }
  });

  test("就绪记录只由调度身份写；调度身份跑不了 local-merge", async () => {
    const h = await atMerge(), { f } = h;
    try {
      expect(await f.cli("pm", "scheduler-local-merge-ready", "T1", "--head", H1)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.cli("scheduler", "local-merge", "T1", "--head", H1)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await f.tickDeps.manager("ledger", "scheduler-local-merge-ready", "T1", "--head", "2".repeat(40))).toMatchObject({ ok: false, code: "conflict" });
      expect(h.readyEvents()).toEqual([]);
    } finally { f.close(); }
  });
});

describe("ONB-2 验收 7：本地项目的 manual-merge-request 被拒", () => {
  afterEach(() => rmSync(SCHEDULER_CONFIG_PATH, { force: true }));
  test("拒绝并提示改用 local-merge；非本地项目不受影响（照旧走到流程检查）", async () => {
    const h = await atMerge(), { f } = h;
    try {
      const review = listEvents(f.db, { project: "p", target: "T1" }).findLast((e) => e.kind === "review")!;
      const t = f.task();
      const request = () => f.cli("pm", "manual-merge-request", "T1", "--head", H1, "--spec-rev", String(t.specRev), "--round", String(t.round),
        "--review-seq", String(review.seq), "--reason", "试排");
      const cfg = (localMerge: boolean) => writeFileSync(SCHEDULER_CONFIG_PATH, JSON.stringify({ enabled: true, autoDispatch: true,
        projects: { p: { maxActiveWorkers: 2, requiredChecks: ["true"], repoDir: "/tmp/p", ...(localMerge ? { localMerge: true } : {}) } } }));
      cfg(true);
      expect(await request()).toMatchObject({ ok: false, code: "conflict", error: expect.stringMatching(/本地合并（localMerge）.*改用 ledger local-merge/) });
      cfg(false);
      expect(await request()).toMatchObject({ ok: false, error: expect.stringContaining("不是 manual") });
    } finally { f.close(); }
  });
});

describe("ONB-2：本地项目执行者的标准答复不提 run 链接", () => {
  test("本地项目：失败的检查和复现方法写进证据；非本地逐字不变", () => {
    const local = standardAnswers("author", undefined, ["cargo test"]);
    expect(local).toContain("- 范围外测试红：不推空提交，在证据报告里列明失败的检查和复现方法，由 PM 本地合并时核对");
    expect(local).not.toMatch(/run 链接|合并闸处理/);
    expect(standardAnswers("author")).toContain("- 范围外测试红：不推空提交，交付说明写明并附 run 链接，由合并闸处理");
    expect(standardAnswers("review", undefined, ["cargo test"])).not.toContain("范围外测试红");
  });
});
