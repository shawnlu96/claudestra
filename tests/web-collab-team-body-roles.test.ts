/** team-project-TEAMVIS12 · 团队详情参与者：审查员 / PM 取最新 review / spec 上中心同步来的身份（走 teamBodyDetail）。 */
import { expect, test } from "bun:test";
import { IDENTITY_NOT_SYNCED, teamBodyDetail } from "@/features/collab/team-body/team-body-model";
import type { TaskDetail, TeamPerson } from "@/features/collab/collab-detail-model";
import type { TeamBodyReadWire, TeamBodyRecordWire } from "@/lib/api/shared-ledger-team-body";

const LOCAL = "local-machine";
const rec = (kind: "review" | "spec", sourceKey: string, meta?: TeamBodyRecordWire["meta"]): TeamBodyRecordWire => ({
  featureId: "f", taskId: "t", kind, sourceKey, text: kind === "review" ? "审查结论 pass · P0 0 / P1 0 / P2 0" : "# 规格",
  scrubVersion: 1, maskedSegments: 0, digest: "0".repeat(64), ...(meta ? { meta } : {}),
});
const read = (records: TeamBodyRecordWire[]): TeamBodyReadWire => ({ schemaVersion: 1, teamId: "team", projectId: "p", featureId: "f", taskId: "t", records, syncedAt: 1, homeOnline: true });
const detail = { task: { id: "t", team: { assigneeCode: "dev", executorInstanceId: LOCAL, head: null, blockingAsks: 0, mirror: null, freshUntil: null } }, now: 10 } as unknown as TaskDetail;
const people = (records: TeamBodyRecordWire[]): TeamPerson[] => teamBodyDetail(detail, { status: "ok", read: read(records) }, LOCAL).team!.people;
const missing = (role: "reviewer" | "pm"): TeamPerson => ({ role, name: null, machine: null, instance: null, reason: IDENTITY_NOT_SYNCED });

test("[验收线 7] 最新 review / spec 的身份 → 名字是代号，机器按 instanceId 判本机 / 其他，实例 id 只在 instance", () => {
  const got = people([
    rec("review", "4", { kind: "review", ts: 1, reviewer: { memberCode: "old-rev", instanceId: LOCAL } }),
    rec("review", "12", { kind: "review", ts: 2, reviewer: { memberCode: "peer-rev", instanceId: "peer-machine" } }),
    rec("spec", "1", { pm: { memberCode: "old-pm", instanceId: "peer-machine" } }),
    rec("spec", "2", { pm: { memberCode: "home-pm", instanceId: LOCAL } }),
  ]);
  expect(got[0]).toMatchObject({ role: "executor", name: "dev", machine: "local" });
  expect(got[1]).toEqual({ role: "reviewer", name: "peer-rev", machine: "other", instance: "peer-machine", reason: null });
  expect(got[2]).toEqual({ role: "pm", name: "home-pm", machine: "local", instance: LOCAL, reason: null });
  // 没有 instanceId：有名字，机器 null
  expect(people([rec("review", "3", { reviewer: { memberCode: "rev" } })])[1]).toEqual({ role: "reviewer", name: "rev", machine: null, instance: null, reason: null });
});

test("[验收线 7] 最新那条没身份 / 只有 instanceId / 代号含长十六进制 → 仍是『中心暂未同步该角色身份』，不往前找旧的", () => {
  const old = rec("review", "4", { kind: "review", ts: 1, reviewer: { memberCode: "old-rev", instanceId: LOCAL } });
  const oldSpec = rec("spec", "1", { pm: { memberCode: "old-pm" } });
  expect(people([old, rec("review", "9", { kind: "review", ts: 2 }), oldSpec, rec("spec", "2")]).slice(1)).toEqual([missing("reviewer"), missing("pm")]);
  expect(people([old, rec("review", "9", { kind: "review", ts: 2, reviewer: { instanceId: "peer-machine" } })])[1]).toEqual(missing("reviewer"));
  expect(people([rec("review", "9", { reviewer: { memberCode: "m-0123456789abcdef0", instanceId: LOCAL } })])[1]).toEqual(missing("reviewer"));
  expect(people([rec("review", "9", { reviewer: "m-rev" }), rec("spec", "2", { pm: { memberCode: "a b" } })]).slice(1)).toEqual([missing("reviewer"), missing("pm")]);
});
