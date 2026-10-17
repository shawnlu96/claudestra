import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidOpencodeSessionId,
  opencodeLineToClaudeShape,
  opencodeMirrorPath,
  opencodeRowToSession,
  opencodeMirrorPathNow,
  refreshOpencodeMirror,
  refreshOpencodeMirrorAsync,
  scanOpencodeSessions,
} from "../src/lib/opencode-session.ts";
import { opencodeSource } from "../src/lib/runtimes/opencode-source.ts";

const FIXTURE = join(import.meta.dir, "fixtures/opencode-acp/export.json");
const exported = JSON.parse(readFileSync(FIXTURE, "utf8"));
const SID = exported.info.id as string;
const lines: string[] = exported.messages.map((m: any) => JSON.stringify({ info: m.info, parts: m.parts }));
const tr = (l: string) => opencodeLineToClaudeShape(l, ["claudestra"]);

describe("opencodeLineToClaudeShape（真实导出夹具）", () => {
  test("用户文本 → user；reasoning / step-* 不出", () => {
    expect(tr(lines[0])).toMatchObject({ type: "user", message: { content: expect.stringContaining("run ls with bash") } });
    expect(tr(lines[0])!.timestamp).toBe(new Date(exported.messages[0].info.time.created).toISOString());
  });

  test("tool 部件 → 同一条 assistant 里的 tool_use + tool_result（Bash / Read 改名改键）", () => {
    const rec = tr(lines[1])!;
    expect(rec.type).toBe("assistant");
    const [bashUse, bashRes, readUse, readRes] = rec.message.content;
    expect(bashUse).toMatchObject({ type: "tool_use", name: "Bash", input: { command: "ls" } });
    expect(bashRes).toMatchObject({ type: "tool_result", tool_use_id: bashUse.id, content: "a.txt\n" });
    expect(readUse).toMatchObject({ type: "tool_use", name: "Read", input: { file_path: "<tmp>/work/a.txt" } });
    expect(readRes.tool_use_id).toBe(readUse.id);
    expect(rec.message.content.some((b: any) => b.type === "reasoning" || b.type === "text")).toBe(false);
  });

  test("失败的工具 → is_error 的 tool_result；文本和工具按原顺序", () => {
    const content = tr(lines[4])!.message.content;
    expect(content.map((b: any) => b.type)).toEqual(["text", "tool_use", "tool_result"]);
    expect(content[2]).toMatchObject({ is_error: true, content: expect.stringContaining("File not found") });
  });

  test("压缩：compaction 请求那条跳过，summary 摘要 → compact_boundary", () => {
    expect(tr(lines[8])).toBeNull();
    expect(tr(lines[9])).toMatchObject({ type: "system", subtype: "compact_boundary", compactSummary: expect.stringContaining("Objective") });
  });

  test("我们的 MCP 工具 <server>_<tool> → mcp__<server>__<tool>；别的照旧", () => {
    const mk = (tool: string) => JSON.stringify({
      info: { role: "assistant", sessionID: SID, time: { created: 1 } },
      parts: [{ type: "tool", tool, callID: "c1", state: { status: "running", input: { text: "hi" } } }],
    });
    expect(tr(mk("claudestra_reply"))!.message.content).toEqual([{ type: "tool_use", id: "c1", name: "mcp__claudestra__reply", input: { text: "hi" } }]);
    expect(tr(mk("other_tool"))!.message.content[0].name).toBe("other_tool");
  });

  test("<channel> 包装的用户消息标 isMeta；坏行 / 空消息返回 null", () => {
    const ch = JSON.stringify({ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: '<channel source="x">hi</channel>' }] });
    expect(tr(ch)).toMatchObject({ type: "user", isMeta: true });
    expect(tr("{not json")).toBeNull();
    expect(tr(JSON.stringify({ info: { role: "assistant" }, parts: [{ type: "step-start" }] }))).toBeNull();
  });
});

describe("id / 路径", () => {
  test("isValidOpencodeSessionId", () => {
    expect(isValidOpencodeSessionId(SID)).toBe(true);
    for (const bad of ["", "ses_", "--help", "ses_a/b", "ses_a b", "abc"]) expect(isValidOpencodeSessionId(bad)).toBe(false);
  });

  test("ownsPath / sessionIdFromPath / sniffFirstLine", () => {
    const p = opencodeMirrorPath(SID);
    expect(opencodeSource.ownsPath(p)).toBe(true);
    expect(opencodeSource.ownsPath("/elsewhere/" + SID + ".jsonl")).toBe(false);
    expect(opencodeSource.sessionIdFromPath(p)).toBe(SID);
    expect(opencodeSource.sniffFirstLine!(JSON.parse(lines[0]))).toBe(true);
    expect(opencodeSource.sniffFirstLine!({ type: "session_meta" })).toBe(false);
  });
});

/** 假 opencode：export 吐夹具（会话 id 换成参数）、记调用次数；ses_fail 退 1；db 吐一行 */
function fakeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "oc-fake-"));
  const dataHome = join(dir, "data");
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const db = join(dataHome, "opencode", "opencode.db");
  writeFileSync(db, "");
  const count = join(dir, "count");
  const bin = join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh
