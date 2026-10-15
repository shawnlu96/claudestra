/** ONB-1 验收 4（派单）：localMerge 项目的开工 / 修复 / 审查单列本项目的 requiredChecks，不提 bun run check 与 PR CI；其余项目逐字不变 */
import { describe, expect, test } from "bun:test";
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
