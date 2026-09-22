import { test, expect, describe } from "bun:test";
import { isBuilderComm, needsNpmInstall, parseBakedWebCommit, parseBuildMarker, sameCommit, WEB_PATHSPEC } from "../src/lib/web-build";
import { readFileSync } from "fs";

describe("web-build 纯逻辑", () => {
  test("从 build-info.ts 解析烤入的 CLIENT_WEB_COMMIT", () => {
    const src = `export const CLIENT_COMMIT = "cf18087";\nexport const CLIENT_WEB_COMMIT = "0df41f5";\n`;
    expect(parseBakedWebCommit(src)).toBe("0df41f5");
    expect(parseBakedWebCommit(`export const CLIENT_WEB_COMMIT = "";`)).toBeNull();
    expect(parseBakedWebCommit("garbage")).toBeNull();
  });

  test("构建标记：合法 JSON 才认，commit 可为空（失败标记），buildId 不能空", () => {
    expect(parseBuildMarker(`{"commit":"0df41f5","buildId":"B1"}`)).toEqual({ commit: "0df41f5", buildId: "B1" });
    expect(parseBuildMarker(`{"commit":"","buildId":"B1"}`)).toEqual({ commit: "", buildId: "B1" });
    expect(parseBuildMarker(`{"commit":"x","buildId":""}`)).toBeNull();
    expect(parseBuildMarker("garbage")).toBeNull();
  });

  // 锁只在持有者死了才接管；pid 被复用成非 bun 进程按已死处理
  test("锁持有者识别：bun 全路径或裸名都算构建进程", () => {
    expect(isBuilderComm("/opt/homebrew/Cellar/bun/1.3.14/bin/bun")).toBe(true);
    expect(isBuilderComm("bun")).toBe(true);
    expect(isBuilderComm("/Users/x/.bun/bin/bun\n")).toBe(true);
    expect(isBuilderComm("/bin/zsh")).toBe(false);
    expect(isBuilderComm("/usr/libexec/bunnyd")).toBe(false);
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
