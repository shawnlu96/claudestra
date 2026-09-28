import { describe, expect, test } from "bun:test";
import { CONTACTS_STALE_MS, contactOf, listContacts } from "../src/lib/peer-contacts";

describe("联系人列表：peer presence 的只读重排", () => {
  const NOW = Date.parse("2026-09-28T10:00:00.000Z");
  const fresh = new Date(NOW - 30_000).toISOString();
  const old = new Date(NOW - CONTACTS_STALE_MS - 1).toISOString();
  const agents = [{ name: "agent-a", status: "active", busy: true }, { name: "agent-b", status: "active" }, { name: "agent-master", busy: false }];

  test("在线且目录新鲜：列 agent + 忙闲；没返回 busy 的不带；master 永不出现", () => {
    const c = contactOf({ name: "alex", fp: "ab12" }, { online: true, checkedAt: fresh, lastOnlineAt: fresh, latencyMs: 40, remoteAgents: agents }, NOW);
    expect(c).toEqual({ name: "alex", fp: "ab12", online: true, lastOnlineAt: fresh, checkedAt: fresh, stale: false, agents: [{ name: "agent-a", busy: true }, { name: "agent-b" }] });
  });

  test("不带延迟、错误原文、状态字段出去", () => {
    const c = contactOf({ name: "alex" }, { online: false, checkedAt: fresh, error: "certificate has expired at 10.0.0.2", latencyMs: 9, remoteAgents: agents }, NOW);
    expect(JSON.stringify(c)).not.toContain("10.0.0.2");
    expect(c).not.toHaveProperty("latencyMs");
    expect(c.agents.every((a) => !("status" in a))).toBe(true);
  });

  test("离线 / 目录过期：agent 列表保留（最近一次看到的），忙闲不给", () => {
    expect(contactOf({ name: "x" }, { online: false, checkedAt: fresh, remoteAgents: agents }, NOW).agents).toEqual([{ name: "agent-a" }, { name: "agent-b" }]);
    const stale = contactOf({ name: "x" }, { online: true, checkedAt: old, remoteAgents: agents }, NOW);
    expect(stale.stale).toBe(true);
    expect(stale.agents.some((a) => "busy" in a)).toBe(false);
  });

  test("单向 peer 与从没探测过的：online=null，stale，空列表", () => {
    expect(contactOf({ name: "y" }, { online: null, lastInboundAt: fresh }, NOW)).toEqual({ name: "y", online: null, lastInboundAt: fresh, stale: true, agents: [] });
  });

  test("停用的 peer 不列", () => {
    const out = listContacts([{ name: "a" }, { name: "b", disabled: true }], () => ({ online: null }), NOW);
    expect(out.map((c) => c.name)).toEqual(["a"]);
  });
});
