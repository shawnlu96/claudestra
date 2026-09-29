import { describe, expect, test } from "bun:test";
import { capSubsPerMain, limitByMainSessions } from "../src/lib/session-limit";
import { managedAgentOf, sessionRowKey, sessionTree } from "../web/lib/session-nesting";

const row = (sessionId: string, parentId?: string, managed = false) => ({ sessionId, name: "w", managed, ...(parentId ? { sub: { parentId, kind: "subagent" } } : {}) });

describe("limitByMainSessions：上限只数主会话，子线程跟着主会话走", () => {
  test("子线程再多也不挤掉主会话；被截掉的主会话连同子线程一起走", () => {
    const rows = [row("s1", "A"), row("s2", "s1"), row("A"), row("s3", "A"), row("B"), row("b1", "B"), row("C")];
    expect(limitByMainSessions(rows, 2).map((r) => r.sessionId)).toEqual(["s1", "s2", "A", "s3", "B", "b1"]);
  });
  test("codex exec 一次性会话另算名额，不挤占人开的主会话", () => {
    const shot = (id: string) => ({ ...row(id), oneShot: true as const });
    const rows = [shot("x1"), row("A"), shot("x2"), shot("x3"), row("B"), row("C")];
    expect(limitByMainSessions(rows, 2, 1).map((r) => r.sessionId)).toEqual(["x1", "A", "B"]);
    expect(limitByMainSessions(rows, 2).map((r) => r.sessionId)).toEqual(["x1", "A", "x2", "B"]);
  });
  test("追不到主会话（父文件已删）、成环：各自按主会话算，不丢行", () => {
    const rows = [row("x", "gone"), row("p", "q"), row("q", "p")];
    expect(limitByMainSessions(rows, 10).map((r) => r.sessionId)).toEqual(["x", "p", "q"]);
  });
});

describe("capSubsPerMain：每个主会话只带最新 N 个子线程，多的只报 moreSubs", () => {
  const fmt = (rows: Array<{ sessionId: string; moreSubs?: number }>) => rows.map((r) => r.sessionId + (r.moreSubs ? `+${r.moreSubs}` : "")).join(" ");
  test("按原顺序（新→旧）留前 N 个，省掉的个数记在主会话行上；各主会话分开算", () => {
    const rows = [row("a1", "A"), row("b1", "B"), row("a2", "A"), row("A"), row("a3", "A"), row("B"), row("b2", "B")];
    expect(fmt(capSubsPerMain(rows, 2))).toBe("a1 b1 a2 A+1 B b2");
  });
  test("被省掉的子线程下面的孙辈一起省掉、一起计数（留着会追不到父会话，浮成顶层）", () => {
    const rows = [row("a1", "A"), row("a2", "A"), row("a3", "A"), row("g", "a3"), row("gg", "g"), row("A")];
    expect(fmt(capSubsPerMain(rows, 2))).toBe("a1 a2 A+3");
  });
  test("孙辈也占名额；主会话、父文件已删的孤儿、成环的都不受限", () => {
    const rows = [row("a1", "A"), row("g1", "a1"), row("a2", "A"), row("A"), row("x", "gone"), row("p", "q"), row("q", "p")];
    expect(fmt(capSubsPerMain(rows, 2))).toBe("a1 g1 A+1 x p q");
  });
  test("没超上限：原样返回，不带 moreSubs", () => {
    const rows = [row("a1", "A"), row("A")];
    expect(capSubsPerMain(rows, 50)).toEqual(rows);
  });
  test("3 个主会话 × 400 子线程：每个只剩 50 个 + moreSubs 350", () => {
    const rows = ["A", "B", "C"].flatMap((m) => [row(m), ...Array.from({ length: 400 }, (_, i) => row(`${m}${i}`, m))]);
    const out = capSubsPerMain(rows, 50);
    expect(out.length).toBe(3 * 51);
    expect(out.filter((r) => !r.sub).map((r) => r.moreSubs)).toEqual([350, 350, 350]);
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
  test("后端省掉的子线程数原样带到树行上", () => {
    const tree = sessionTree([{ ...row("A"), moreSubs: 7 }, row("a1", "A")], () => true, new Set());
    expect(tree.map((r) => [r.row.sessionId, r.kids, r.more])).toEqual([["A", 1, 7]]);
  });
});

describe("分组头的「已纳管」只看 agentName（临时目录的父会话也会当分组头，但没纳管）", () => {
  test("父会话 cwd=/tmp/x、未纳管，子线程 cwd=/p：是分组头，但不标已纳管", () => {
    const parent = { sessionId: "P", name: "x", cwd: "/tmp/x", agentName: null };
    const kid = { sessionId: "k", name: "x", cwd: "/p", agentName: null, sub: { parentId: "P", kind: "subagent" } };
    const isUnmanaged = (s: { cwd: string; agentName: string | null }) => !s.agentName && !s.cwd.startsWith("/tmp/");
    const [head] = sessionTree([parent, kid], isUnmanaged, new Set());
    expect([head.row.sessionId, head.anchor, head.kids]).toEqual(["P", true, 1]);
    expect(managedAgentOf(head.row)).toBeNull();
  });
  test("已纳管：去掉 agent- 前缀", () => {
    expect(managedAgentOf({ agentName: "agent-codex-w" })).toBe("codex-w");
  });
});