echo x >> "${count}"
if [ "$1" = db ]; then cat <<'J'
[{"id":"${SID}","directory":"/w/proj","title":"T","time_updated":5,"parent_id":null,"last_user":"hello\\nthere"}]
J
exit 0; fi
if [ "$2" = ses_fail ]; then echo boom >&2; exit 1; fi
sed "s/${SID}/$2/g" "${FIXTURE}"
`);
  chmodSync(bin, 0o755);
  const env = { ...process.env, OPENCODE_BIN: bin, XDG_DATA_HOME: dataHome };
  const calls = () => readFileSync(count, "utf8").split("\n").filter(Boolean).length;
  const touchDb = (sec: number) => utimesSync(db, sec, sec);
  return { env, calls, touchDb };
}

describe("refreshOpencodeMirror（假 opencode，隔离数据目录）", () => {
  test("导出 → 一行一条消息；库没变就不再导出；库变了且过了节流才重导", () => {
    const { env, calls, touchDb } = fakeEnv();
    const id = "ses_mirrorA1";
    touchDb(1_000_000.1234567); // 亚毫秒 mtime：镜像 mtime 只到毫秒，取整错了就每次都重导
    const p = refreshOpencodeMirror(id, { env, now: () => 10_000 });
    expect(p).toBe(opencodeMirrorPath(id));
    const got = readFileSync(p!, "utf8").trim().split("\n");
    expect(got.length).toBe(lines.length);
    expect(JSON.parse(got[0]).info.sessionID).toBe(id);
    expect(calls()).toBe(1);

    expect(refreshOpencodeMirror(id, { env, now: () => 20_000 })).toBe(p);
    expect(calls()).toBe(1); // 镜像 mtime = 库 mtime → 新鲜

    touchDb(1_000_100);
    expect(refreshOpencodeMirror(id, { env, now: () => 20_500 })).toBe(p);
    expect(calls()).toBe(2);
    touchDb(1_000_200);
    expect(refreshOpencodeMirror(id, { env, now: () => 21_000 })).toBe(p);
    expect(calls()).toBe(2); // 2s 节流内
  });

  test("导出失败：没有旧镜像返回 null；非法 id 不起子进程", () => {
    const { env, calls } = fakeEnv();
    expect(refreshOpencodeMirror("ses_fail", { env, now: () => 1 })).toBeNull();
    expect(refreshOpencodeMirror("--version", { env, now: () => 1 })).toBeNull();
    expect(calls()).toBe(1);
  });

  test("会话来源走的非阻塞路径：先不等导出（没镜像给 null），后台导完下一次就有；同一 id 同时只跑一个导出", async () => {
    const { env, calls, touchDb } = fakeEnv();
    const id = "ses_nonblockB2";
    touchDb(2_000_000);
    expect(opencodeMirrorPathNow(id, { env, now: () => 50_000 })).toBeNull();
    expect(refreshOpencodeMirrorAsync(id, { env, now: () => 50_000 })).toBe(refreshOpencodeMirrorAsync(id, { env }));
    expect(await refreshOpencodeMirrorAsync(id, { env })).toBe(opencodeMirrorPath(id));
    expect(calls()).toBe(1);
    expect(opencodeMirrorPathNow(id, { env, now: () => 60_000 })).toBe(opencodeMirrorPath(id));
    await refreshOpencodeMirrorAsync(id, { env, now: () => 60_000 });
    expect(calls()).toBe(1); // 库没变：不重导
  });

  test("没装 opencode → null", () => {
    expect(refreshOpencodeMirror("ses_nobin1", { env: { OPENCODE_BIN: "/nonexistent/opencode", XDG_DATA_HOME: "/nonexistent" }, now: () => 1 })).toBeNull();
  });
});

describe("scanOpencodeSessions", () => {
  test("db 行 → DiscoveredSession；search 过滤", async () => {
    const { env } = fakeEnv();
    const all = await scanOpencodeSessions(undefined, env);
    expect(all).toEqual([{ sessionId: SID, cwd: "/w/proj", slug: "proj", modifiedAt: new Date(5), lastUserMessage: "hello there", runtime: "opencode" }]);
    expect(await scanOpencodeSessions("nomatch", env)).toEqual([]);
  });

  test("子会话带 sub；没 last_user 用标题；坏行丢弃", () => {
    expect(opencodeRowToSession({ id: SID, directory: "/a", title: "T", time_updated: 1, parent_id: "ses_p" })).toMatchObject({
      lastUserMessage: "T", sub: { parentId: "ses_p", kind: "subagent" },
    });
    expect(opencodeRowToSession({ id: "bad", directory: "/a" })).toBeNull();
  });

  test("没装 opencode → []", async () => {
    expect(await scanOpencodeSessions(undefined, { OPENCODE_BIN: "/nonexistent/opencode" })).toEqual([]);
  });
});
