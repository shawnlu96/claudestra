/**
 * CINOOP1 · noChange 的接收与恢复事务（lib/ci-no-change-recovery.ts）：资格（同 head ci_fail 退回、原审查仍放行、一次上限）、外部证据
 * （原 run 日志 × PR 改动、同 head 最新 required CI）、事务（CAS、结算失败零写入、幂等）、策略 on / observe / off，以及 MAINRED1 已解决的取消。
 * 台账是内存库；外部 CI、审查判定与时钟都是注入的假口，不碰网络。
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitNoChange, deliverNoChangeLocal, orderSnapshotProblem, type NoChangeBinding, type NoChangeDeps } from "../src/lib/ci-no-change-recovery.js";
import type { CheckRow, CiNoChangePort, RunRead } from "../src/lib/ci-no-change-evidence.js";
import { ciGreen, dependencyImpact, failureFilesMatch } from "../src/lib/ci-no-change-evidence.js";
import { deliverOrder } from "../src/lib/order-deliver.js";
import { listSteps } from "../src/lib/ledger-steps.js";
import { closeLedger, getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { createTask, moveStage, setMeta, setTask } from "../src/lib/ledger-write.js";
import type { MainRedRun } from "../src/lib/main-red-fix.js";
import type { NoChange } from "../src/lib/order-no-change.js";
import type { RecoveryMode, RecoveryPolicy } from "../src/lib/recovery-policy.js";
import type { ReviewFacts } from "../src/lib/scheduler-review.js";

const P = "claude-orchestrator";
const H = "a".repeat(40), M = "b".repeat(40), M2 = "c".repeat(40);
const REPO = "o/r", PR = `https://github.com/${REPO}/pull/12`, RUN = `https://github.com/${REPO}/actions/runs/555`;
const OWNER = { actor: "owner", now: 1_000 };
const NOW = 5_000;

const SHARD = "test shard 2 of 4";
const failedLog = (file: string) => [`##[group]${file}:`, "error: expect(received).toBe(expected)", "(fail) race > case [0.40ms]", "##[endgroup]", " 1 fail",
  "##[error]Process completed with exit code 1."].map((l) => `${SHARD}\tUnit tests\t2026-10-16T09:00:00.1234567Z ${l}`).join("\n");

let db: Database;
let mode: RecoveryMode;
let checks: CheckRow[] | Error;
let run: RunRead;
let prFiles: string[];
let mainHead: string;
let mainRuns: MainRedRun[];
let onRead: (() => void) | null;
let reviewProof: NoChangeDeps["reviewProof"];
let reviewSeq: number;
let files: Record<string, string>;

const green = (): CheckRow[] => [{ name: "test", status: "completed", conclusion: "success" }, { name: "guard", status: "completed", conclusion: "success" }];
const port: CiNoChangePort = {
  headChecks: async () => { onRead?.(); if (checks instanceof Error) throw checks; return checks; },
  run: async () => run,
  prFiles: async () => prFiles,
  mainHead: async () => { onRead?.(); return mainHead; },
  mainRuns: async () => mainRuns,
  tree: async () => Object.keys(files),
  fileText: async (_r, _h, f) => { if (!(f in files)) throw new Error(`没有 ${f}`); return files[f]!; },
};
const policy = (): RecoveryPolicy => ({ mode, manualAfterMs: null, source: "config" });
const deps = (): Partial<NoChangeDeps> => ({ port, policy, reviewProof });
const OOS: NoChange = { kind: "out_of_scope_ci", reason: "范围外时序波动，和本卡改动无关", run: RUN, files: ["tests/flaky.test.ts"] };

const events = (target = "T1") => listEvents(db, { project: P, target });
const ORDER: Record<string, string> = { T1: "fx1", T2: "w2" };
const deliverLocal = (nc: NoChange = OOS, more: Record<string, string> = {}, target = "T1", actor = "agent-dev") =>
  deliverNoChangeLocal(db, { actor, now: NOW }, getTask(db, target)!, { "no-change": JSON.stringify(nc), head: H, evidence: "e.md", order: ORDER[target]!, ...more },
    () => NOW, deps());
const STEP = { step: "fix" as const, round: 1, executor: "agent-dev" };
const reject = async (p: Promise<unknown>, code: string, re?: RegExp) => {
  const e = await p.then(() => null, (x: { message: string; current?: { lend?: string } }) => x);
  expect(e?.current?.lend).toBe(code);
  if (re) expect(e!.message).toMatch(re);
};

function bounce(cause = "ci_fail", intentId = "mi1"): void {
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,'T1',?,'merge','merge',1,0,1,1,?,1,'cancelled','merge',1,1)`).run(intentId, P, H);
  db.query(`INSERT INTO scheduler_merges (intentId,taskId,project,prRef,expectedBranch,reviewedHead,requiredChecks,phase,createdAt,updatedAt)
    VALUES (?,'T1',?,?,'b',?,'test,guard','resolved',1,1)`).run(intentId, P, PR, H);
  const mergeBounce = { cause, prHead: H, mainHead: cause === "conflict" ? M : null, checks: cause === "ci_fail" ? [{ name: "test", link: `${RUN}/job/9` }] : [] };
  insertEvent(db, { actor: "scheduler", now: 2_000 }, { project: P, target: "T1", kind: "stage", text: "退回", data: { from: "merge", to: "fix", round: 1, specRev: 1, head: H, mergeBounce } }, false);
  insertEvent(db, { actor: "scheduler", now: 2_000 }, { project: P, target: "T1", kind: "scheduler", text: "退回",
    data: { op: "merge_conflict", intentId, cause, prHead: H, mainHead: null, checks: mergeBounce.checks, count: 1, escalated: false } }, false);
  db.run("UPDATE tasks SET stage = 'fix' WHERE id = 'T1'");
  db.query("INSERT OR REPLACE INTO task_steps (taskId,step,round,executor,executorKind,state,createdAt,updatedAt) VALUES ('T1','fix',1,'agent-dev','agent','assigned',1,1)").run();
}

/** 调度派单：意图行 + 同笔的 plan 事件（ledger-scheduler-write.ts 的形状，本机单的原始快照） */
function dispatch(taskId: string, node: "write" | "fix", id: string, head: string | null, round: number, now = 2_100): void {
  const seq = insertEvent(db, { actor: "scheduler", now, dedupKey: `scheduler:${id}` }, { project: P, target: taskId, kind: "scheduler", text: "派单",
    data: { op: "plan", id, node, action: "dispatch", recipient: "agent-dev", specRev: 1, round, head } }, true).seq;
  db.query(`INSERT INTO scheduler_intents (id,taskId,project,node,action,recipient,causalSeq,eventSeq,taskRev,specRev,head,templateVersion,status,reason,createdAt,updatedAt)
    VALUES (?,?,?,?,'dispatch','agent-dev',1,?,1,1,?,1,'submitted','dispatch',1,1)`).run(id, taskId, P, node, seq, head);
}

