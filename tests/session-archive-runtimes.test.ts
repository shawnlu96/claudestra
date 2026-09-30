/**
 * archive 按 registry 条目的 runtime 定位会话文件（T72）：Codex 的 rollout 在 ~/.codex/sessions/YYYY/MM/DD/，
 * Pi 的在 ~/.pi/agent/sessions/<cwd编码>/，都不在 ~/.claude/projects。漏传 runtime 会被当成 Claude Code 找、报「找不到」。
 * 归档副本还得能被历史面板读出来（首行嗅探认出运行时再翻译）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveSession } from "../src/lib/session-archive.js";
import { testChildEnv } from "./test-env.js";
import { realOpsDeps } from "../src/manager/ops-deps.js";
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

const DUAL_SCRIPT = `
const { archiveAgentSession } = await import(${JSON.stringify(join(import.meta.dir, "../src/lib/session-archive.ts"))});
const { archiveRoot, cwd, sid } = JSON.parse(process.argv.at(-1));
console.log(JSON.stringify(await archiveAgentSession("agent-cx", { cwd, sessionId: sid, runtime: "codex" }, undefined, { archiveRoot })));
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
    for (const s of ["Codex", join(home, ".codex", "sessions"), missingSid]) expect(out.missing.note).toContain(s); // 报实际找过的根
    expect(existsSync(`${archiveRoot}-missing`)).toBe(false);
  });
});

describe("CODEX_HOME 另设了根（T72 r1 P1-2）", () => {
  test("HOME 下和 CODEX_HOME 下各有一份同 id 的 rollout：归档拷的是 CODEX_HOME 那份", () => {
    const codexHome = join(home, "codex-home-b");
    const inB = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T05-06-07-${CODEX_SID}.jsonl`);
    mkdirSync(join(inB, ".."), { recursive: true });
    writeFileSync(inB, L({ timestamp: TS, type: "session_meta", payload: { id: CODEX_SID, cwd, source: "B" } }) + "\n");
    const dual = `${archiveRoot}-dual`;
    const r = Bun.spawnSync([process.execPath, "-e", DUAL_SCRIPT, JSON.stringify({ archiveRoot: dual, cwd, sid: CODEX_SID })], {
      env: testChildEnv({ HOME: home, CODEX_HOME: codexHome }),
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    expect(JSON.parse(r.stdout.toString().trim().split("\n").at(-1)!).ok).toBe(true);
    expect(readFileSync(join(dual, "agent-cx", `${CODEX_SID}.jsonl`), "utf8")).toBe(readFileSync(inB, "utf8"));
  });
});

describe("复制失败不能报成功（T72 r1 P1-3）", () => {
  const SID3 = "33333333-4444-5555-6666-777777777777";
  test("源文件读不了：ok:false，说明带原因，不再是「归档已是最新」", async () => {
    const src = join(home, "unreadable", `${SID3}.jsonl`);
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, '{"type":"user"}\n');
    chmodSync(src, 0o000);
    try {
      const r = await archiveSession("agent-x", undefined, SID3, { srcPath: src, archiveRoot: `${archiveRoot}-p13` });
      expect(r).toMatchObject({ ok: false, archived: [] });
      expect(r.note).toContain("没拷上");
      expect(r.note).toContain("EACCES");
      expect(r.note).toContain("下次 archive 会补"); // 权限类是暂时的；.zst 坏了才写「需人工处理」（tests/codex-archive-read.test.ts）
    } finally {
      chmodSync(src, 0o644);
    }
  });

  test("主文件拷上了、子代理文件拷失败：仍是 ok:false，已拷的照列", async () => {
    const src = join(home, "sub-fail", `${SID3}.jsonl`);
    const sub = join(home, "sub-fail", SID3, "subagents", "agent-a.jsonl");
    mkdirSync(join(sub, ".."), { recursive: true });
    writeFileSync(src, '{"type":"user"}\n');
    writeFileSync(sub, '{"type":"assistant"}\n');
    chmodSync(sub, 0o000);
    try {
      const r = await archiveSession("agent-x", undefined, SID3, { srcPath: src, archiveRoot: `${archiveRoot}-p13b` });
      expect(r.ok).toBe(false);
      expect(r.archived).toEqual([join(`${archiveRoot}-p13b`, "agent-x", `${SID3}.jsonl`)]);
      expect(r.note).toContain("agent-a.jsonl");
    } finally {
      chmodSync(sub, 0o644);
    }
  });

  test("kill / remove 用的 deps.archive：归档 ok:false 时写日志，不吞", async () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, "codex-empty"); // 空根：这个 thread 必然找不到，也不去扫真实 ~/.codex
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await realOpsDeps.archive("agent-cx", { cwd, sessionId: "019a1111-0000-7000-8000-000000000000", runtime: "codex" });
    } finally {
      console.error = orig;
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
    expect(logged.some((l) => l.includes("[archive] agent-cx 归档失败") && l.includes("Codex 会话记录不存在"))).toBe(true);
  });
});

describe("换目录 resume 与异常目标（T72 r2）", () => {
  const SID4 = "019a4444-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  test("Codex 线程在新目录 resume 后（registry cwd 变了、rollout 首行没变）：照常归档，note 提示 cwd 不同", async () => {
    const codexHome = join(home, "codex-resume");
    const src = join(codexHome, "sessions", "2026", "09", "30", `rollout-2026-09-30T07-08-09-${SID4}.jsonl`);
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, L({ timestamp: TS, type: "session_meta", payload: { id: SID4, cwd: join(home, "old-tree") } }) + "\n");
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome; // 进程内生效：codexSessionsRoot 调用时才读 CODEX_HOME
    try {
      const r = await archiveSession("agent-cx", join(home, "new-tree"), SID4, { runtime: "codex", archiveRoot: `${archiveRoot}-resume` });
      expect(r.ok).toBe(true);
      expect(r.note).toContain("换目录 resume");
      expect(readFileSync(join(`${archiveRoot}-resume`, "agent-cx", `${SID4}.jsonl`), "utf8")).toBe(readFileSync(src, "utf8"));
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  test("归档目标被占成目录：ok:false，不再报「已是最新」", async () => {
    const src = join(home, "dest-dir", `${SID4}.jsonl`);
    mkdirSync(join(src, ".."), { recursive: true });
    writeFileSync(src, '{"type":"user"}\n');
    const root = `${archiveRoot}-destdir`;
    mkdirSync(join(root, "agent-x", `${SID4}.jsonl`, "junk"), { recursive: true });
    const r = await archiveSession("agent-x", undefined, SID4, { srcPath: src, archiveRoot: root });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("不是普通文件");
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
