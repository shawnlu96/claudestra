import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexMeta } from "../src/lib/codex-session";
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

describe("nestSubSessions", () => {
  const row = (sessionId: string, parentId?: string) => ({ sessionId, name: "w", ...(parentId ? { sub: { parentId, kind: "subagent" } } : {}) });
  test("子会话排到父会话下面并缩进，父不在列表里就留原位", () => {
    const rows = [row("C", "B"), row("X"), row("B", "A"), row("A"), row("Z", "gone")];
    expect(nestSubSessions(rows).map((r) => `${r.row.sessionId}${r.depth}`)).toEqual(["X0", "A0", "B1", "C2", "Z0"]);
  });
  test("成环也不丢行", () => {
    expect(nestSubSessions([row("P", "Q"), row("Q", "P")]).map((r) => r.row.sessionId).sort()).toEqual(["P", "Q"]);
  });
});
