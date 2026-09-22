import { test, expect, describe } from "bun:test";
import { needsNpmInstall, parseBakedWebCommit, sameCommit, WEB_PATHSPEC } from "../src/lib/web-build";
import { readFileSync } from "fs";

describe("web-build 纯逻辑", () => {
  test("从 build-info.ts 解析烤入的 CLIENT_WEB_COMMIT", () => {
    const src = `export const CLIENT_COMMIT = "cf18087";\nexport const CLIENT_WEB_COMMIT = "0df41f5";\n`;
    expect(parseBakedWebCommit(src)).toBe("0df41f5");
    expect(parseBakedWebCommit(`export const CLIENT_WEB_COMMIT = "";`)).toBeNull();
    expect(parseBakedWebCommit("garbage")).toBeNull();
  });

  test("sameCommit 按前缀比，过短或为空不算相等", () => {
    expect(sameCommit("0df41f5", "0df41f5c")).toBe(true);
    expect(sameCommit("0df41f5", "0df41f6")).toBe(false);
    expect(sameCommit("", "0df41f5")).toBe(false);
    expect(sameCommit("0d", "0d")).toBe(false);
  });

  test("依赖文件比已装 marker 新才 npm install；marker 缺失不猜", () => {
    expect(needsNpmInstall({ pkg: 10, lock: 10, installed: 20 })).toBe(false);
    expect(needsNpmInstall({ pkg: 30, lock: 10, installed: 20 })).toBe(true);
    expect(needsNpmInstall({ pkg: 10, lock: 30, installed: 20 })).toBe(true);
    expect(needsNpmInstall({ pkg: 30, lock: 30, installed: null })).toBe(false);
  });

  // pathspec 必须与客户端烤入口径一致，否则判据与「新版本已就绪」胶囊各说各话
  test("pathspec 与 gen-build-info.mjs 同口径：排除 web 下的 md", () => {
    expect(WEB_PATHSPEC).toEqual(["--", "web", ":(exclude)web/*.md"]);
    const gen = readFileSync(`${import.meta.dir}/../web/scripts/gen-build-info.mjs`, "utf-8");
    expect(gen).toContain(`"--", ".", ":(exclude)*.md"`);
  });
});
