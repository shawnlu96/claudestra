/**
 * src/hooks/recall-hook.ts 当子进程跑（HOME 指到临时目录、recall.py 指到不存在的路径）：没装 mem0 的机器上
 * hook 照样注册、照样只注入 HANDOFF；没有 HANDOFF 输出为空；compact 时跳过 HANDOFF；subagent 不注入。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffPath } from "../src/lib/session-recall.js";

const home = mkdtempSync(join(tmpdir(), "recall-hook-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const HOOK = join(import.meta.dir, "..", "src", "hooks", "recall-hook.ts");

async function run(input: Record<string, unknown>): Promise<string> {
  const p = Bun.spawn(["bun", HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...process.env, HOME: home, MEM0_RECALL_SCRIPT: join(home, "no-such-recall.py") },
  });
  const out = await new Response(p.stdout).text();
  expect(await p.exited).toBe(0);
  return out;
}

describe("recall-hook（没有 mem0 的机器）", () => {
  const cwd = join(home, "proj");
  test("没有 HANDOFF → 什么都不输出", async () => {
    expect(await run({ cwd, source: "startup" })).toBe("");
  });
  test("有 HANDOFF → 注入并标明是历史参考；compact 与 subagent 不注入", async () => {
    const p = handoffPath(cwd, home);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "# HANDOFF\n在做什么：修值守");
    const out = await run({ cwd, source: "startup" });
    expect(out).toContain("## HANDOFF · 上次会话交接");
    expect(out).toContain("历史参考");
    expect(out).toContain("在做什么：修值守");
    expect(await run({ cwd, source: "compact" })).toBe("");
    expect(await run({ cwd, source: "startup", agent_id: "sub-1" })).toBe("");
  });
});
