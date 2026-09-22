import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  agentsFromList,
  createFailureLatch,
  interpretManagerRun,
  runManagerProcess,
  stderrTail,
} from "../src/lib/run-manager";

const base = { cmd: "list", out: "", err: "", exitCode: 0, timedOut: false, budgetMs: 20_000 };

describe("interpretManagerRun", () => {
  test("有 JSON 以 JSON 为准（含 manager 自己报的 ok:false）", () => {
    expect(interpretManagerRun({ ...base, out: '{"ok":true,"agents":[]}' })).toEqual({ ok: true, agents: [] });
    expect(interpretManagerRun({ ...base, out: '{"ok":false,"error":"x"}', exitCode: 1 })).toEqual({ ok: false, error: "x" });
  });

  test("顶层崩溃（stdout 空）时带上退出码和 stderr 尾巴，而不是一句「执行失败」", () => {
    const r = interpretManagerRun({
      ...base,
      exitCode: 1,
      err: "at foo\nSyntaxError: Unexpected token\n    at bar\n\nerror: script exited\n",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit=1");
    expect(r.error).toContain("SyntaxError: Unexpected token");
    expect(r.error).toContain("error: script exited");
  });

  test("超时", () => {
    expect(interpretManagerRun({ ...base, timedOut: true }).error).toContain("超时");
  });
});

test("stderrTail 取末 n 个非空行", () => {
  expect(stderrTail("a\n\nb\nc\nd\n", 2)).toBe("c | d");
});

describe("agentsFromList", () => {
  test("失败就抛，不当成空列表", () => {
    expect(() => agentsFromList({ ok: false, error: "registry 坏了" })).toThrow("registry 坏了");
    expect(() => agentsFromList(undefined)).toThrow();
  });
  test("正常返回 agents", () => {
    expect(agentsFromList({ ok: true, agents: [{ name: "a" }] })).toEqual([{ name: "a" }]);
    expect(agentsFromList({ ok: true })).toEqual([]);
  });
});

test("createFailureLatch 只在状态切换时出声", () => {
  const logs: string[] = [];
  const latch = createFailureLatch("x", (m) => logs.push(m));
  latch.fail(new Error("e1"));
  latch.fail(new Error("e2"));
  latch.ok();
  latch.ok();
  expect(logs.length).toBe(2);
  expect(logs[0]).toContain("e1");
  expect(logs[1]).toContain("恢复");
});

describe("runManagerProcess（真子进程）", () => {
  test("stderr 被读回来", async () => {
    const d = mkdtempSync(join(tmpdir(), "runmgr-"));
    const script = join(d, "fake-manager.ts");
    writeFileSync(script, 'console.error("boom: registry 读不了"); process.exit(3);');
    const r = await runManagerProcess(["list"], { bunPath: process.execPath, managerPath: script, timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("exit=3");
    expect(r.error).toContain("boom: registry 读不了");
  });

  test("超时强杀", async () => {
    const d = mkdtempSync(join(tmpdir(), "runmgr-"));
    const script = join(d, "hang.ts");
    writeFileSync(script, "await new Promise((r) => setTimeout(r, 60_000));");
    const r = await runManagerProcess(["list"], { bunPath: process.execPath, managerPath: script, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  });
});
