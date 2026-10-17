/**
 * TIER3c 失败事实适配与升档存储：只收能归属到项目 + 卡号 + 具体运行的事实；两次 fix 或两次 CI 连红授予一级，成功清连红，
 * 取消 / 等待 / 无归属不计；同批同时满足、重复进库、重开库、双进程同一批事实都只升一次；最高档只记触顶，已存最高档不回降。
 * 都是临时库，不碰真实状态目录。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { createTask } from "../src/lib/ledger-write.js";
import { insertEvent } from "../src/lib/ledger-tx.js";
import { ciRunFact, isSafetyRefusal, ledgerEscalationFacts, type EscalationFact } from "../src/lib/task-tier-escalation-events.js";
import { cardState, closeEscalationStore, ingestFacts, latestPlan, listGrants, listPeaks, openEscalationStore, recordAdoption, recordNote, listNotes,
  settlePlan } from "../src/lib/task-tier-escalation-store.js";
import { testChildEnv } from "./test-env.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "tier3c-store-")); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };
function store() {
  const path = join(tmp(), "esc.sqlite");
  cleanups.push(() => closeEscalationStore(path));
  return { path, db: openEscalationStore(path) };
}
const fact = (id: string, kind: "fix" | "ci", outcome: "failure" | "success" = "failure", card = "T1"): EscalationFact => ({ project: "p1", card, id, kind, outcome, ts: 1 });
const RUN = (n: number) => `https://github.com/o/r/actions/runs/${n}/job/9`;

describe("[验收线 1] 事实适配", () => {
  test("CI 运行：只认 completed 终态；success / failure 计入，取消、等待、无归属、安全拒绝不计", () => {
    const run = { project: "p1", card: "T1", runId: 42, status: "completed" };
    expect(ciRunFact({ ...run, conclusion: "failure" })).toMatchObject({ id: "ci:42", kind: "ci", outcome: "failure" });
    expect(ciRunFact({ ...run, conclusion: "timed_out", attempt: 2 })).toMatchObject({ id: "ci:42", outcome: "failure" });
    expect(ciRunFact({ ...run, conclusion: "success", attempt: 2 })).toMatchObject({ id: "ci-pass:42#2", outcome: "success" });
    for (const bad of [{ ...run, conclusion: "cancelled" }, { ...run, conclusion: "skipped" }, { ...run, status: "queued" }, { ...run, status: "in_progress" },
      { ...run, card: undefined, conclusion: "failure" }, { ...run, runId: undefined, conclusion: "failure" }, { ...run, runId: "abc", conclusion: "failure" },
      { ...run, conclusion: "failure", cause: "provider_refusal" }, { ...run, conclusion: "failure", providerRefusal: true }]) {
      expect("skip" in ciRunFact(bad)).toBe(true);
    }
    expect(isSafetyRefusal({ cause: "safety_refusal" })).toBe(true);
    expect(isSafetyRefusal({ text: "拒绝" })).toBe(false);
  });

  test("台账 stage 事件：review / live / remote_review 退回算 fix，ci_fail 按最小运行 id 算 CI 失败，merge→live 算成功；冲突、无链接、导入、安全拒绝、别的卡不算", () => {
    const path = join(tmp(), "ledger.sqlite"), db = openLedger(path);
    cleanups.push(() => closeLedger(path));
    createTask(db, { actor: "owner" }, { id: "T1", project: "p1", title: "x", kind: "code" });
    createTask(db, { actor: "owner" }, { id: "T2", project: "p1", title: "y", kind: "code" });
    const stage = (target: string, data: Record<string, unknown>) =>
      insertEvent(db, { actor: "owner", now: 10 }, { project: "p1", target, kind: "stage", text: "", data }, false);
    stage("T1", { from: "review", to: "fix" });
    stage("T1", { from: "merge", to: "fix", mergeBounce: { cause: "conflict", checks: [] } });
    stage("T1", { from: "merge", to: "fix", mergeBounce: { cause: "ci_fail", checks: [{ name: "b", link: RUN(9) }, { name: "a", link: RUN(7) }] } });
    stage("T1", { from: "merge", to: "fix", mergeBounce: { cause: "ci_fail", checks: [{ name: "a", link: "" }] } });
    stage("T1", { from: "merge", to: "fix", mergeBounce: { cause: "remote_review" } });
    stage("T1", { from: "review", to: "fix", imported: true });
    stage("T1", { from: "review", to: "fix", cause: "provider_refusal" });
    stage("T1", { from: "merge", to: "live" });
    stage("T2", { from: "review", to: "fix" });
    const got = ledgerEscalationFacts(db, "p1", "T1").map((f) => [f.kind, f.outcome, f.id.replace(/:.*$/, "")]);
    expect(got).toEqual([["fix", "failure", "fix"], ["ci", "failure", "ci"], ["fix", "failure", "fix"], ["ci", "success", "ci-pass"]]);
    expect(ledgerEscalationFacts(db, "p1", "T1")[1].id).toBe("ci:7");
    expect(ledgerEscalationFacts(db, "p9", "T1")).toEqual([]);
  });
});

describe("[验收线 1] 计数与授予", () => {
  test("两次 fix 授予一级并消费证据", () => {
    const { db } = store();
    expect(ingestFacts(db, [fact("f1", "fix")], { now: 1 }).grants).toEqual([]);
    const r = ingestFacts(db, [fact("f2", "fix")], { now: 2 });
    expect(r.grants).toMatchObject([{ n: 1, kind: "up", cause: "fix", evidence: ["f1", "f2"] }]);
    expect(cardState(db, "p1", "T1")).toEqual({ fix: 0, ci: 0, steps: 1 });
  });

  test("CI 连续两次终态失败才授予；中间成功清连红", () => {
    const { db } = store();
    expect(ingestFacts(db, [fact("c1", "ci"), fact("ok1", "ci", "success"), fact("c2", "ci")], { now: 1 }).grants).toEqual([]);
    expect(cardState(db, "p1", "T1")).toMatchObject({ ci: 1, steps: 0 });
    expect(ingestFacts(db, [fact("c3", "ci")], { now: 2 }).grants).toMatchObject([{ cause: "ci" }]);
    expect(cardState(db, "p1", "T1")?.steps).toBe(1);
  });
});

describe("[验收线 2] 只升一次", () => {
  test("同批两个条件同时满足只升一次（与批内顺序无关），消费本批证据，再有两次新失败才再升", () => {
    for (const order of [["f1", "f2", "c1", "c2"], ["c1", "f1", "c2", "f2"], ["c1", "c2", "f1", "f2"]]) {
      const { db } = store();
      const r = ingestFacts(db, order.map((id) => fact(id, id[0] === "f" ? "fix" : "ci")), { now: 1 });
      expect(r.grants).toMatchObject([{ n: 1, kind: "up", cause: "fix+ci", evidence: order }]);
      expect(cardState(db, "p1", "T1")).toEqual({ fix: 0, ci: 0, steps: 1 });
      expect(ingestFacts(db, [fact("f3", "fix")], { now: 2 }).grants).toEqual([]);
      expect(ingestFacts(db, [fact("f4", "fix")], { now: 3 }).grants).toMatchObject([{ n: 2, cause: "fix", evidence: ["f3", "f4"] }]);
      expect(cardState(db, "p1", "T1")?.steps).toBe(2);
    }
  });

  test("一批里四次 fix 也只升一级", () => {
    const { db } = store();
    expect(ingestFacts(db, ["f1", "f2", "f3", "f4"].map((id) => fact(id, "fix")), { now: 1 }).grants.length).toBe(1);
    expect(cardState(db, "p1", "T1")).toEqual({ fix: 0, ci: 0, steps: 1 });
  });

  test("重复进库、重开库重放：同一事实只算一次；别的卡互不影响", () => {
    const { db, path } = store();
    const batch = [fact("f1", "fix"), fact("f2", "fix")];
    ingestFacts(db, batch, { now: 1 });
    expect(ingestFacts(db, batch, { now: 2 })).toEqual({ added: 0, grants: [] });
    closeEscalationStore(path);
    const again = openEscalationStore(path);
    expect(ingestFacts(again, [...batch, ...batch], { now: 3 })).toEqual({ added: 0, grants: [] });
    expect(cardState(again, "p1", "T1")?.steps).toBe(1);
    expect(ingestFacts(again, [fact("f1", "fix", "failure", "T2")], { now: 4 }).added).toBe(1);
  });

  test("双进程同时进同一批事实：只授予一级", async () => {
    const { path } = store();
    const mod = join(import.meta.dir, "../src/lib/task-tier-escalation-store.ts");
    const code = `const s = await import(${JSON.stringify(mod)}); const db = s.openEscalationStore(${JSON.stringify(path)});
      const f = (id) => ({ project: "p1", card: "T1", id, kind: "fix", outcome: "failure", ts: 1 });
      for (let i = 0; i < 20; i++) s.ingestFacts(db, [f("f1"), f("f2")], { now: i });`;
    const kids = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], { env: testChildEnv(), stdout: "pipe", stderr: "pipe" }));
    expect(await Promise.all(kids.map((k) => k.exited))).toEqual([0, 0]);
    expect(listGrants(openEscalationStore(path), "p1", "T1").length).toBe(1);
  });

  test("dryRun（observe）返回本会授予的级，库不变", () => {
    const { db } = store();
    expect(ingestFacts(db, [fact("f1", "fix"), fact("f2", "fix")], { now: 1, dryRun: true }).grants.length).toBe(1);
    expect(cardState(db, "p1", "T1")).toBeNull();
    expect(ingestFacts(db, [fact("f1", "fix"), fact("f2", "fix")], { now: 2 }).grants.length).toBe(1);
  });

  test("最近用过的家族已在最高档：再授予只记触顶不加级；已存最高档不回降", () => {
    const { db } = store();
    const plan = { project: "p1", card: "T1", family: "claude", step: 1, now: 5 };
    expect(settlePlan(db, { ...plan, value: "claude-opus-5-5", rank: 2, top: true, baseRank: 1 }).value).toBe("claude-opus-5-5");
    expect(settlePlan(db, { ...plan, step: 2, value: "claude-haiku-5-5", rank: 0, top: false, baseRank: 0, now: 6 })).toMatchObject({ value: "claude-opus-5-5", rank: 2 });
    expect(listPeaks(db, "p1", "T1")).toMatchObject([{ family: "claude", value: "claude-opus-5-5", top: true }]);
    expect(latestPlan(db, "p1", "T1")).toMatchObject({ step: 2, value: "claude-opus-5-5" });
    expect(ingestFacts(db, [fact("f1", "fix"), fact("f2", "fix")], { now: 7 }).grants).toMatchObject([{ kind: "topped" }]);
    expect(cardState(db, "p1", "T1")).toEqual({ fix: 0, ci: 0, steps: 0 });
  });

  test("同一级下发值变了（配置提了基础档）：新计划代次，latestPlan 与返回值一致，旧代次采用记录留作历史、不带到新代次", () => {
    const { db } = store();
    const p = { project: "p1", card: "T1", family: "claude", step: 1, top: false };
    expect(settlePlan(db, { ...p, baseRank: 0, value: "claude-sonnet-5-5", rank: 1, now: 1 }).value).toBe("claude-sonnet-5-5");
    expect(recordAdoption(db, { project: "p1", card: "T1", family: "claude", step: 1, gen: 0, launchId: "L1", sessionId: "s1", actual: "claude-sonnet-5-5" })).toBe(true);
    expect(settlePlan(db, { ...p, baseRank: 1, value: "claude-opus-5-5", rank: 2, top: true, now: 2 }).value).toBe("claude-opus-5-5");
    expect(latestPlan(db, "p1", "T1")).toMatchObject({ step: 1, value: "claude-opus-5-5", ts: 2, launchId: null, actual: null });
    settlePlan(db, { ...p, baseRank: 1, value: "claude-opus-5-5", rank: 2, top: true, now: 3 }); // 值没变：不另起代次
    expect(latestPlan(db, "p1", "T1")).toMatchObject({ value: "claude-opus-5-5", ts: 2 });
    expect(db.query("SELECT value, actual FROM esc_plans ORDER BY gen").all()).toEqual([
      { value: "claude-sonnet-5-5", actual: "claude-sonnet-5-5" }, { value: "claude-opus-5-5", actual: null }]);
  });

  test("实际采用值：没证实的可被后来的启动替换，证实等于发出值后不翻案；原因同键一条", () => {
    const { db } = store();
    settlePlan(db, { project: "p1", card: "T1", family: "codex", step: 1, value: "xhigh", rank: 4, top: false, baseRank: 3, now: 1 });
    const a = { project: "p1", card: "T1", family: "codex", step: 1, gen: 0, launchId: "L1", sessionId: "s1", actual: "unknown" };
    expect(recordAdoption(db, a)).toBe(true);
    expect(recordAdoption(db, { ...a, launchId: "L2", sessionId: "s2", actual: "xhigh" })).toBe(true);
    expect(recordAdoption(db, { ...a, launchId: "L3", sessionId: "s3" })).toBe(false);
    expect(latestPlan(db, "p1", "T1")).toMatchObject({ launchId: "L2", sessionId: "s2", actual: "xhigh" });
    expect(recordNote(db, "p1", "T1", "k", "原因", 1)).toBe(true);
    expect(recordNote(db, "p1", "T1", "k", "原因", 2)).toBe(false);
    expect(listNotes(db, "p1", "T1")).toEqual([{ key: "k", text: "原因" }]);
  });
});
