/** SYN-2：agent 列表只是忙闲 / 上下文 / 未读变了不重拉 /projects；成员、状态、归属、purpose 变了才拉 */
import { expect, test } from "bun:test";
import { agentsSignature, projectsSignature, rosterPlan } from "../web/features/chat/agents-signature";
import type { AgentSession } from "../web/features/chat/type";

const a = (over: Partial<AgentSession> = {}) => ({ name: "agent-x", status: "active", purpose: "p", projectId: "proj", busy: false, ...over }) as AgentSession;

test("只是 busy / contextTokens / lastActivityTs / unread 变了：列表要重渲染，但 projects 签名不变", () => {
  const before = [a()];
  const after = [a({ busy: true, contextTokens: 9, lastActivityTs: 5, unread: 3 })];
  expect(agentsSignature(after)).not.toBe(agentsSignature(before));
  expect(projectsSignature(after)).toBe(projectsSignature(before));
});

test("成员增删、状态、归属、purpose 变了：projects 签名变", () => {
  const base = projectsSignature([a()]);
  for (const next of [[a(), a({ name: "agent-y" })], [a({ status: "stopped" })], [a({ projectId: "other" })], [a({ purpose: "q" })], []]) {
    expect(projectsSignature(next)).not.toBe(base);
  }
});

test("只改了 purpose（别的设备 / CLI）：这一拍写回列表并拉一次 /projects，之后的轮询不再重拉（r1 P1 projects-purpose-loop）", () => {
  let state = [a()];
  const server = [a({ purpose: "新用途" })];
  let projectFetches = 0;
  for (let poll = 0; poll < 5; poll++) {
    const plan = rosterPlan(state, server, false, false);
    if (plan.projects) projectFetches++;
    if (plan.update) state = server;
  }
  expect(projectFetches).toBe(1);
  expect(state[0].purpose).toBe("新用途");
});

test("projects 签名里的字段变了，agentsSignature 一定跟着变（否则列表不写回、每拍重拉）", () => {
  for (const over of [{ name: "agent-y" }, { status: "stopped" }, { projectId: "other" }, { purpose: "q" }] as Partial<AgentSession>[]) {
    expect(agentsSignature([a(over)])).not.toBe(agentsSignature([a()]));
  }
});
