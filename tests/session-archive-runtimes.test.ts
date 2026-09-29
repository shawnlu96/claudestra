/**
 * archive 按 registry 条目的 runtime 定位会话文件（T72）：Codex 的 rollout 在 ~/.codex/sessions/YYYY/MM/DD/，
 * Pi 的在 ~/.pi/agent/sessions/<cwd编码>/，都不在 ~/.claude/projects。漏传 runtime 会被当成 Claude Code 找、报「找不到」。
 * 归档副本还得能被历史面板读出来（首行嗅探认出运行时再翻译）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSession } from "../src/lib/session-archive.js";
import { testChildEnv } from "./test-env.js";
import { encodePiSessionDir } from "../src/lib/pi-session.js";

const home = mkdtempSync(join(tmpdir(), "archive-rt-home-"));
const realPiDir = process.env.PI_CODING_AGENT_DIR;
const archiveRoot = join(home, "archive");
const cwd = join(home, "repo");
const CODEX_SID = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
const PI_SID = "0f1e2d3c-4b5a-6978-8a9b-acbdcedf0102";
const TS = "2026-09-30T01:02:03.000Z";
const L = (o: unknown) => JSON.stringify(o);
const rollout = join(home, ".codex", "sessions", "2026", "09", "30", `rollout-2026-09-30T01-02-03-${CODEX_SID}.jsonl`);

beforeAll(() => {
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(rollout, ".."), { recursive: true });
  writeFileSync(rollout, [
    L({ timestamp: TS, type: "session_meta", payload: { id: CODEX_SID, cwd } }),
    L({ timestamp: TS, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看下这个" }] } }),
    L({ timestamp: TS, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "结论是…" }] } }),
  ].join("\n") + "\n");
});
afterAll(() => {
  if (realPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realPiDir;
  rmSync(home, { recursive: true, force: true });
});

/**
 * Codex 的会话根取 os.homedir()，Bun 在进程启动时就定下它，测试进程里改 HOME 不生效 ⇒ 带临时 HOME 起子进程跑，
 * ~/.codex/sessions 落在临时目录里，碰不到真实 rollout。argv 里给参数，stdout 最后一行回 JSON。
 */
const CODEX_SCRIPT = `
const { archiveAgentSession, archiveSession } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/session-archive.ts"))});
const { listAgentSessions, readSessionHistory } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/session-history.ts"))});
const { archiveRoot, cwd, sid, missingSid } = JSON.parse(process.argv.at(-1));
const info = { cwd, sessionId: sid, runtime: "codex" };
const first = await archiveAgentSession("agent-cx", info, undefined, { archiveRoot });
const again = await archiveAgentSession("agent-cx", info, undefined, { archiveRoot });
const listed = await listAgentSessions("agent-cx", { archiveRoot });
const page = first.archived[0] ? await readSessionHistory(first.archived[0]) : null;
const noRuntime = await archiveSession("agent-cx", cwd, sid, { archiveRoot: archiveRoot + "-no-runtime" });
const missing = await archiveAgentSession("agent-cx", { ...info, sessionId: missingSid }, undefined, { archiveRoot: archiveRoot + "-missing" });
console.log(JSON.stringify({
  first, again, noRuntime, missing,
  listed: listed.map((s) => [s.sessionId, s.source]),
  messages: page ? page.messages.map((m) => [m.role, m.text]) : null,
}));
`;

describe("Codex agent 的归档（子进程，临时 HOME）", () => {
  const missingSid = "019a0000-0000-7000-8000-000000000000";
  let out: Record<string, any>;
  beforeAll(() => {
    const r = Bun.spawnSync([process.execPath, "-e", CODEX_SCRIPT, JSON.stringify({ archiveRoot, cwd, sid: CODEX_SID, missingSid })], {
      env: testChildEnv({ HOME: home }),
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    out = JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!);
  });

  test("按 registry 条目归档（runtime 跟着条目走）：rollout 原样快照进 archive/<agent>/<threadId>.jsonl", () => {
    const dest = join(archiveRoot, "agent-cx", `${CODEX_SID}.jsonl`);
    expect(out.first).toMatchObject({ ok: true, archived: [dest] });
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(rollout, "utf8"));
    expect(out.again).toMatchObject({ ok: true, archived: [] }); // 没变大不重拷，与 Claude Code 同一套 copyIfLarger
  });

  test("索引与历史读取：listAgentSessions 列出这条，readSessionHistory 读出对话", () => {
    expect(out.listed).toEqual([[CODEX_SID, "archive"]]);
    expect(out.messages).toEqual([["user", "帮我看下这个"], ["assistant", "结论是…"]]);
  });

  test("漏传 runtime = 按 Claude Code 找，找不到（这就是 T72 之前 manager archive 的样子）", () => {
    expect(out.noRuntime.ok).toBe(false);
  });

  test("rollout 不在：ok:false，说明写明是 Codex、去哪找过，不静默成功", () => {
    expect(out.missing).toMatchObject({ ok: false, archived: [] });
    for (const s of ["Codex", "~/.codex/sessions", missingSid]) expect(out.missing.note).toContain(s);
    expect(existsSync(`${archiveRoot}-missing`)).toBe(false);
  });
});

describe("Pi agent 的归档（同一个缺口）", () => {
  test("按 registry 条目的 cwd + runtime 找到带时间戳前缀的会话文件", async () => {
    const dir = join(home, ".pi", "agent", "sessions", encodePiSessionDir(cwd));
    mkdirSync(dir, { recursive: true });
    const src = join(dir, `2026-09-30T01-02-03-000Z_${PI_SID}.jsonl`);
    writeFileSync(src, L({ type: "session", id: PI_SID, cwd }) + "\n");
    const r = await archiveSession("agent-pi", cwd, PI_SID, { runtime: "pi", archiveRoot });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(archiveRoot, "agent-pi", `${PI_SID}.jsonl`), "utf8")).toBe(readFileSync(src, "utf8"));
  });

  test("Pi 文件不在：说明写明是 Pi", async () => {
    const r = await archiveSession("agent-pi", cwd, "0f000000-0000-4000-8000-000000000000", { runtime: "pi", archiveRoot });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("Pi");
  });
});
