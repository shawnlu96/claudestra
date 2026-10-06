/** 网页「新终端」的纯规则（src/lib/web-shell-policy.ts）：命名 / 寻址、id 分配、起始目录白名单 */
import { describe, expect, test } from "bun:test";
import {
  MAX_SHELLS, newShellId, parseShellWindow, resolveShellDir, SHELL_SESSION, shellDirChoices, shellTarget, shellWindowName,
} from "../src/lib/web-shell-policy.js";
import type { ProjectDef } from "../src/lib/projects.js";

const proj = (id: string, dirs: string[]): ProjectDef => ({ id, name: id, dirs, createdAt: "" });

describe("命名与寻址", () => {
  test("独立 session、两段精确匹配，不会前缀匹配到 master 或别的窗口", () => {
    expect(SHELL_SESSION).not.toBe("master");
    expect(shellTarget("a1b2c3")).toBe(`=${SHELL_SESSION}:=sh-a1b2c3`);
    expect(MAX_SHELLS).toBe(8);
  });
  test("只认我们起的名字：改过名 / 非法 id 不给寻址", () => {
    expect(parseShellWindow(shellWindowName("a1b2c3"))).toBe("a1b2c3");
    for (const n of ["zsh", "sh-", "sh-A1B2C3", "sh-a1b2c3d", "sh-../x", "agent-sh-a1b2c3"]) expect([n, parseShellWindow(n)]).toEqual([n, null]);
  });
  test("newShellId 跳过已占用与非法值；rand 坏掉时抛错而不是死循环", () => {
    const seq = ["XYZ", "aaaaaa", "bbbbbb"];
    expect(newShellId(new Set(["aaaaaa"]), () => seq.shift() ?? "")).toBe("bbbbbb");
    expect(() => newShellId(new Set(), () => "nope")).toThrow();
  });
});

describe("起始目录白名单", () => {
  const exists = new Set(["/home/u", "/repo/a", "/repo/b1", "/repo/b2"]);
  const usable = (d: string) => exists.has(d);
  const choices = shellDirChoices("/home/u", [proj("a", ["/repo/a", "/home/u"]), proj("b", ["/repo/b1", "/repo/b2", "/gone"])], usable);

  test("家目录在第一项；登记且存在的项目目录去重列出，多目录项目带目录名", () => {
    expect(choices).toEqual([
      { label: "~", dir: "/home/u" },
      { label: "a · a", dir: "/repo/a" },
      { label: "b · b1", dir: "/repo/b1" },
      { label: "b · b2", dir: "/repo/b2" },
    ]);
  });
  test("没给目录 = 第一项；给了只收逐字在列的", () => {
    expect(resolveShellDir(undefined, choices)).toBe("/home/u");
    expect(resolveShellDir("", choices)).toBe("/home/u");
    expect(resolveShellDir("/repo/b2", choices)).toBe("/repo/b2");
    for (const bad of ["/gone", "/repo/a/", "/repo/a/../b1", "/etc", "~", 42, ["/repo/a"]]) {
      expect([bad, resolveShellDir(bad, choices)]).toEqual([bad, null]);
    }
  });
  test("家目录过不了（沙箱闸）时第一项换成项目目录；一个都没有就拒", () => {
    const sandboxed = shellDirChoices("/home/u", [proj("a", ["/repo/a"])], (d) => d === "/repo/a");
    expect(resolveShellDir(undefined, sandboxed)).toBe("/repo/a");
    expect(resolveShellDir(undefined, [])).toBeNull();
  });
});
