/** SYN-2：agent 列表只是忙闲 / 上下文 / 未读变了不重拉 /projects；成员、状态、归属、purpose 变了才拉 */
import { expect, test } from "bun:test";
import { agentsSignature, projectsSignature } from "../web/features/chat/agents-signature";
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
