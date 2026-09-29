import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSubSessionOf, readCodexMeta } from "../src/lib/codex-session";
import { isCodexSubThread } from "../src/lib/codex-subthread";
import { sessionRowKey, sessionTree, type SubSessionRow } from "../web/lib/session-nesting";

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
    // 实测形状（审查员扫本机 43 个 rollout + codex 0.153.4）：fork 只带 forked_from_id；exec / vscode 会话 thread_source=user
    const primaries = [{}, { thread_source: "user" }, { thread_source: "user", forked_from_id: "A" }, { source: "exec", thread_source: "user" },
      { source: "vscode" }, { source: "cli", parent_thread_id: "" }];
    for (const extra of primaries) expect(isCodexSubThread({ id: "F", session_id: "F", ...extra })).toBe(false);
    expect(await readCodexMeta(meta("fork.jsonl", { id: "F", session_id: "F", thread_source: "user" }))).toEqual({ sessionId: "F", cwd: "/w" });
  });
  test("codex 新来源：thread_source 不是 user 就算（memory_consolidation / review / compact / thread_spawn），source 是 {subagent} 对象也算", async () => {
    for (const ts of ["memory_consolidation", "review", "compact", "thread_spawn"]) {
      expect(isCodexSubThread({ id: "G", session_id: "G", thread_source: ts })).toBe(true);
    }
    const m = await readCodexMeta(meta("mc.jsonl", { id: "G", session_id: "G", thread_source: "memory_consolidation" }));
    expect(m?.sub).toEqual({ parentId: "", kind: "memory_consolidation" });
    const viaSource = await readCodexMeta(meta("src.jsonl", { id: "H", session_id: "H", thread_source: "user", source: { subagent: "review" } }));
    expect(viaSource?.sub).toEqual({ parentId: "", kind: "review" });
    expect(isCodexSubThread({ id: "H", session_id: "H", source: { subagent: { thread_spawn: {} } } })).toBe(true);
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

describe("sessionRowKey", () => {
  test("同一个 sessionId 两行（不同 cwd）：键不重复；删除确认按键找，只命中一行", () => {
    const rows = [{ sessionId: "D", runtime: "claude-code", cwd: "/a" }, { sessionId: "E", runtime: "claude-code", cwd: "/a" }, { sessionId: "D", runtime: "claude-code", cwd: "/b" }];
    const keys = rows.map(sessionRowKey);
    expect(new Set(keys).size).toBe(3);
    const confirming = sessionRowKey(rows[0]);
    expect(rows.filter((r) => sessionRowKey(r) === confirming)).toEqual([rows[0]]);
    expect(sessionRowKey({ sessionId: "D", runtime: "codex", cwd: "/a" })).not.toBe(keys[0]);
  });
});

// 全部展开、全部列出时的排序与缩进（折叠 / 已纳管分组头见 tests/session-limit.test.ts）
const nestAll = <T extends SubSessionRow>(rows: T[]) => sessionTree(rows, () => true, new Set(rows.map(sessionRowKey)));

describe("sessionTree 全展开", () => {
  test("同一个 sessionId 两行（不同 cwd 的 Claude Code 会话）：按行对象去重，两行都在、顺序不变", () => {
    const D1 = { sessionId: "D", name: "w1" };
    const E = { sessionId: "E", name: "w" };
    const D2 = { sessionId: "D", name: "w2" };
    expect(nestAll([D1, E, D2]).map((r) => r.row)).toEqual([D1, E, D2]);
  });
  const row = (sessionId: string, parentId?: string) => ({ sessionId, name: "w", ...(parentId ? { sub: { parentId, kind: "subagent" } } : {}) });
  test("子会话排到父会话下面并缩进，父不在列表里就留原位", () => {
    const rows = [row("C", "B"), row("X"), row("B", "A"), row("A"), row("Z", "gone")];
    expect(nestAll(rows).map((r) => `${r.row.sessionId}${r.depth}`)).toEqual(["X0", "A0", "B1", "C2", "Z0"]);
  });
  test("成环也不丢行", () => {
    expect(nestAll([row("P", "Q"), row("Q", "P")]).map((r) => r.row.sessionId).sort()).toEqual(["P", "Q"]);
  });
});
