// 全量测试闸：整条 bun 命令行在 `test` 之前的选项（src/lib/full-test-gate-args.ts，docs/architecture/full-test-gate.md）。
import { describe, expect, test } from "bun:test";
import { classifyBunArgv } from "../src/lib/full-test-gate-args.ts";

describe("[验收线 7] test 之前的未知选项不再漏判成 other", () => {
  test("未知选项（带不带值都认不出）在 test 前：error，不扫到它的值当脚本名", () => {
    for (const argv of [["bun", "--console-depth", "5", "test"], ["bun", "--console-depth=5", "test"], ["bun", "--frobnicate", "x", "test"],
      ["bun", "-z", "test"], ["bun", "--unknown", "test"], ["bun", "--cwd"]]) {
      expect(classifyBunArgv(argv).kind).toBe("error");
    }
  });

  test("已知带值选项与 --x=v 按既有语法跳过取值，照常判 full / focused", () => {
    expect(classifyBunArgv(["bun", "--cwd", ".", "test"])).toEqual({ kind: "full", args: ["--cwd", "."] });
    expect(classifyBunArgv(["bun", "--cwd=.", "test"])).toEqual({ kind: "full", args: ["--cwd=."] });
    expect(classifyBunArgv(["bun", "--config", "b.toml", "--smol", "test", "-t", "x"])).toEqual({ kind: "full", args: ["--config", "b.toml", "--smol", "-t", "x"] });
    expect(classifyBunArgv(["bun", "--cwd", ".", "test", "tests/a.test.ts"]).kind).toBe("focused");
    expect(classifyBunArgv(["bun", "--bail=1", "test"]).kind).toBe("full");
  });

  test("脚本 / eval 照旧归 other", () => {
    for (const argv of [["bun", "-e", "test"], ["bun", "--eval", "1"], ["bun", "--eval=1", "test"], ["bun", "-p", "1"], ["bun", "--print=1"],
      ["bun", "-"], ["bun", "run", "x.ts"], ["bun", "x.ts", "test"], ["bun", "--cwd", ".", "run", "test"], ["bun", "--smol", "x.ts"], ["bun"]]) {
      expect(classifyBunArgv(argv).kind).toBe("other");
    }
  });
});
