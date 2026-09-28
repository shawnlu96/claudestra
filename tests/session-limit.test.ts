import { describe, expect, test } from "bun:test";
import { limitByMainSessions } from "../src/lib/session-limit";
import { sessionRowKey, sessionTree } from "../web/lib/session-nesting";

const row = (sessionId: string, parentId?: string, managed = false) => ({ sessionId, name: "w", managed, ...(parentId ? { sub: { parentId, kind: "subagent" } } : {}) });

describe("limitByMainSessions：上限只数主会话，子线程跟着主会话走", () => {
  test("子线程再多也不挤掉主会话；被截掉的主会话连同子线程一起走", () => {
    const rows = [row("s1", "A"), row("s2", "s1"), row("A"), row("s3", "A"), row("B"), row("b1", "B"), row("C")];
    expect(limitByMainSessions(rows, 2).map((r) => r.sessionId)).toEqual(["s1", "s2", "A", "s3", "B", "b1"]);
  });
  test("追不到主会话（父文件已删）、成环：各自按主会话算，不丢行", () => {
    const rows = [row("x", "gone"), row("p", "q"), row("q", "p")];
    expect(limitByMainSessions(rows, 10).map((r) => r.sessionId)).toEqual(["x", "p", "q"]);
  });
});

describe("sessionTree：子会话默认收起；主会话已纳管时挂在分组头下，不再平铺", () => {
  const rows = [row("C", "B"), row("X"), row("B", "A"), row("A", undefined, true), row("Z", "gone")];
  const shown = (r: { managed: boolean }) => !r.managed;
  const fmt = (open: Set<string>) =>
    sessionTree(rows, shown, open).map((r) => `${r.row.sessionId}${r.depth}${r.anchor ? "*" : ""}(${r.kids})`).join(" ");

  test("默认收起：已纳管的 A 只剩一个分组头，下面 2 个子会话都算进去", () => {
    expect(fmt(new Set())).toBe("X0(0) A0*(2) Z0(0)");
  });
  test("逐级展开", () => {
    expect(fmt(new Set([sessionRowKey(rows[3])]))).toBe("X0(0) A0*(2) B1(1) Z0(0)");
    expect(fmt(new Set(rows.map(sessionRowKey)))).toBe("X0(0) A0*(2) B1(1) C2(0) Z0(0)");
  });
  test("已纳管又没有未纳管子会话的，不出分组头", () => {
    expect(sessionTree([row("M", undefined, true), row("N")], shown, new Set()).map((r) => r.row.sessionId)).toEqual(["N"]);
  });
});
