/**
 * npm 路径解析的 nvm 版本排序（peer 2026-08-09 指出 resolveNpm 的字典序 bug）。
 * resolveNpm 本身依赖真实文件系统，这里只测可纯化的版本排序逻辑。
 */

import { describe, test, expect } from "bun:test";
import { sortNodeVersionsDesc } from "../src/lib/npm-path.ts";

describe("sortNodeVersionsDesc", () => {
  test("语义降序，最新版本在前", () => {
    expect(sortNodeVersionsDesc(["v18.16.0", "v20.19.6", "v22.12.0", "v23.5.0"])[0]).toBe("v23.5.0");
  });

  test("字典序会答错的 case：v9 vs v10 → 选 v10", () => {
    expect(sortNodeVersionsDesc(["v9.11.2", "v10.24.1"])[0]).toBe("v10.24.1");
  });

  test("字典序会答错的 case：v100 vs v20 → 选 v100", () => {
    expect(sortNodeVersionsDesc(["v20.19.6", "v100.0.0"])[0]).toBe("v100.0.0");
  });

  test("次版本/补丁号也按数值比", () => {
    expect(sortNodeVersionsDesc(["v20.9.0", "v20.19.6", "v20.2.0"])).toEqual([
      "v20.19.6",
      "v20.9.0",
      "v20.2.0",
    ]);
  });

  test("无 v 前缀也可", () => {
    expect(sortNodeVersionsDesc(["20.1.0", "20.10.0"])[0]).toBe("20.10.0");
  });

  test("空数组不炸", () => {
    expect(sortNodeVersionsDesc([])).toEqual([]);
  });
});
