import { describe, expect, test } from "bun:test";
import { countsUnread, isMyApiChat, unreadOrphans } from "../web/lib/push/unread-keys";

describe("countsUnread", () => {
  test("master 不计未读（前端没有入口能给它发已读）", () => {
    expect(countsUnread("master")).toBe(false);
    expect(countsUnread("claudestra")).toBe(true);
    expect(countsUnread("")).toBe(false);
  });
});

describe("unreadOrphans", () => {
  // 2026-09-23 现场：冒烟测试 agent 删了但未读还在，App 角标卡在 8
  const rows = [
    { agent: "claudestra", count: 0 },
    { agent: "car-talk", count: 3 },
    { agent: "cc-smoke", count: 2 },
    { agent: "codex-smoke", count: 0 },
    { agent: "master", count: 1 },
  ];

  test("列表里没有的 agent 与 master 都算孤儿；列表名带不带 agent- 前缀都认", () => {
    const r = unreadOrphans(rows, ["__master__", "claudestra", "agent-car-talk"]);
    expect(r.agents.sort()).toEqual(["cc-smoke", "codex-smoke", "master"]);
    expect(r.hadUnread).toBe(true);
  });

  test("孤儿全是 0 时不需要同步角标", () => {
    const r = unreadOrphans([{ agent: "gone", count: 0 }, { agent: "car-talk", count: 3 }], ["car-talk"]);
    expect(r).toEqual({ agents: ["gone"], hadUnread: false });
  });

  test("都在列表里就什么都不删", () => {
    expect(unreadOrphans([{ agent: "car-talk", count: 3 }], ["car-talk"])).toEqual({ agents: [], hadUnread: false });
  });
});

describe("isMyApiChat（哪些 api: 对话推送 + 计未读）", () => {
  test("只有本 web 自己的 token；peer / 其它 token 不算；Discord 频道不算", () => {
    expect(isMyApiChat("api:tok_web", "api:tok_web")).toBe(true);
    expect(isMyApiChat("api:tok_peer", "api:tok_web")).toBe(false);
    expect(isMyApiChat("1234567890", "api:tok_web")).toBe(false);
  });
  test("拿不到自己的 token（老 bridge 没有 /whoami）→ 退回旧行为：所有 api: 都算", () => {
    expect(isMyApiChat("api:tok_peer", null)).toBe(true);
  });
});
