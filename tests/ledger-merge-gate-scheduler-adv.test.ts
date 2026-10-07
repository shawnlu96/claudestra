/**
 * 调度器派的跨族对抗审查单（自动卡不写 dispatch 事件，review 带 data.orderId …:rN:adversarial_review:aK）也算还清对抗式：
 * owesAdversarial（src/lib/ledger-handler.ts）、`review --to merge` / `stage review → merge` 闸门、巡检 review_no_reviewer 同一判定。
 * 同家族（sameFamily=true）、head 对不上、之后又交付、常规审查单都不变松。回放 = ACPT-3 的真实事件（tests/fixtures）。
 */
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { auditLedger } from "../src/lib/ledger-audit.js";
import { currentHandler, owesAdversarial } from "../src/lib/ledger-handler.js";
import type { LedgerEvent, LedgerTask } from "../src/lib/ledger-stages.js";
import { getTask, listEvents, openLedger } from "../src/lib/ledger-store.js";
import { createTask, deliver, moveStage, recordReview, setMeta } from "../src/lib/ledger-write.js";
import { policyFromSpec, specPolicyOf } from "../src/lib/task-spec.js";
import type { Registry } from "../src/manager/core.js";
import { runLedger } from "../src/manager/ledger.js";
import fixture from "./fixtures/ledger-acpt3-adversarial.json";
import { tempLedgerPath } from "./ledger-test-helpers.js";

const P = "proj";
let db: Database;
let docs: string;
let head: string | null;
const reg: Registry = {
  socket: "s",
  agents: {
    "agent-exec": { status: "active", projectId: P, cwd: "/w/t1" } as unknown as Registry["agents"][string],
    "agent-disp": { status: "active", projectId: P } as Registry["agents"][string],
    "agent-pm": { status: "active", projectId: P } as Registry["agents"][string],
  },
};
const o = { actor: "owner", now: 1 };

const run = (actor: string, ...args: string[]) =>
  runLedger(args, {
    db, actor, actorProject: P, projectIds: [P],
    loadRegistry: async () => structuredClone(reg), saveRegistry: async () => {}, now: () => 5_000, gitHead: () => head,
  }) as Promise<Record<string, any>>;
const ship = (sha: string, from?: "build" | "fix") => {
  head = sha;
  deliver(db, { actor: "agent-exec", now: 2 }, { taskId: "T1", headSHA: sha, moveFrom: from });
};
const round = () => getTask(db, "T1")?.round ?? 0;
const events = () => listEvents(db, { target: "T1" });
const owes = () => owesAdversarial(specPolicyOf(getTask(db, "T1") as never, docs), events(), round());
const A = "a".repeat(40);
const C = "c".repeat(40);
/** 调度器审查单交回的结构化结论（submit_verdict 写的那几项，head 必须是卡上当前 head）；node / sameFamily / 轮次可改 */
const orderVerdict = (over: { node?: string; sameFamily?: boolean; r?: number; verdict?: "pass" | "changes" } = {}) =>
  recordReview(db, { actor: "agent-rv-t1", now: 3 }, {
    taskId: "T1", reviewer: "agent-rv-t1", verdict: over.verdict ?? "pass", p0: 0, p1: over.verdict === "changes" ? 1 : 0, p2: 0,
    head: head ?? "", reviewerSessionId: "rv-session", reviewerFamily: "codex", path: "/r/report.md",
    findings: over.verdict === "changes" ? [{ findingId: "F1", family: "x", severity: "P1", probe: "p" }] : [],
    orderId: `t68:s9:r${over.r ?? round()}:${over.node ?? "adversarial_review"}:a1`, sameFamily: over.sameFamily ?? false, via: "mcp",
  });
const passToMerge = () => run("agent-disp", "review", "T1", "--reviewer", "r", "--verdict", "pass", "--p0", "0", "--p1", "0", "--p2", "0", "--to", "merge");

beforeEach(() => {
  db = openLedger(tempLedgerPath("ledger-gate-sched-"));
  docs = mkdtempSync(join(tmpdir(), "ledger-gate-sched-docs-"));
  mkdirSync(join(docs, "tasks"));
  writeFileSync(join(docs, "tasks", "T1.md"), "# T1\n- 审查：本地跨族对抗式一轮\n");
  setMeta(db, o, { project: P, key: "pms", value: ["agent-pm", "agent-disp"] });
  setMeta(db, o, { project: P, key: "docsDir", value: docs });
  setMeta(db, o, { project: P, key: "team", value: { dispatcher: "agent-disp", audit: true } });
  createTask(db, o, { project: P, id: "T1", title: "自动卡", kind: "code", agent: "agent-exec" });
  moveStage(db, o, { taskId: "T1", from: "spec", to: "restate" });
  moveStage(db, o, { taskId: "T1", from: "restate", to: "build" });
  ship(A, "build");
});

