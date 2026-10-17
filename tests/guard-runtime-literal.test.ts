/** OCR-2 验收 4：pattern:runtime-literal 认哪些写法、放过哪些（scripts/guard/config.ts）。 */
import { describe, expect, test } from "bun:test";
import { PATTERNS } from "../scripts/guard/config.ts";
import { measurePatterns } from "../scripts/guard/rules/patterns.ts";

const count = (f: string, src: string) => measurePatterns(new Map([[f, src]]), PATTERNS.filter((p) => p.id === "runtime-literal")).counts["pattern:runtime-literal"];

describe("pattern:runtime-literal", () => {
  test("按 id 分支的各种写法都算", () => {
    const src = [
      `if (runtime === "pi") x();`,
      `if (info.runtime !== "codex") x();`,
      `const a = rt.id === "codex";`,
      `const b = "opencode" === agent.runtime;`,
      `const c = activeRuntime === "claude-code";`,
      `managedFor("pi", "acp");`,
    ].join("\n");
    expect(count("src/lib/foo.ts", src)).toBe(6);
  });

  test("runtimes/ 里、注释里、不是运行时的比较都不算", () => {
    expect(count("src/lib/runtimes/index.ts", `if (runtime === "pi") x();`)).toBe(0);
    expect(count("src/lib/foo.ts", `// runtime === "pi"\nif (transport === "acp") x(); managedFor(runtime, "acp");`)).toBe(0);
  });
});
