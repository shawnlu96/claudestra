import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 验收 1：视图层只按 ACP 标准事件（经 updates.ts 翻好的段）渲染——不 import 任何 harness 专属模块，也不按 runtime / 适配器名分支

const ACP = join(import.meta.dir, "..", "src", "lib", "acp");
const VIEW = [
  ...readdirSync(join(ACP, "tui")).map((f) => join(ACP, "tui", f)),
  ...readdirSync(ACP).filter((f) => /^(tty-.*|transcript.*)\.ts$/.test(f)).map((f) => join(ACP, f)),
];

test("视图层文件都在清单里（新视图 + 逐行视图）", () => {
  expect(VIEW.map((f) => f.slice(ACP.length + 1)).sort()).toEqual([
    "transcript-stream.ts", "transcript.ts", "tty-input-attach.ts", "tty-input.ts", "tty-layout.ts", "tty-screen.ts", "tty-status.ts",
    "tui/blocks.ts", "tui/footer.ts", "tui/guard.ts", "tui/live.ts", "tui/markdown.ts", "tui/message.ts", "tui/painter.ts", "tui/screen.ts", "tui/text.ts",
  ]);
});

test("不 import harness 专属模块（codex-* / pi-* / runtimes/ / 适配器）", () => {
  for (const f of VIEW) {
    const imports = [...readFileSync(f, "utf8").matchAll(/from "([^"]+)"/g)].map((m) => m[1]!);
    expect({ f, bad: imports.filter((i) => /codex|(^|\/)pi[-/]|runtimes\/|adapter|host-runtime/.test(i)) }).toEqual({ f, bad: [] });
  }
});

test("不按 runtime / 适配器名分支（代码里不出现 harness 名字的比较）", () => {
  for (const f of VIEW) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // 只看代码，注释里提到没关系
    expect({ f, hits: code.match(/\b(runtime|rt\.id|adapter|codex|"pi"|'pi')\b/gi) ?? [] }).toEqual({ f, hits: [] });
  }
});
