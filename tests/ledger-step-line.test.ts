/** 协作视图的步骤线（T51，src/lib/ledger-step-line.ts）：总览每张卡、任务详情都带；当前这一步与权限同口径；等对方 owner 的判法 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeLedger, openLedger } from "../src/lib/ledger-store.js";
import { projectView, taskDetail } from "../src/lib/ledger-read.js";
import { assignStep, recordAccept } from "../src/lib/ledger-steps-write.js";
import { createTask, setMeta } from "../src/lib/ledger-write.js";

const P = "claude-orchestrator";
const OWNER = { actor: "owner", now: 1_000 };
const PM = { actor: "agent-pm", now: 1_100 };
let db: Database;
const toStage = (id: string, stage: string, before: string | null = null) =>
  db.run("UPDATE tasks SET stage = ?, stageBefore = ? WHERE id = ?", [stage, before, id]);
const lineOf = (id: string) => projectView(db, P, 9_000).tasks.find((t) => t.id === id)!.stepLine!;

beforeEach(() => {
  db = openLedger(":memory:");
  setMeta(db, OWNER, { project: P, key: "pms", value: ["agent-pm"] });
  createTask(db, OWNER, { project: P, id: "T51", title: "委托出去的卡", kind: "code", extra: { delegate: "agent-outer@Sekai" } });
  createTask(db, OWNER, { project: P, id: "T60", title: "本机的卡", kind: "code" });
});
afterEach(() => closeLedger(":memory:"));

describe("stepLine", () => {
  test("委托给别的实例、卡在 spec、没有 accept：等对方 owner；accept 之后、或进了 restate 就不算", () => {
    expect(lineOf("T51").awaitingPeerOwner).toBe(true);
    recordAccept(db, { actor: "peer:Sekai", now: 1_200 }, { taskId: "T51", peer: "Sekai" });
    expect(lineOf("T51").awaitingPeerOwner).toBe(false);
    createTask(db, OWNER, { project: P, id: "T52", title: "x", kind: "code", extra: { delegate: "a@B" } });
    toStage("T52", "restate");
    expect(lineOf("T52").awaitingPeerOwner).toBe(false);
    expect(lineOf("T60").awaitingPeerOwner).toBe(false); // 本机的卡从来不等对方
  });

  test("老卡按 extra 推出来的步骤也在线上；当前这一步与 stepAtStage 同口径（blocked 看 stageBefore）", () => {
    toStage("T51", "build");
    expect(lineOf("T51").active).toEqual({ step: "write", round: 0 });
    expect(lineOf("T51").steps.every((s) => s.derived)).toBe(true);
    toStage("T51", "blocked", "fix");
    expect(lineOf("T51").active).toEqual({ step: "fix", round: 0 }); // 老卡推出来的修也是委托对象
  });

  test("显式派的步骤以库里为准；详情和总览是同一份", () => {
    assignStep(db, PM, { taskId: "T60", step: "write", executor: "agent-x", executorKind: "agent" });
    assignStep(db, PM, { taskId: "T60", step: "review", executor: "outer-codex@Sekai", executorKind: "peer" });
    toStage("T60", "review");
    const line = lineOf("T60");
    expect(line.active).toEqual({ step: "review", round: 0 });
    expect(line.steps.map((s) => [s.step, s.executor, s.derived ?? false])).toEqual([["review", "outer-codex@Sekai", false], ["write", "agent-x", false]]);
    const d = taskDetail(db, P, "T60", 9_000)!;
    expect(d.stepLine).toEqual(line);
    expect(d.steps).toEqual(line.steps);
  });
});
