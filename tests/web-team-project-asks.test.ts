/** web/features/asks/team-project-asks.ts（UXASK2）：团队项目确认卡的识别复用 projectSourceCards，分组按 createdBy 拿出所有团队项目确认卡 */
import { describe, expect, test } from "bun:test";
import type { WebAsk } from "@/features/asks/asks-model";
import { isTeamProjectAsk, splitTeamProject, teamProjectCardOf } from "@/features/asks/team-project-asks";
import { projectSourceCards } from "@/lib/shared-projects-source";

const NOW = 1_800_000_000_000;
const ask = (over: Partial<WebAsk>): WebAsk => ({
  id: "x", fromAgent: null, assignee: null, createdBy: null, project: "master", taskId: null, title: "t", context: "c", body: "", kind: "authorize", kindHint: null,
  source: "system", options: [], allowText: false, blocking: true, urgency: "normal", state: "open", answer: null,
  createdAt: NOW - 1000, updatedAt: NOW - 1000, expiresAt: NOW + 60_000, canAnswer: true, ...over,
});
const buttons = (a: string, d: string) => ({ type: "buttons", buttons: [{ id: a, label: `${a}-label` }, { id: d, label: `${d}-label` }] });
const select = { type: "select", id: "sl_join_local", options: [{ value: "create", label: "新建本机项目" }, { value: "local-app", label: "绑定本机工作区" }] };
const choice = { sharedProjectChoice: { selectId: "sl_join_local", recommended: "create" } } as WebAsk["extra"];

const join = ask({ id: "join", createdBy: "system:shared-ledger-join-offer", options: [buttons("sl_join_accept", "sl_join_decline"), select], extra: choice,
  bind: { action: "shared-ledger.join", params: { centerId: "secret-center" } } });
const create = ask({ id: "create", createdBy: "system:shared-projects", options: [buttons("shared_project_confirm", "shared_project_cancel")] });
const tampered = ask({ id: "tampered", createdBy: "system:shared-projects", options: [buttons("shared_project_confirm", "shared_project_other")] });
const badSelect = ask({ id: "bad-select", createdBy: "system:shared-ledger-join-offer", options: [buttons("sl_join_accept", "sl_join_decline"),
  { ...select, options: [{ value: "bad value!", label: "x" }] }], extra: choice });
const proposal = ask({ id: "proposal", createdBy: "system:center-proposal-inbox", options: [buttons("cp_approve", "cp_reject")],
  extra: { centerProposal: { localProjectId: "p" } } });
const decide = ask({ id: "decide", fromAgent: "agent-dev-1", kind: "decide", source: "reply", options: [buttons("a", "b")] });

describe("teamProjectCardOf", () => {
  test("两种 createdBy 的合法卡：结果和 projectSourceCards 逐条一致", () => {
    for (const a of [join, create]) expect(teamProjectCardOf(a, NOW)).toEqual(projectSourceCards({ asks: [a] }, NOW)[0]!);
    expect(teamProjectCardOf(join, NOW)!.choice).toEqual({ selectId: "sl_join_local", recommended: "create", options: select.options });
    expect(teamProjectCardOf(create, NOW)!.choice).toBeNull();
    expect(teamProjectCardOf(create, NOW)!.accept).toEqual({ id: "shared_project_confirm", label: "shared_project_confirm-label" });
  });
  test("卡面不带 bind.params", () => {
    expect(JSON.stringify(teamProjectCardOf(join, NOW))).not.toContain("secret-center");
  });
  test("按钮被改过、选择行不合法、已过期、不是 system：null", () => {
    expect(teamProjectCardOf(tampered, NOW)).toBeNull();
    expect(teamProjectCardOf(badSelect, NOW)).toBeNull();
    expect(teamProjectCardOf(create, create.expiresAt)).toBeNull();
    expect(teamProjectCardOf({ ...create, source: "reply" }, NOW)).toBeNull();
  });
});

describe("splitTeamProject", () => {
  test("createdBy 命中的都进 team（含规则不认的），其他系统授权卡和拍板卡留在 rest，顺序不变", () => {
    const { team, rest } = splitTeamProject([decide, join, proposal, tampered, create, badSelect]);
    expect(team.map((a) => a.id)).toEqual(["join", "tampered", "create", "bad-select"]);
    expect(rest.map((a) => a.id)).toEqual(["decide", "proposal"]);
    expect(team.map((a) => teamProjectCardOf(a, NOW) === null)).toEqual([false, true, false, true]);
  });
  test("isTeamProjectAsk 只看 createdBy 是不是两种之一（原型链上的键不算）", () => {
    expect([join, create, tampered, proposal, decide].map(isTeamProjectAsk)).toEqual([true, true, true, false, false]);
    expect(isTeamProjectAsk({ createdBy: "toString" })).toBe(false);
    expect(isTeamProjectAsk({ createdBy: null })).toBe(false);
  });
  test("空列表", () => expect(splitTeamProject([])).toEqual({ team: [], rest: [] }));
});
