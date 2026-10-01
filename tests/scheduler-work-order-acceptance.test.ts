import { describe, expect, test } from "bun:test";
import type { SchedulerIntent } from "../src/lib/ledger-scheduler.js";
import type { LedgerTask } from "../src/lib/ledger-stages.js";
import { statePath } from "../src/lib/paths.js";
import { standardAnswers } from "../src/lib/order-standard-answers.js";
import { SRC_DIR } from "../src/lib/repo-root.js";
import type { ReviewFinding } from "../src/lib/scheduler-review.js";
import { workOrderFor } from "../src/lib/scheduler-work-order.js";
import type { SessionRef, WorkOrder } from "../src/lib/worker-session.js";

// Every field except acceptance is the pre-i28-N6 output written out literally, so a wording change to acceptance can
// not silently move inputs / outputs / writeBack / dedupKey.
const CLI = `bun ${SRC_DIR}/manager.ts ledger`;
const SPEC = `规格与验收：${CLI} show T1`;
const H = "a".repeat(40);
const task = { id: "T1", round: 2 } as LedgerTask;
const ref: SessionRef = { taskId: "T1", role: "author", agent: "agent-t1", sessionId: "s".repeat(36), family: "codex", transport: "acp" };
const intent = (node: string, head: string | null = H) => ({ id: `t68:s1:r2:${node}:a0`, node, head, specRev: 3 }) as SchedulerIntent;
const P2: ReviewFinding = { findingId: "F1", family: "x", severity: "P2", probe: "p" };
const fixPlan = { kind: "intent", id: "i", node: "fix", action: "dispatch", recipient: "agent-t1",
  workOrder: { reportPath: "/r/report.md", findings: [P2], fallbackWarning: "warn" } } as never;
const head = (node: string, step: WorkOrder["step"]) => ({ taskId: "T1", specRev: 3, head: H, round: 2, node, step, dedupKey: `t68:s1:r2:${node}:a0` });

const AUTHOR = [
  "交付前跑 GUARD_STRICT=1 bun run check：tsc、guard 必须绿，所有入口 build",
  "bun test 里本机负载造成的等待型超时、且在 base 上同样复现的，不算不过；在证据报告里列出文件名",
  "全量测试以 PR head 上 CI 必过项全绿为准",
];

describe("workOrderFor acceptance (i28-N6)", () => {
  test("build: three acceptance lines, everything else unchanged", () => {
    expect(workOrderFor(task, intent("write"), null, ref)).toEqual({ ...head("write", "write"), inputs: [SPEC, standardAnswers("author")],
      outputs: ["分支上的提交（完整 head SHA）", "证据报告路径"], acceptance: AUTHOR,
      writeBack: `${CLI} deliver T1 --from build --head <完整 SHA> --evidence <报告路径>` });
  });

  test("fix: same three lines; findings and the last report still carried", () => {
    expect(workOrderFor(task, intent("fix"), fixPlan, ref)).toEqual({ ...head("fix", "fix"), findings: [P2], fallbackWarning: "warn",
      inputs: [SPEC, "上一轮审查报告：/r/report.md", standardAnswers("author")], outputs: ["分支上的提交（完整 head SHA）", "证据报告路径"], acceptance: AUTHOR,
      writeBack: `${CLI} deliver T1 --from fix --head <完整 SHA> --evidence <报告路径>` });
  });

  test("review: CI rule appended after the two adversarial lines", () => {
    const report = `${statePath("ledger", "reviews", "T1-r2")}/report.md`;
    expect(workOrderFor(task, intent("adversarial_review"), null, { ...ref, role: "reviewer" }, "/wt")).toEqual({
      ...head("adversarial_review", "review"), inputs: [SPEC, `只审 head ${H}`, "审查目录：/wt（已固定在这个 head；只读，不改、不提交、不推送）",
        standardAnswers("review")],
      outputs: ["逐项结论 JSON（findingId / family / severity / probe）", `报告：${report}`],
      acceptance: ["对抗式：专找能打穿规格保证的路径", "同类问题沿用上一轮的 findingId", "全量测试只看 PR head 的 CI；不跑全量，本机超时不判 P1"],
      writeBack: `${CLI} review T1 --reviewer agent-t1 --verdict pass|changes|block --p0 N --p1 N --p2 N --head ${H}` +
        ` --session ${"s".repeat(36)} --family codex --findings <逐项结论.json> --path ${report}（不要带 --to，阶段由调度器推）` });
  });

  test("restate: unchanged", () => {
    expect(workOrderFor(task, intent("restate", null), null, ref)).toEqual({ ...head("restate", "restate"), head: null, inputs: [SPEC],
      outputs: ["≤20 行复述：范围、不做、验收"], acceptance: ["复述与规格一致，PM 放行后才开写"],
      writeBack: `${CLI} stage T1 --from spec --to restate --text <复述>` });
  });
});
