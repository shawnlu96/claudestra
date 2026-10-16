/** ONB-1 验收 4（派单）：localMerge 项目的开工 / 修复 / 审查单列本项目的 requiredChecks，不提 bun run check 与 PR CI；其余项目逐字不变 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLedger, getTask, openLedger } from "../src/lib/ledger-store.js";
import { assignStep } from "../src/lib/ledger-steps-write.js";
import { createTask, setMeta, setTask } from "../src/lib/ledger-write.js";
import { localAuthorAcceptance, localReviewRule, standardAnswers } from "../src/lib/order-standard-answers.js";
import { currentOrders, orderWireFor } from "../src/lib/order-take.js";
import { WIRE_LIMITS } from "../src/lib/order-wire.js";
import { reviewOrderOf } from "../src/lib/review-order.js";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import type { SessionRef } from "../src/lib/worker-session.js";

const H = "a".repeat(40);
const task = { id: "T1", round: 1, project: "dn" } as LedgerTask;
const ref: SessionRef = { taskId: "T1", role: "author", agent: "agent-t1", sessionId: "s".repeat(36), family: "claude", transport: "tmux" };
const intent = (node: string) => ({ id: `t68:s1:r1:${node}:a0`, node, head: H, specRev: 1 }) as SchedulerIntent;
const CHECKS = ["cargo test --workspace", "bun run lint"];
const local = (p: string) => (p === "dn" ? { repoDir: "/tmp/dn", checks: CHECKS } : null);
const none = () => null;

describe("workOrderFor：localMerge 项目", () => {
  test("开工 / 修复单：验收列本项目检查，没有 bun run check / PR CI", () => {
    for (const node of ["write", "fix"]) {
      const acc = workOrderFor(task, intent(node), null, ref, undefined, undefined, local)!.acceptance.join("\n");
      for (const c of CHECKS) expect(acc).toContain(`\`${c}\``);
      for (const s of ["bun run check", "PR head", "CI"]) expect(acc).not.toContain(s);
    }
  });

  test("审查单：CI 规则换成本项目检查", () => {
    const acc = workOrderFor(task, intent("adversarial_review"), null, { ...ref, role: "reviewer" }, "/wt", undefined, local)!.acceptance;
    expect(acc.at(-1)).toBe("全量测试按本项目的必过检查（`cargo test --workspace`；`bun run lint`）在审查目录里跑；本机超时不判 P1");
  });

  test("非本地项目与改动前逐字相同（不注入 = 读配置，同一结果）", () => {
    for (const node of ["write", "fix", "adversarial_review", "restate"]) {
      const want = workOrderFor({ ...task, project: "claudestra" }, intent(node), null, ref, "/wt", undefined, none);
      expect(workOrderFor({ ...task, project: "claudestra" }, intent(node), null, ref, "/wt", undefined, local)).toEqual(want);
      expect(workOrderFor({ ...task, project: "claudestra" }, intent(node), null, ref, "/wt")).toEqual(want);
    }
  });

  test("复述单不读项目配置", () => {
    let read = 0;
    workOrderFor(task, intent("restate"), null, ref, undefined, undefined, (p) => (read++, local(p)));
    expect(read).toBe(0);
  });
});

describe("正式领单：take_order / take_review（复现 local-required-checks-order）", () => {
  const OWNER = { actor: "owner", now: 1_000 };
  let db: Database, dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onb1-wire-"));
    db = openLedger(":memory:");
    setMeta(db, OWNER, { project: "dn", key: "pms", value: ["agent-pm"] });
    createTask(db, OWNER, { project: "dn", id: "T1", title: "卡", kind: "code" });
    setTask(db, OWNER, { id: "T1", rev: 1, patch: { agent: "agent-x", branch: "feat/t1" } });
  });
  afterEach(() => { closeLedger(":memory:"); rmSync(dir, { recursive: true, force: true }); });

  const takeOrder = (localOf: typeof local) => {
    assignStep(db, { actor: "agent-pm", now: 1_100 }, { taskId: "T1", step: "write", executor: "agent-x", executorKind: "agent" });
    db.run("UPDATE tasks SET stage = 'build' WHERE id = 'T1'");
    const [cur] = currentOrders(db, { agent: "agent-x", sessionId: "sx", family: "claude-code", channelId: "ch-x" });
    const r = orderWireFor(db, cur!, false, localOf);
    if (!r.ok) throw new Error(r.error);
    return r.order;
  };
  const takeReview = (localOf: typeof local, spec: string | null = null) => {
    if (spec) {
      writeFileSync(join(dir, "T1.md"), spec);
      db.run("UPDATE tasks SET spec = ? WHERE id = 'T1'", [join(dir, "T1.md")]);
    }
    db.run(`UPDATE tasks SET stage = 'review', headSHA = '${H}', round = 1 WHERE id = 'T1'`);
    return reviewOrderOf(db, { task: getTask(db, "T1")!, orderId: "T1:review:r1", node: "review", head: H, auto: true }, dir, false, localOf);
  };

  test("执行者单：验收先列本项目检查；标准答复不再说 PR head 的 CI", () => {
    const o = takeOrder(local);
    expect(o.acceptance).toEqual([...localAuthorAcceptance(CHECKS), "规格里的验收线逐条自查"]);
    const sa = o.inputs.at(-1)!;
    expect(sa).toBe(standardAnswers("author", undefined, CHECKS));
    expect(sa).toContain("`cargo test --workspace`；`bun run lint`");
    expect(sa).not.toContain("PR head 的 CI");
    expect(sa).not.toContain("CI 由合并闸核对");
  });

  test("审查单：验收带本项目检查；规格验收线占满上限时整张单仍过 parseOrderWire", () => {
    const r = takeReview(local, "## 验收\n- 一条\n");
    expect(r.ok && r.order.acceptance).toEqual([localReviewRule(CHECKS), "- 一条"]);
    expect(r.ok && r.order.inputs.at(-1)).toBe(standardAnswers("review", undefined, CHECKS));
    const full = takeReview(local, `## 验收\n${Array.from({ length: 25 }, (_, i) => `- 第 ${i} 条`).join("\n")}\n`);
    expect(full.ok && full.order.acceptance.length).toBe(WIRE_LIMITS.items);
    expect(full.ok && full.order.acceptance[0]).toBe(localReviewRule(CHECKS));
  });

  test("非本地项目两张单逐字不变（注入 null 与默认读配置同一结果）", () => {
    const o = takeOrder(none);
    expect(o.acceptance).toEqual(["规格里的验收线逐条自查"]);
    expect(o.inputs.at(-1)).toBe(standardAnswers("author"));
    expect(o.outputs[0]).toBe("分支上的提交，已推到 origin（完整 head SHA）");
    const a = takeReview(none, "## 验收\n- 一条\n"), b = takeReview((p) => (p === "other" ? local("dn") : null), "## 验收\n- 一条\n");
    expect(a).toEqual(b);
    expect(a.ok && a.order.inputs.at(-1)).toBe(standardAnswers("review"));
  });
});
