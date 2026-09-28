import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// outputSync：大输出写完才返回，读方慢也拿到完整一行 JSON（manager sessions 带 Codex 子线程约 180KB，曾被截在 64KB）
describe("outputSync", () => {
  test("300KB 输出、读方晚 300ms 才开始读：完整且可解析", async () => {
    const core = join(import.meta.dir, "../src/manager/core.ts");
    const proc = Bun.spawn(["bun", "-e", `import { outputSync } from ${JSON.stringify(core)}; outputSync({ x: "a".repeat(300000) });`], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(300);
    const text = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(text).x.length).toBe(300000);
  });
});
