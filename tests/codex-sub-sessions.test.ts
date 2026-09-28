import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSubSessionOf, isCodexSubThread, readCodexMeta } from "../src/lib/codex-session";
import { nestSubSessions } from "../web/lib/session-nesting";

// Codex 的子线程（subagent / 自动审查）与主会话同 cwd，列表里分不出主从；session_meta 里 id≠session_id 就是子线程
const dir = mkdtempSync(join(tmpdir(), "codex-sub-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const meta = (name: string, payload: object) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ type: "session_meta", payload: { cwd: "/w", ...payload } }) + "\n");
  return p;
};

describe("readCodexMeta 子线程", () => {
  test("主会话：id=session_id，不带 sub", async () => {
    expect(await readCodexMeta(meta("main.jsonl", { id: "A", session_id: "A", thread_source: "user" }))).toEqual({ sessionId: "A", cwd: "/w" });
  });
  test("subagent：自己的 id + 直接父会话 + 昵称", async () => {
    const m = await readCodexMeta(meta("sub.jsonl", { id: "B", session_id: "A", parent_thread_id: "A", thread_source: "subagent", agent_nickname: "Popper" }));
    expect(m).toEqual({ sessionId: "B", cwd: "/w", sub: { parentId: "A", kind: "subagent", nickname: "Popper" } });
  });
  test("自动审查线程挂在 subagent 下（parent_thread_id 是直接父，不是根）", async () => {
    const m = await readCodexMeta(meta("rev.jsonl", { id: "C", session_id: "A", parent_thread_id: "B", thread_source: "guardian_review" }));
    expect(m?.sub).toEqual({ parentId: "B", kind: "guardian_review" });
  });
});

describe("子线程判定：id≠session_id / 有 parent_thread_id / 来源是 subagent 或自动审查，任一即算", () => {
  test("只带 parent_thread_id（id = session_id）也算子会话，父会话取 parent_thread_id", async () => {
    const m = await readCodexMeta(meta("p-only.jsonl", { id: "D", session_id: "D", parent_thread_id: "A" }));
    expect(m?.sub).toEqual({ parentId: "A", kind: "subagent" });
  });
  test("只带 thread_source=guardian_review（id = session_id、没有父会话字段）：算子会话，父会话不明记空串", async () => {
    const m = await readCodexMeta(meta("g-only.jsonl", { id: "E", session_id: "E", thread_source: "guardian_review" }));
    expect(m?.sub).toEqual({ parentId: "", kind: "guardian_review" });
  });
  test("fork：id = session_id、没有 parent_thread_id、来源不是子线程 → 独立会话，不能误判", async () => {
    for (const extra of [{}, { thread_source: "user" }, { thread_source: "cli", parent_thread_id: "" }]) {
      expect(isCodexSubThread({ id: "F", session_id: "F", ...extra })).toBe(false);
    }
    expect(await readCodexMeta(meta("fork.jsonl", { id: "F", session_id: "F", thread_source: "user" }))).toEqual({ sessionId: "F", cwd: "/w" });
  });
  test("按 sessionId 查归属：找得到子线程文件 → sub；主会话 / 找不到 → null", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-sub-root-"));
    const day = join(root, "2026", "09", "28");
    mkdirSync(day, { recursive: true });
    const id = (n: number) => `019a0000-0000-7000-8000-00000000000${n}`;
    const write = (n: number, payload: object) =>
      writeFileSync(join(day, `rollout-2026-09-28T00-00-0${n}-${id(n)}.jsonl`), JSON.stringify({ type: "session_meta", payload: { cwd: "/w", ...payload } }) + "\n");
    write(1, { id: id(1), session_id: id(1) });
    write(2, { id: id(2), session_id: id(1), thread_source: "guardian_review" });
    expect(await codexSubSessionOf(id(2), root)).toEqual({ parentId: id(1), kind: "guardian_review" });
    expect(await codexSubSessionOf(id(1), root)).toBeNull();
    expect(await codexSubSessionOf(id(9), root)).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("nestSubSessions", () => {
  test("同一个 sessionId 两行（不同 cwd 的 Claude Code 会话）：按行对象去重，两行都在、顺序不变", () => {
    const D1 = { sessionId: "D", name: "w1" };
    const E = { sessionId: "E", name: "w" };
    const D2 = { sessionId: "D", name: "w2" };
    expect(nestSubSessions([D1, E, D2]).map((r) => r.row)).toEqual([D1, E, D2]);
  });
  const row = (sessionId: string, parentId?: string) => ({ sessionId, name: "w", ...(parentId ? { sub: { parentId, kind: "subagent" } } : {}) });
  test("子会话排到父会话下面并缩进，父不在列表里就留原位", () => {
    const rows = [row("C", "B"), row("X"), row("B", "A"), row("A"), row("Z", "gone")];
    expect(nestSubSessions(rows).map((r) => `${r.row.sessionId}${r.depth}`)).toEqual(["X0", "A0", "B1", "C2", "Z0"]);
  });
  test("成环也不丢行", () => {
    expect(nestSubSessions([row("P", "Q"), row("Q", "P")]).map((r) => r.row.sessionId).sort()).toEqual(["P", "Q"]);
  });
});