describe("调度器跨族对抗审查单 pass = 还清", () => {
  test("跨族、head / 轮次对得上：不欠；路由归 PM；review --to merge 放行", async () => {
    orderVerdict();
    expect(owes()).toBe(false);
    const h = currentHandler(getTask(db, "T1") as never, events(), { pms: ["agent-pm", "agent-disp"], dispatcher: "agent-disp" }, specPolicyOf(getTask(db, "T1") as never, docs));
    expect(h?.role).toBe("pm");
    expect((await passToMerge()).task.stage).toBe("merge");
  });

  test("PM 手动 stage review → merge 同样放行", async () => {
    orderVerdict();
    expect((await run("agent-pm", "stage", "T1", "--from", "review", "--to", "merge")).task.stage).toBe("merge");
  });

  test("同家族（sameFamily=true，MODELX 豁免轮）：仍欠，闸门拦", async () => {
    orderVerdict({ sameFamily: true });
    expect(owes()).toBe(true);
    expect(await passToMerge()).toMatchObject({ ok: false, code: "conflict" });
  });

  test("常规审查单（节点 review）/ 单号轮次对不上 / changes：仍欠", () => {
    orderVerdict({ node: "review" });
    expect(owes()).toBe(true);
    orderVerdict({ r: round() + 1 });
    expect(owes()).toBe(true);
    orderVerdict({ verdict: "changes" });
    expect(owes()).toBe(true);
  });

  test("对抗 pass → merge → 退回 fix 交付新 head：重新欠", async () => {
    orderVerdict();
    expect((await passToMerge()).task.stage).toBe("merge");
    moveStage(db, o, { taskId: "T1", from: "merge", to: "fix" });
    ship(C, "fix");
    expect(owes()).toBe(true);
    expect(await passToMerge()).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("回放 ACPT-3（10-07 真实事件，只读导出）", () => {
  const evs = fixture as unknown as LedgerEvent[];
  // ACPT-3 规格卡写的是「## 审查安排」标题，读不出「审查：」= 策略 undefined
  const policy = policyFromSpec("## 审查安排\n本地跨族对抗式一轮 → 交接 Shawn。\n");
  const acpt = { id: "ACPT-3", project: "claudestra", stage: "review", round: 1, headSHA: evs.findLast((e) => e.kind === "deliver")?.data.headSHA } as LedgerTask;
  const withoutOrder = evs.map((e) => (e.kind === "review" ? { ...e, data: { ...e.data, orderId: undefined } } : e));

  test("修复前（去掉单号就是旧判定能看到的）unknown，修复后 false", () => {
    expect(policy).toBeUndefined();
    expect(owesAdversarial(policy, withoutOrder, 1)).toBe("unknown");
    expect(owesAdversarial(policy, evs, 1)).toBe(false);
  });

  test("审的 head 与交付的 head 对不上（写入层已拒，老数据）：仍按旧判定", () => {
    const other = evs.map((e) => (e.kind === "review" ? { ...e, data: { ...e.data, head: "b".repeat(40) } } : e));
    expect(owesAdversarial(policy, other, 1)).toBe("unknown");
  });

  test("sameFamily 没记 / null 不按家族重建（作者换族、事后改 workflow 都改不了结论）：仍按旧判定", () => {
    const deliverSeq = (evs.find((e) => e.kind === "deliver") as LedgerEvent).seq;
    const at = (seq: number, kind: LedgerEvent["kind"], data: Record<string, unknown>) => ({ ...evs[0], seq, kind, data }) as LedgerEvent;
    const fam = (reviewerFamily: string, ...extra: LedgerEvent[]) =>
      [...evs.map((e) => (e.kind === "review" ? { ...e, data: { ...e.data, sameFamily: null, reviewerFamily } } : e)), ...extra].sort((x, y) => x.seq - y.seq);
    // 复现 A：交付前作者换成 codex（note local_author），codex 审查员仍是同家族
    expect(owesAdversarial(policy, fam("codex", at(deliverSeq - 1, "note", { op: "local_author", family: "codex", previousFamily: "claude" })), 1)).toBe("unknown");
    // 复现 B：review 之后才把 workflow authorFamily 改成 codex，不能倒改 claude 审查员那条结论
    expect(owesAdversarial(policy, fam("claude", at(99_999, "scheduler", { op: "workflow", authorFamily: "codex" })), 1)).toBe("unknown");
    expect(owesAdversarial(policy, fam("codex"), 1)).toBe("unknown");
  });

  test("巡检：pass 之后 31 分钟不再报 review_no_reviewer；去掉单号照旧报「说不清」", () => {
    const pass = evs.findLast((e) => e.kind === "review") as LedgerEvent;
    const at = pass.ts + 31 * 60_000;
    const snap = (events: LedgerEvent[]) => ({
      project: "claudestra", pms: ["agent-pm"], team: { dispatcher: "agent-disp" }, reviewers: [], held: [], ownerInbox: [],
      agents: [], tasks: [{ task: acpt, events, specPolicy: policy }],
    });
    const rule = (events: LedgerEvent[]) => auditLedger(snap(events) as never, at).findings.filter((f) => f.rule === "review_no_reviewer");
    expect(rule(evs)).toEqual([]);
    expect(rule(withoutOrder).map((f) => f.detail)).toEqual([expect.stringContaining("说不清")]);
  });
});
