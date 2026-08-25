/**
 * ask_codex 的 codex runner 纯逻辑单测(v2.20+)。
 * 关键契约:resume 子命令 flag 面比 exec 窄(0.149 实测不吃 -s/-C/--color),
 * 沙箱/cwd 只在建线程那次生效;danger-full-access 永不暴露。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildCodexArgs,
  extractSessionId,
  readThreads,
  writeThreads,
  CODEX_SANDBOXES,
} from "../src/lib/codex.js";

describe("buildCodexArgs", () => {
  test("新会话:sandbox/cwd/json/-o 全带,prompt 走 stdin", () => {
    const a = buildCodexArgs(
      { prompt: "x", cwd: "/tmp/repo", sandbox: "workspace-write" },
      null,
      "/tmp/last.txt"
    );
    expect(a[0]).toBe("exec");
    expect(a).toContain("--json");
    expect(a).toContain("-s");
    expect(a[a.indexOf("-s") + 1]).toBe("workspace-write");
    expect(a[a.indexOf("-C") + 1]).toBe("/tmp/repo");
    expect(a[a.length - 1]).toBe("-");
  });
  test("resume:不带 -s/-C/--color(0.149 会拒),沙箱继承原会话", () => {
    const a = buildCodexArgs({ prompt: "x", cwd: "/tmp/repo", sandbox: "read-only" }, "sess-123", "/tmp/last.txt");
    expect(a.slice(0, 3)).toEqual(["exec", "resume", "sess-123"]);
    expect(a).not.toContain("-s");
    expect(a).not.toContain("-C");
    expect(a).not.toContain("--color");
    expect(a).toContain("--json");
  });
  test("非法 sandbox 落回 read-only;danger 永不在白名单", () => {
    const a = buildCodexArgs({ prompt: "x", sandbox: "danger-full-access" as never }, null, "/tmp/l");
    expect(a[a.indexOf("-s") + 1]).toBe("read-only");
    expect(CODEX_SANDBOXES).not.toContain("danger-full-access" as never);
  });
});

describe("extractSessionId(多形态兼容,alpha 事件契约不稳)", () => {
  test("thread.started / session_id / 嵌套 msg 三形态都认", () => {
    expect(extractSessionId('{"type":"thread.started","thread_id":"01a039d7-0621"}')).toBe("01a039d7-0621");
    expect(extractSessionId('{"msg":{"session_id":"abcdef123456"}}')).toBe("abcdef123456");
    expect(extractSessionId('noise\n{"session_id":"0123456789ab"}\n')).toBe("0123456789ab");
  });
  test("抠不到返回 null(只影响续聊,不炸本轮)", () => {
    expect(extractSessionId('{"type":"item.completed"}\nplain text')).toBeNull();
    expect(extractSessionId("")).toBeNull();
  });
});

describe("threads 注册表", () => {
  test("读写往返 + 缺文件返回空表", () => {
    const dir = mkdtempSync(join(tmpdir(), "codex-t-"));
    const p = join(dir, "threads.json");
    expect(readThreads(p)).toEqual({});
    const entry = { sessionId: "s1", createdAt: "t0", lastUsedAt: "t1", cwd: "/x" };
    writeThreads({ pm: entry }, p);
    expect(readThreads(p)).toEqual({ pm: entry });
    rmSync(dir, { recursive: true, force: true });
  });
});
