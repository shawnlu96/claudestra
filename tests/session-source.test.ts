/**
 * runtimeForSessionPath（review #10 阻塞项）：归档副本的路径里没有 Pi 根，
 * 必须靠头行识别，否则归档后的 Pi 会话按 Claude Code 行解析 → 历史恒为空。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runtimeForSessionPath } from "../src/lib/session-source.ts";
import { piAgentDir } from "../src/lib/pi-session.ts";

describe("runtimeForSessionPath", () => {
  test("Pi 会话根之下：按路径判，不读文件", () => {
    expect(runtimeForSessionPath(`${piAgentDir()}/sessions/--x--/2026-09-17T00-00-00_abc.jsonl`)).toBe("pi");
  });

  test("空 / undefined → undefined", () => {
    expect(runtimeForSessionPath(undefined)).toBeUndefined();
    expect(runtimeForSessionPath("")).toBeUndefined();
  });

  test("归档副本：头行是 Pi header ⇒ pi", () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    const p = join(dir, "archived-pi.jsonl");
    writeFileSync(p, JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/x" }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }) + "\n");
    expect(runtimeForSessionPath(p)).toBe("pi");
  });

  test("归档副本：头行是 Claude Code 记录 ⇒ undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    const p = join(dir, "archived-cc.jsonl");
    writeFileSync(p, JSON.stringify({ type: "user", timestamp: "2026-09-17T00:00:00Z", message: { role: "user", content: "hi" } }) + "\n");
    expect(runtimeForSessionPath(p)).toBeUndefined();
  });

  test("不存在 / 空文件 / 坏 JSON ⇒ undefined，不抛", () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    expect(runtimeForSessionPath(join(dir, "nope.jsonl"))).toBeUndefined();
    const empty = join(dir, "empty.jsonl"); writeFileSync(empty, "");
    expect(runtimeForSessionPath(empty)).toBeUndefined();
    const bad = join(dir, "bad.jsonl"); writeFileSync(bad, "{not json\n");
    expect(runtimeForSessionPath(bad)).toBeUndefined();
  });
});
