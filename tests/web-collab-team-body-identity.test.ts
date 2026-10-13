/**
 * TEAMVIS7 · people-missing 的依据：审查员 / PM 的身份，本卡能读的两份中心契约（团队卡投影、中心正文）都装不下——
 * 带上就整份拒收，所以团队详情只能写原因，不能显示名字和机器（补身份要另开契约节点，规格写明本卡不改 TEAMVIS1）。
 */
import { expect, test } from "bun:test";
import { taskProjectionSchema } from "../src/lib/shared-ledger-contract-transfer.js";
import { parseTeamBodyRead, teamBodyDigest } from "../src/lib/shared-ledger-contract-team-body.js";
import { IDENTITY_NOT_SYNCED, teamPeople } from "@/features/collab/team-body/team-body-model";

const task = {
  sourceTaskId: "task-a", sourceRev: 1, sourceSeq: 1, stage: "review", assigneeCode: "peer-dev", executorInstanceId: "peer-machine",
  pr: null, head: null, deps: [], specSummary: "", specDigest: null, fullText: "home_only", steps: [], asks: [],
};
const identity = { kind: "agent", instanceId: "peer-machine", agentId: "peer-reviewer" };

test("团队卡投影：没有审查员 / PM 字段，步骤行也没有执行者；带上就拒收", () => {
  expect(() => taskProjectionSchema(task)).not.toThrow();
  expect(() => taskProjectionSchema({ ...task, reviewer: identity })).toThrow();
  expect(() => taskProjectionSchema({ ...task, pm: identity })).toThrow();
  const step = { sourceStepId: "review:1", sourceRev: 1, sourceSeq: 1, state: "done" };
  expect(() => taskProjectionSchema({ ...task, steps: [step] })).not.toThrow();
  expect(() => taskProjectionSchema({ ...task, steps: [{ ...step, executor: identity }] })).toThrow();
});

test("中心正文：记录没有作者 / 审查员字段；带上就拒收", () => {
  const text = "审查结论 pass · P0 0 / P1 0 / P2 0";
  const record = { featureId: "f", taskId: "t", kind: "review", sourceKey: "3", text, scrubVersion: 1, maskedSegments: 0, digest: teamBodyDigest(text) };
  const read = { schemaVersion: 1, teamId: "team", projectId: "p", featureId: "f", taskId: "t", records: [record], syncedAt: 1, homeOnline: true };
  expect(() => parseTeamBodyRead(read)).not.toThrow();
  expect(() => parseTeamBodyRead({ ...read, records: [{ ...record, reviewer: identity }] })).toThrow();
  expect(() => parseTeamBodyRead({ ...read, pm: identity })).toThrow();
});

test("审查员 / PM 不拿作者冒充：名字和机器为 null，写原因", () => {
  const people = teamPeople({ team: { assigneeCode: "peer-dev", executorInstanceId: "peer-machine", head: null, blockingAsks: 0, mirror: null, freshUntil: null } }, "local-machine");
  expect(people[0]).toMatchObject({ role: "executor", name: "peer-dev", machine: "other" });
  for (const p of people.slice(1)) expect(p).toEqual({ role: p.role, name: null, machine: null, instance: null, reason: IDENTITY_NOT_SYNCED });
});
