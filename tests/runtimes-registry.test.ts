/**
 * 运行时注册表的契约（v2.24+）。
 *
 * owner 2026-09-22：「不要每样都做一套。加一些标准接口，让它可扩展性强一点，日后
 * 还要加别的。」这个文件就是那份「标准」的可执行版本：**加一种运行时时，这里应该
 * 只需要往 EXPECTED 里加一行**；如果还得改别的测试，说明抽象漏了。
 */
import { describe, test, expect } from "bun:test";
import {
  allSources,
  claudeCodeAdapter,
  codexAdapter,
  isKnownRuntime,
  isManageableRuntime,
  piAdapter,
  sourceFor,
  sourceIdForPath,
  DEFAULT_RUNTIME,
} from "../src/lib/runtimes/index.js";

const EXPECTED = [
  { id: "claude-code", manageable: true },
  { id: "pi", manageable: true },
  { id: "codex", manageable: false },
];

describe("注册表契约", () => {
  test("注册的运行时与预期一致（加一种就改这一处）", () => {
    expect(allSources().map((s) => s.id).sort()).toEqual(EXPECTED.map((e) => e.id).sort());
  });

  test("每个适配器都实现了会话来源接口的全部必填方法", () => {
    for (const s of allSources()) {
      for (const m of ["scanSessions", "sessionPath", "findSessionById", "listSessionsForCwd", "ownsPath", "translateLine"]) {
        expect(typeof (s as never as Record<string, unknown>)[m]).toBe("function");
      }
      expect(typeof s.label).toBe("string");
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  test("manageable 如实反映「能不能收编成可对话的 agent」", () => {
    for (const e of EXPECTED) expect(sourceFor(e.id).manageable).toBe(e.manageable);
    // Codex 只读不是「做不到」而是「还没接线」，但在接完之前必须如实报 false——
    // 前端据此不渲染收编按钮，摆一个点了必失败的按钮比不摆更糟。
    expect(isManageableRuntime("codex")).toBe(false);
  });
});

describe("sourceFor", () => {
  test("按 id 取", () => {
    expect(sourceFor("pi")).toBe(piAdapter);
    expect(sourceFor("codex")).toBe(codexAdapter);
    expect(sourceFor("claude-code")).toBe(claudeCodeAdapter);
  });

  test("未知 / 缺省一律回 Claude Code —— 历史数据没有 runtime 字段，那时只有它", () => {
    expect(sourceFor(undefined)).toBe(claudeCodeAdapter);
    expect(sourceFor(null)).toBe(claudeCodeAdapter);
    expect(sourceFor("gpt-9")).toBe(claudeCodeAdapter);
    expect(DEFAULT_RUNTIME).toBe("claude-code");
  });

  test("isKnownRuntime 分得清「认识」和「兜底」", () => {
    expect(isKnownRuntime("codex")).toBe(true);
    expect(isKnownRuntime("gpt-9")).toBe(false);
    expect(isKnownRuntime(undefined)).toBe(false);
  });
});

describe("sourceIdForPath", () => {
  const home = process.env.HOME || "/Users/x";

  test("Pi 与 Codex 按根目录认出来（零 I/O）", () => {
    expect(sourceIdForPath(`${home}/.pi/agent/sessions/--x/2026_abc.jsonl`)).toBe("pi");
    expect(sourceIdForPath(`${home}/.codex/sessions/2026/09/22/rollout-2026-09-22T16-14-49-01a0c7f7-a1d2-7d71-92fb-e2936564d987.jsonl`)).toBe("codex");
  });

  test("Claude Code 回 undefined —— 调用方按默认处理，是历史行为", () => {
    expect(sourceIdForPath(`${home}/.claude/projects/p/abc.jsonl`)).toBeUndefined();
  });

  test("空路径不炸", () => {
    expect(sourceIdForPath(undefined)).toBeUndefined();
    expect(sourceIdForPath("")).toBeUndefined();
  });

  test("归档副本（两个根都不沾）落到首行嗅探，读不到就 undefined", () => {
    // 真实归档路径长这样：~/.claude-orchestrator/archive/<agent>/<sid>.jsonl
    expect(sourceIdForPath(`${home}/.claude-orchestrator/archive/agent-x/nope.jsonl`)).toBeUndefined();
  });
});
