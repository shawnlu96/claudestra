import { test, expect, describe } from "bun:test";
import { portOwnerConflict } from "../src/lib/cli-install";

// 装完自检只看「有人应答」时，端口被别的程序占着也报健康（launchd 那份其实在 EADDRINUSE 崩溃循环）
describe("portOwnerConflict", () => {
  test("监听者就是 launchd 托管进程 → 没问题", () => {
    expect(portOwnerConflict([{ pid: "100", ancestors: [] }], "100")).toBeNull();
  });
  test("监听者是 launchd 进程的子孙（sh -c / npm 包一层的手写 plist）→ 没问题", () => {
    expect(portOwnerConflict([{ pid: "300", ancestors: ["200", "100"] }], "100")).toBeNull();
  });
  test("别的程序占着端口 → 报占用者", () => {
    const c = portOwnerConflict([{ pid: "999", ancestors: ["50"] }], "100");
    expect(c).toContain("999");
    expect(c).toContain("100");
  });
  test("launchd 那份没在跑、端口却有人听 → 报占用", () => {
    expect(portOwnerConflict([{ pid: "999", ancestors: [] }], null)).toContain("999");
  });
  test("没人监听不在这里判（探活那一步已经报了）", () => {
    expect(portOwnerConflict([], "100")).toBeNull();
  });
});