beforeEach(() => {
  db = openLedger(":memory:");
  mode = "on"; checks = green(); prFiles = ["src/lib/x.ts"]; onRead = null; mainHead = M;
  files = { "tests/flaky.test.ts": 'import { y } from "../src/lib/y.js";', "src/lib/y.ts": 'export const y = 1; import "./z";', "src/lib/z.ts": "", "src/lib/x.ts": "" };
  run = { headSha: H, attempt: 1, status: "completed", conclusion: "failure", log: failedLog("tests/flaky.test.ts") };
  mainRuns = [{ id: 900, attempt: 1, status: "completed", conclusion: "success", headSha: M, url: `https://github.com/${REPO}/actions/runs/900`, createdAt: 3 },
    { id: 800, attempt: 1, status: "completed", conclusion: "failure", headSha: M2, url: `https://github.com/${REPO}/actions/runs/800`, createdAt: 2 }];
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: P, id: "T1", title: "T1", kind: "code", agent: "agent-dev" } as never);
  db.query("UPDATE tasks SET stage = 'merge', round = 1, headSHA = ?, pr = ? WHERE id = 'T1'").run(H, PR);
  db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
    VALUES ('T1',?,'code',1,'auto','claude','x',1,1,1,1)`).run(P);
  reviewSeq = insertEvent(db, { actor: "agent-rev", now: 1_500 }, { project: P, target: "T1", kind: "review", text: "pass",
    data: { round: 1, head: H, verdict: "pass", p0: 0, p1: 0, p2: 1 } }, false).seq;
  reviewProof = (_db, task) => ({ eventSeq: reviewSeq, round: task.round, head: H, verdict: "pass", reviewer: "agent-rev", reviewerSessionId: "s",
    reviewerFamily: "codex", reportPath: "r.md", findings: [{ findingId: "p2-1", family: "style", severity: "P2", probe: "x" }] } as ReviewFacts);
  bounce();
  dispatch("T1", "fix", "fx1", H, 1);
});
afterEach(() => closeLedger(":memory:"));

describe("证据判定（纯）", () => {
  test("required 全 success 才绿；缺项 / 跑着 / 红 / 取消 / 没清单都不是", () => {
    expect(ciGreen(green(), ["test", "guard"])).toEqual({ green: true });
    expect(ciGreen(green(), ["test", "web"])).toMatchObject({ green: false, why: expect.stringMatching(/缺项/) });
    expect(ciGreen([{ name: "test", status: "in_progress", conclusion: null }], ["test"])).toMatchObject({ green: false, why: expect.stringMatching(/还在跑/) });
    expect(ciGreen([{ name: "test", status: "completed", conclusion: "failure" }], ["test"]).green).toBe(false);
    expect(ciGreen([{ name: "test", status: "completed", conclusion: "cancelled" }], ["test"])).toMatchObject({ why: expect.stringMatching(/取消/) });
    expect(ciGreen(green(), []).green).toBe(false);
  });
  test("失败文件要与原 run 日志逐个相等，且不在 PR 改动里", () => {
    expect(failureFilesMatch(["tests/flaky.test.ts"], failedLog("tests/flaky.test.ts"), ["src/lib/x.ts"])).toEqual({ ok: true });
    expect(failureFilesMatch(["tests/other.test.ts"], failedLog("tests/flaky.test.ts"), [])).toMatchObject({ ok: false });
    expect(failureFilesMatch(["tests/flaky.test.ts"], failedLog("tests/flaky.test.ts"), ["tests/flaky.test.ts"])).toMatchObject({ ok: false, why: expect.stringMatching(/code/) });
  });
});

describe("out_of_scope_ci：同轮恢复", () => {
  test("全绿：一笔里记 noChange 交付、fix→merge（轮次 / 规格 / head 不变）、引用原审查与退回、结算修复步骤；重放返回原结果", async () => {
    const before = events().length;
    const r = await deliverLocal();
    expect(r).toMatchObject({ ok: true, duplicate: false, noChange: { outcome: "recovered" } });
    expect(getTask(db, "T1")).toMatchObject({ stage: "merge", round: 1, specRev: 1, headSHA: H });
    const fresh = events().slice(before);
    const stage = fresh.find((e) => e.kind === "stage")!;
    expect(stage.data).toMatchObject({ from: "fix", to: "merge", round: 1, head: H,
      noChangeRecovery: { reviewSeq, files: ["tests/flaky.test.ts"], runId: 555, attempt: 1, required: ["test", "guard"], count: 1 } });
    expect(fresh.find((e) => e.kind === "deliver")!.data).toMatchObject({ headSHA: H, noChange: OOS, round: 1 });
    expect(fresh.filter((e) => e.kind === "review")).toEqual([]); // 不造新审查
    expect(listSteps(db, "T1").find((s) => s.step === "fix")).toMatchObject({ state: "delivered", headFrom: H, headTo: H });
    const n = events().length;
    expect(await deliverLocal()).toMatchObject({ ok: true, duplicate: true, noChange: { outcome: "recovered" } });
    expect(events().length).toBe(n);
    await reject(deliverLocal({ ...OOS, reason: "换了个理由" }), "conflict", /另一份/);
    expect(events().length).toBe(n);
  });

  test("同 head / 规格只成功恢复一次：再次 CI 退回后（新订单、重启都一样）交 PM，退回累计不清零", async () => {
    await deliverLocal();
    bounce("ci_fail", "mi2");
    const t = getTask(db, "T1")!;
    const binding: NoChangeBinding = { orderId: "lend:T1:s0:r1:a1", taskId: "T1", head: H, start: H, step: STEP, specRev: 1, round: 1, repo: REPO, evidence: "e",
      recheck: () => {} };
    await reject(admitNoChange(db, { actor: "x", now: NOW }, binding, OOS, { ...deps(), port, now: () => NOW } as NoChangeDeps, () => 1), "conflict", /恢复过一次/);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix", rev: t.rev });
    expect(events().filter((e) => e.kind === "scheduler" && e.data.op === "merge_conflict").length).toBe(2);
  });

  test("CI 最新红 / 没跑完 / 缺 required / 读不到：unavailable，不推阶段、不加轮次、不记交付", async () => {
    const cases: (CheckRow[] | Error)[] = [[{ name: "test", status: "completed", conclusion: "failure" }, green()[1]!],
      [{ name: "test", status: "queued", conclusion: null }, green()[1]!], [green()[0]!], new Error("gh 503")];
    for (const c of cases) {
      checks = c;
      const n = events().length;
      await reject(deliverLocal(), "unavailable", /未恢复/);
      expect(events().length).toBe(n);
      expect(getTask(db, "T1")).toMatchObject({ stage: "fix", round: 1 });
    }
  });

  test("拒：没带理由、退回不是 ci_fail、原审查失效 / 不是原轮退回前那份、run 不是退回那个、失败文件对不上、换了 head", async () => {
    await reject(deliverLocal({ ...OOS, reason: " " }).catch((e) => { throw { message: e.message, current: { lend: "invalid" } }; }), "invalid", /理由/);
    reviewProof = () => { throw new Error("当前 head 缺同卡跨模型审查通过结论或仍有 P0/P1"); };
    await reject(deliverLocal(), "invalid", /原审查已不能放行/);
    reviewProof = (_d, task) => ({ eventSeq: 10_000, round: task.round, head: H } as ReviewFacts);
    await reject(deliverLocal(), "invalid", /退回之前/);
    reviewProof = (_d, task) => ({ eventSeq: reviewSeq, round: task.round, head: H } as ReviewFacts);
    await reject(deliverLocal({ ...OOS, run: `https://github.com/${REPO}/actions/runs/777` }), "invalid", /退回回执/);
    await reject(deliverLocal({ ...OOS, files: ["tests/other.test.ts"] }), "invalid", /不一致/);
    prFiles = ["tests/flaky.test.ts"];
    await reject(deliverLocal(), "invalid", /code/);
    prFiles = ["src/lib/x.ts"];
    run = { ...run, headSha: M };
    await reject(deliverLocal(), "invalid", /不是交付 head/);
    const err = await deliverLocal(OOS, { head: M }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/订单起点|当前 head/);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix", round: 1 });
  });

  test("拒：最近的退回不是 CI 失败（冲突）", async () => {
    bounce("conflict", "mi3");
    dispatch("T1", "fix", "fx3", H, 1);
    await reject(deliverLocal(OOS, { order: "fx3" }), "invalid", /ci_fail/);
  });

  test("拒：退回之后已有别的交付；卡转 manual；有结果未知的调度意图", async () => {
    insertEvent(db, { actor: "agent-dev", now: 3_000 }, { project: P, target: "T1", kind: "deliver", data: { headSHA: H } }, false);
    await reject(deliverLocal(), "invalid", /别的deliver/);
    db.run("UPDATE task_workflows SET mode = 'manual' WHERE taskId = 'T1'");
    await reject(deliverLocal(), "invalid", /manual/);
    db.run("UPDATE task_workflows SET mode = 'auto' WHERE taskId = 'T1'");
    db.run("UPDATE scheduler_intents SET status = 'unknown' WHERE id = 'mi1'");
    await reject(deliverLocal(), "invalid", /结果未知/);
  });

  test("CAS：查外部证据期间卡被改（rev）→ 整笔拒、零写入；事务里结算（签回执）失败 → 整笔回滚", async () => {
    onRead = () => db.run("UPDATE tasks SET rev = rev + 1 WHERE id = 'T1'");
    const n = events().length;
    await reject(deliverLocal(), "unavailable", /被改过/);
    expect(events().length).toBe(n);
    onRead = null;
    const b: NoChangeBinding = { orderId: "lend:T1:s0:r1:a0", taskId: "T1", head: H, start: H, step: STEP, specRev: 1, round: 1, repo: REPO, evidence: "e",
      recheck: () => {} };
    const fail = admitNoChange(db, { actor: "x", now: NOW }, b, OOS, { port, policy, reviewProof, now: () => NOW }, () => { throw new Error("签不了回执"); });
    expect(await fail.then(() => null, (e: Error) => e.message)).toBe("签不了回执");
    expect(events().length).toBe(n);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
    expect(listSteps(db, "T1").find((s) => s.step === "fix")).toMatchObject({ state: "assigned" });
    const lease = admitNoChange(db, { actor: "x", now: NOW }, { ...b, recheck: () => { throw Object.assign(new Error("租约已过期"), { current: { lend: "lease_expired" } }); } },
      OOS, { port, policy, reviewProof, now: () => NOW }, () => 1);
    await reject(lease, "lease_expired");
    expect(events().length).toBe(n);
  });

  test("策略：off 不收、不留痕；observe 只记一条拟动作（去重），不推阶段；普通 stage fix→merge 仍拒", async () => {
    mode = "off";
    const n = events().length;
    await reject(deliverLocal(), "invalid", /off/);
    expect(events().length).toBe(n);
    mode = "observe";
    await reject(deliverLocal(), "unavailable", /observe/);
    await reject(deliverLocal(), "unavailable", /observe/);
    const notes = listEvents(db, { project: P }).filter((e) => e.data.op === "recovery_observe" && e.data.mechanism === "ciNoChangeRecovery");
    expect(notes.length).toBe(1);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix", round: 1 });
    expect(() => moveStage(db, { actor: "agent-pm", now: NOW }, { taskId: "T1", from: "fix", to: "merge" })).toThrow();
  });

  test("r1-P1 dependency-proof：导入闭包碰到 PR 改动 / 改了全局输入 / 依赖里提到改动文件名 / 闭包读不到 → 不恢复", async () => {
    const n = events().length;
    prFiles = ["src/lib/z.ts"]; // 测试 → y.ts → z.ts
    await reject(deliverLocal(), "invalid", /导入闭包包含 PR 改动的 src\/lib\/z\.ts/);
    prFiles = ["package.json"];
    await reject(deliverLocal(), "invalid", /全局输入/);
    prFiles = ["src/manager.ts"];
    files = { ...files, "src/manager.ts": "", "src/lib/z.ts": 'spawn(["bun", join(SRC, "manager.ts")]);' };
    await reject(deliverLocal(), "invalid", /提到了 PR 改动的 src\/manager\.ts/);
    prFiles = ["src/lib/x.ts"];
    files = { ...files, "src/lib/z.ts": "" };
    expect(events().length).toBe(n);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
    const broken: CiNoChangePort = { ...port, fileText: async () => { throw new Error("gh 502"); } };
    expect(await dependencyImpact(broken, REPO, H, ["tests/flaky.test.ts"], ["src/lib/x.ts"])).toMatchObject({ ok: false, code: "unavailable" });
    expect(await dependencyImpact(port, REPO, H, ["tests/flaky.test.ts"], ["src/lib/x.ts"])).toEqual({ ok: true, facts: { reached: 3 } });
  });

  test("r2-P1 dependency-proof：tsconfig 别名 @/* 解析进闭包；解析不了的说明符 / 非字面量动态导入 / 没声明的包 → 拒；内置模块与声明的包放行", async () => {
    const T = "tests/flaky.test.ts", impact = (changed = ["web/lib/changed.ts"]) => dependencyImpact(port, REPO, H, [T], changed);
    files = { [T]: 'import { h } from "@/lib/helper";', "web/lib/helper.ts": 'export { c } from "./changed";', "web/lib/changed.ts": "" };
    expect(await impact()).toMatchObject({ ok: false, code: "invalid", why: expect.stringMatching(/导入闭包包含 PR 改动的 web\/lib\/changed\.ts/) });
    prFiles = ["web/lib/changed.ts"];
    await reject(deliverLocal(), "invalid", /web\/lib\/changed\.ts/);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
    const pkg = JSON.stringify({ devDependencies: { "@types/bun": "1" } }), web = JSON.stringify({ dependencies: { react: "19", postcss: "8" } });
    for (const [src, re] of [['import x from "~/lib/q";', /~\/lib\/q.*解析不了/], ['import p from "left-pad";', /left-pad.*解析不了/],
      ["const m = await import(path);", /动态/], ['import { q } from "./missing";', /\.\/missing.*解析不了/]] as const) {
      files = { [T]: src, "package.json": pkg, "web/package.json": web, "src/lib/x.ts": "" };
      expect(await impact(["src/lib/x.ts"])).toMatchObject({ ok: false, code: "invalid", why: expect.stringMatching(re) });
    }
    files = { [T]: 'import { a } from "node:fs"; import "bun:test"; import { useState } from "react"; import p from "../web/node_modules/postcss/lib/postcss";' +
      ' import t from "@types/bun"; import { h } from "@/lib/helper";', "web/lib/helper.ts": "export const h = 1;", "package.json": pkg, "web/package.json": web, "src/lib/x.ts": "" };
    expect(await impact(["src/lib/x.ts"])).toEqual({ ok: true, facts: { reached: 2 } });
  });

  test("r1-P1 local-nochange-unbound：没有待交的修复步骤 / 单号不对 / 会话不是绑定的那个 → 拒，零写入", async () => {
    const n = events().length;
    await reject(deliverLocal(OOS, { order: "T1:fix:r2" }), "invalid", /当前的单/);
    db.run(`INSERT INTO scheduler_sessions (taskId,role,agent,sessionId,family,transport,state,createIntentId,createdAt,updatedAt)
      VALUES ('T1','author','agent-dev','s-1','claude','acp','active','mi1',1,1)`);
    await reject(deliverLocal(OOS), "invalid", /当前的单/); // 绑了会话却不报会话
    await reject(deliverLocal(OOS, { session: "s-2" }), "invalid", /当前的单/);
    db.run("DELETE FROM scheduler_sessions");
    db.run("DELETE FROM task_steps WHERE taskId = 'T1'");
    await reject(deliverLocal(), "invalid", /待交的步骤/);
    expect(events().length).toBe(n);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
  });

  test("r1-P1 local-nochange-unbound：查外部证据期间步骤被删 → 事务里重核拒，零写入", async () => {
    onRead = () => db.run("DELETE FROM task_steps WHERE taskId = 'T1'");
    const n = events().length;
    await reject(deliverLocal(), "invalid", /待交的步骤/);
    expect(events().length).toBe(n);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
  });

  test("r1-P1 mcp-replay：MCP deliver 成功后同单同份重试回原回执（不碰 CLI）；换理由拒", async () => {
    const r = await deliverLocal();
    const call = { agent: "agent-dev", sessionId: null, family: "claude-code", channelId: "c1" };
    const dd = { db, remoteHead: async () => { throw new Error("不该查"); }, findPr: async () => { throw new Error("不该查"); },
      run: async () => { throw new Error("不该跑 CLI"); } } as never;
    const wire = (nc: NoChange) => ({ v: 1, orderId: ORDER.T1, head: H, evidence: "e.md", summary: "无需改码", selfCheck: "自查", noChange: nc });
    expect(await deliverOrder(call, wire(OOS), dd)).toMatchObject({ ok: true, duplicate: true, taskId: "T1", noChange: { outcome: "recovered", eventSeq: r.eventSeq } });
    expect(await deliverOrder(call, wire({ ...OOS, reason: "换了" }), dd)).toMatchObject({ ok: false, code: "dedup_conflict" });
    expect(await deliverOrder({ ...call, agent: "agent-x" }, wire(OOS), dd)).toMatchObject({ ok: false, code: "dedup_conflict" });
  });

  test("r3-P1 local-nochange-unbound-order：派单后经 setTask 改规格指针 / 文件范围（specRev 不变）→ 拒，零写入", async () => {
    for (const [i, patch] of [{ spec: "different-spec.md" }, { extra: { fileGlobs: ["src/other.ts"] } }].entries()) {
      db.run("DELETE FROM scheduler_intents WHERE taskId = 'T1' AND action = 'dispatch'");
      dispatch("T1", "fix", `fm${i}`, H, 1, 2_100 + i * 200); // 第二轮重新派单：前一轮的改动在派单之前，只算这一轮之后的
      setTask(db, { actor: "agent-pm", now: 2_150 + i * 200 }, { id: "T1", rev: getTask(db, "T1")!.rev, patch } as never);
      expect(getTask(db, "T1")).toMatchObject({ specRev: 1 });
      const before = events().length;
      await reject(deliverLocal(OOS, { order: `fm${i}` }), "invalid", /改过规格指针/);
      expect(events().length).toBe(before);
      expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
    }
  });

  test("r3-P1 local-nochange-unbound-order：规格文件原字节在派单之后被写过 → 拒；派单前写好、之后没动 → 收", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cinoop1-spec-"));
    try {
      mkdirSync(join(dir, "tasks"));
      setMeta(db, OWNER, { project: P, key: "docsDir", value: dir });
      const spec = join(dir, "tasks", "T1.md");
      writeFileSync(spec, "# 原规格\n");
      utimesSync(spec, 1, 1); // mtime 改回去也瞒不过 ctime
      const written = statSync(spec).ctimeMs;
      db.run("DELETE FROM scheduler_intents WHERE id = 'fx1'");
      dispatch("T1", "fix", "fx2", H, 1, written - 1); // 派单在写文件之前：材料在派单后变过
      await reject(deliverLocal(OOS, { order: "fx2" }), "invalid", /派单之后被写过/);
      expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
      db.run("DELETE FROM scheduler_intents WHERE id = 'fx2'");
      dispatch("T1", "fix", "fx3", H, 1, written + 1); // 派单在写文件之后、之后没动
      expect(await deliverLocal(OOS, { order: "fx3" })).toMatchObject({ ok: true, noChange: { outcome: "recovered" } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("规格材料：订单原文摘要变了、持单期间有规格追加 → 不一致", () => {
    const text = "规格原文";
    const sha = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(orderSnapshotProblem(db, { orderId: "o1", text, sha256: sha })).toBeNull();
    expect(orderSnapshotProblem(db, { orderId: "o1", text: "改过", sha256: sha })).toMatch(/摘要/);
    db.query(`INSERT INTO lend_relays (key,orderId,taskId,project,kind,target,text,state,reason,tries,createdAt,updatedAt)
      VALUES ('o1:spec','o1','T1',?,'spec','w','追加','sent',NULL,0,1,1)`).run(P);
    expect(orderSnapshotProblem(db, { orderId: "o1", text, sha256: sha })).toMatch(/追加/);
  });
});

describe("main_already_resolved：MAINRED1 已解决的卡取消", () => {
  const MR: NoChange = { kind: "main_already_resolved", reason: "main 已被别的提交修好", sourceRun: `https://github.com/${REPO}/actions/runs/800`, mainHead: M,
    mainRun: `https://github.com/${REPO}/actions/runs/900` };
  function mainCard(withSource = true, start: string | null = H): void {
    createTask(db, OWNER, { project: P, id: "T2", title: "T2", kind: "code", agent: "agent-dev" } as never);
    db.query("INSERT INTO features (id,project,title,status,currentVersion,createdBy,createdAt,updatedAt) VALUES ('F1',?,'merge','active',1,'owner',1,1)").run(P);
    db.query("UPDATE tasks SET stage = 'build', round = 0, featureId = 'F1', headSHA = ?, extra = ? WHERE id = 'T2'").run(start, JSON.stringify({ repo: REPO }));
    db.query(`INSERT INTO task_workflows (taskId,project,template,templateVersion,mode,authorFamily,fallback,specRev,rev,createdAt,updatedAt)
      VALUES ('T2',?,'code',1,'auto','claude','x',1,1,1,1)`).run(P);
    db.query("INSERT INTO dag_versions (featureId,version,reasonKind,proposedBy,createdAt,nodes) VALUES ('F1',1,'initial','owner',1,?)")
      .run(JSON.stringify([{ key: "main-red-ci", taskId: "T2" }]));
    dispatch("T2", "write", "w2", start, 0);
    db.query("INSERT INTO task_steps (taskId,step,round,executor,executorKind,state,createdAt,updatedAt) VALUES ('T2','write',0,'agent-dev','agent','assigned',1,1)").run();
    insertEvent(db, { actor: "scheduler", now: 1_000 }, { project: P, target: "", kind: "scheduler", text: "main 红",
      data: { op: "main_red_fix_node", source: withSource ? "mainRedFix" : "pm", workflow: "push", checks: "[]", featureId: "F1", key: "main-red-ci", taskId: "T2",
        faultKey: null, runId: 800, mainSha: M2 } }, true);
  }
  const resolve = (nc: NoChange = MR) => deliverLocal(nc, {}, "T2");

  test("真实来源 + 当前 main 同 workflow 最新 run 绿：原子取消卡、结算步骤与意图、记证据；不进 review / merge", async () => {
    mainCard();
    expect(await resolve()).toMatchObject({ ok: true, noChange: { outcome: "cancelled" } });
    expect(getTask(db, "T2")).toMatchObject({ stage: "cancelled", round: 0, headSHA: H });
    const ev = events("T2");
    expect(ev.find((e) => e.kind === "stage")!.data).toMatchObject({ from: "build", to: "cancelled", noChangeResolved: { mainHead: M, mainRunId: 900 } });
    expect(ev.some((e) => e.kind === "deliver" || e.kind === "review")).toBe(false);
    expect(listSteps(db, "T2").find((s) => s.step === "write")).toMatchObject({ state: "done" });
    expect(db.query("SELECT status FROM scheduler_intents WHERE id = 'w2'").get()).toEqual({ status: "cancelled" });
    expect(await resolve()).toMatchObject({ duplicate: true });
  });

  test("拒：来源不是 mainRedFix（卡名、自述都不算）", async () => {
    mainCard(false);
    await reject(resolve(), "invalid", /MAINRED1/);
    expect(getTask(db, "T2")).toMatchObject({ stage: "build" });
  });

  test("拒：main 又动了；main 最新仍红 / 未定；绿的不是同一 run；sourceRun 不是来源 run", async () => {
    mainCard();
    mainHead = M2;
    await reject(resolve(), "invalid", /最新 main/);
    mainHead = M;
    mainRuns = [{ ...mainRuns[0]!, conclusion: "failure" }];
    await reject(resolve(), "invalid", /failure/);
    mainRuns = [{ ...mainRuns[0]!, status: "in_progress", conclusion: null }];
    await reject(resolve(), "unavailable", /还没有结论/);
    mainRuns = [{ ...mainRuns[0]!, status: "completed", conclusion: "success", id: 901 }];
    await reject(resolve(), "invalid", /不是交付给的/);
    await reject(resolve({ ...MR, sourceRun: `https://github.com/${REPO}/actions/runs/801` } as NoChange), "invalid", /来源/);
    expect(getTask(db, "T2")).toMatchObject({ stage: "build" });
  });

  test("r1-P1 main-latest-undecided：同 main head 上比绿 run 更新的 run 还在跑 / 被取消 → 未定，不取消", async () => {
    mainCard();
    for (const status of [["in_progress", null], ["completed", "cancelled"], ["completed", "skipped"]] as const) {
      mainRuns = [{ ...mainRuns[0]!, id: 901, status: status[0], conclusion: status[1], createdAt: 4 }, ...mainRuns];
      await reject(resolve(), "unavailable", /901/);
      mainRuns = mainRuns.slice(1);
    }
    expect(getTask(db, "T2")).toMatchObject({ stage: "build" });
    expect(events("T2").some((e) => e.kind === "stage")).toBe(false);
  });

  test("r2-P1 local-nochange-unbound-order：派单起点与当前卡 head 不同（交哪个都拒）；派单时没有起点 / 手动单 / 快照与意图不一致 → 拒，零写入", async () => {
    mainCard();
    const n = events("T2").length;
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T2'").run(M2); // 真实派单 w2.head = H，卡后来换了 head
    await reject(deliverLocal(MR, { head: M2 }, "T2"), "invalid", /派单起点/);
    await reject(resolve(), "invalid", /派单起点/);
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T2'").run(H);
    db.query("UPDATE scheduler_intents SET head = ? WHERE id = 'w2'").run(M2);
    await reject(resolve(), "invalid", /不一致/);
    db.run("DELETE FROM scheduler_intents WHERE id = 'w2'");
    await reject(deliverLocal(MR, { order: "T2:write:r0" }, "T2"), "invalid", /手动派/);
    expect(events("T2").length).toBe(n);
    expect(getTask(db, "T2")).toMatchObject({ stage: "build" });
  });

  test("r3-P1 local-nochange-unbound-order：派单时卡上没有 head（build、round 0）→ 交付 head 等于当前 main 才取消，卡 head 仍为空；别的拒", async () => {
    mainCard(true, null);
    expect(await resolve().then(() => null, (x: Error) => x.message)).toMatch(/当前 main/); // 交的是 H，不是当前 main M
    expect(events("T2").some((e) => e.kind === "stage")).toBe(false);
    db.query("UPDATE tasks SET headSHA = ? WHERE id = 'T2'").run(M); // 卡后来有了 head：派单起点证明不了
    await reject(deliverLocal(MR, { head: M }, "T2"), "invalid", /没有起点 head/);
    db.run("UPDATE tasks SET headSHA = NULL WHERE id = 'T2'");
    expect(await deliverLocal(MR, { head: M }, "T2")).toMatchObject({ ok: true, noChange: { outcome: "cancelled" } });
    expect(getTask(db, "T2")).toMatchObject({ stage: "cancelled", round: 0, headSHA: null });
    expect(listSteps(db, "T2").find((s) => s.step === "write")).toMatchObject({ state: "done" });
  });

  test("r3-P1 local-nochange-unbound-order：空 head 的派单不开放给 out_of_scope_ci", async () => {
    db.run("DELETE FROM scheduler_intents WHERE id = 'fx1'");
    dispatch("T1", "fix", "fx2", null, 1);
    await reject(deliverLocal(OOS, { order: "fx2" }), "invalid", /没有起点 head/);
    expect(getTask(db, "T1")).toMatchObject({ stage: "fix" });
  });

  test("r1-P1 local-nochange-unbound：不是自己当前的单 / 步骤被删拒", async () => {
    mainCard();
    await reject(deliverLocal(MR, {}, "T2", "agent-other"), "invalid", /当前的单/);
    await reject(deliverLocal(MR, { order: "T2:write:r9" }, "T2"), "invalid", /当前的单/);
    onRead = () => db.run("DELETE FROM task_steps WHERE taskId = 'T2'");
    const n = events("T2").length;
    await reject(resolve(), "invalid", /待交的步骤/);
    expect(events("T2").length).toBe(n);
    expect(getTask(db, "T2")).toMatchObject({ stage: "build" });
  });

  test("普通卡（没有 MAINRED1 来源）不开放：out_of_scope_ci 不能用在 build，main_already_resolved 也拒", async () => {
    db.run("UPDATE tasks SET stage = 'build', headSHA = NULL WHERE id = 'T1'");
    db.query("INSERT INTO task_steps (taskId,step,round,executor,executorKind,state,createdAt,updatedAt) VALUES ('T1','write',1,'agent-dev','agent','assigned',1,1)").run();
    const e = await deliverLocal(OOS, { order: "T1:write:r1" }).then(() => null, (x: Error) => x.message);
    expect(e).toMatch(/修复单/);
    await reject(deliverLocal(MR, { order: "T1:write:r1" }), "invalid", /MAINRED1|fix|派单快照/);
  });
});
