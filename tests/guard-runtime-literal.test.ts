/** OCR-2 验收 4：pattern:runtime-literal 认哪些写法、放过哪些（scripts/guard/config.ts）。 */
import { describe, expect, test } from "bun:test";
import { PATTERNS } from "../scripts/guard/config.ts";
import { measurePatterns } from "../scripts/guard/rules/patterns.ts";

const count = (f: string, src: string) => measurePatterns(new Map([[f, src]]), PATTERNS.filter((p) => p.id === "runtime-literal")).counts[`pattern:runtime-literal:${f}`] ?? 0;

describe("pattern:runtime-literal", () => {
  test("按 id 分支的各种写法都算", () => {
    const src = [
      `if (runtime === "pi") x();`,
      `if (info.runtime !== "codex") x();`,
      `const a = rt.id === "codex";`,
      `const b = "opencode" === agent.runtime;`,
      `const c = activeRuntime === "claude-code";`,
      `managedFor("pi", "acp");`,
      "if (runtime === `opencode`) x();",
      `switch (info.runtime) { case "pi": break; }`,
    ].join("\n");
    expect(count("src/lib/foo.ts", src)).toBe(8);
  });

  test("runtimes/ 里、注释里、不是运行时的比较都不算", () => {
    expect(count("src/lib/runtimes/index.ts", `if (runtime === "pi") x();`)).toBe(0);
    expect(count("src/lib/foo.ts", `// runtime === "pi"\nif (transport === "acp") x(); managedFor(runtime, "acp");`)).toBe(0);
  });
});

describe("pattern:runtime-literal 按文件计数（验收追加 3 P2-5）", () => {
  test("删一处旧的、在别的文件加一处：总数不变也红", async () => {
    const { compare } = await import("../scripts/guard/ratchet.ts");
    const defs = PATTERNS.filter((p) => p.id === "runtime-literal");
    const literal = (files: [string, string][]) =>
      Object.fromEntries(Object.entries(measurePatterns(new Map(files), defs).counts).filter(([k]) => k.startsWith("pattern:runtime-literal")));
    const before = literal([["src/lib/a.ts", `if (runtime === "pi") x();`]]);
    expect(before).toEqual({ "pattern:runtime-literal:src/lib/a.ts": 1 });
    const after = literal([["src/lib/a.ts", ""], ["src/lib/b.ts", `if (runtime === "pi") x();`]]);
    expect(compare(before, after, new Set()).failures.map((f) => f.key)).toEqual(["pattern:runtime-literal:src/lib/b.ts"]);
  });
});
