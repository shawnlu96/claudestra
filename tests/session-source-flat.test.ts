/**
 * session-source 的入口把 cwd / sessionId 换成 Latin-1 存储再交给适配器（SCH-1）：Bun 1.3.14 里由 UTF-16 存储的字符串拼出的同步 fs 路径
 * 每次调用漏原生内存，调度器每轮对全部 registry agent 求会话路径，线性上涨。存储宽度用 bun:jsc describe 的 8Bit 标志断言；
 * 泄漏本身由 scripts/scheduler-memory-probe.ts 手动量（footprint，只在 macOS）。
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { describe as jscDescribe } from "bun:jsc";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findSessionJsonlBySessionId, flatAscii, listSessionJsonls, sessionFileMtime, sessionJsonlPath } from "../src/lib/session-source.ts";
import { sourceFor } from "../src/lib/runtimes/index.ts";
import { projectsSlug } from "../src/lib/jsonl-cost.ts";

const SID = "23d59aac-59aa-475d-9d8e-2f084ed9d56e";
const narrow = (s: string) => jscDescribe(s).includes("8Bit:(1)");

/** registry 的样子：文件里有中文，JSON.parse 出来的 ASCII 字段也是 UTF-16 存储 */
function wide(cwd: string): { cwd: string; sid: string } {
  const p = join(mkdtempSync(join(tmpdir(), "ssf-")), "registry.json");
  writeFileSync(p, JSON.stringify({ purpose: "调度器内存", cwd, sid: SID }));
  const r = JSON.parse(readFileSync(p, "utf8")) as { cwd: string; sid: string };
  expect(narrow(r.sid)).toBe(false); // 前提：不然这组用例什么都没测到
  return r;
}

const spies: { mockRestore(): void }[] = [];
afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });

describe("flatAscii", () => {
  test("ASCII：值不变，存储换成 Latin-1", () => {
    const r = wide("/tmp/proj");
    expect(flatAscii(r.sid)).toBe(SID);
    expect(narrow(flatAscii(r.sid))).toBe(true);
    expect(narrow(flatAscii(r.cwd))).toBe(true);
  });

  test("含非 ASCII：原样返回", () => {
    const s = "/Users/x/文稿/proj";
    expect(flatAscii(s)).toBe(s);
    expect(flatAscii("")).toBe("");
  });
});

describe("入口交给适配器的都是 Latin-1 存储", () => {
  for (const runtime of [undefined, "pi", "codex"]) {
    test(`runtime=${runtime ?? "claude-code"}`, async () => {
      const src = sourceFor(runtime), seen: string[] = [];
      spies.push(spyOn(src, "sessionPath").mockImplementation((c, s) => { seen.push(c, s); return null; }));
      spies.push(spyOn(src, "findSessionById").mockImplementation((s) => { seen.push(s); return null; }));
      spies.push(spyOn(src, "listSessionsForCwd").mockImplementation((c) => { seen.push(c); return []; }));
      const r = wide("/tmp/proj");
      sessionJsonlPath(runtime, r.cwd, r.sid);
      await sessionFileMtime(r.cwd, r.sid, runtime);
      findSessionJsonlBySessionId(runtime, r.sid);
      listSessionJsonls(runtime, r.cwd);
      expect(seen).toHaveLength(6);
      expect(seen.every(narrow)).toBe(true);
    });
  }
});

test("Claude Code 真实落点：同一个文件，返回的路径也是 Latin-1 存储", () => {
  const home = mkdtempSync(join(tmpdir(), "ssf-home-")), cwd = mkdtempSync(join(tmpdir(), "ssf-cwd-"));
  const dir = join(home, ".claude", "projects", projectsSlug(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${SID}.jsonl`), "");
  const old = process.env.HOME;
  process.env.HOME = home;
  try {
    const r = wide(cwd), got = sessionJsonlPath(undefined, r.cwd, r.sid);
    expect(got).toBe(`${home}/.claude/projects/${projectsSlug(cwd)}/${SID}.jsonl`);
    expect(narrow(got!)).toBe(true);
  } finally { process.env.HOME = old; }
});
