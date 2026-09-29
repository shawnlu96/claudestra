/**
 * 网页「添加设备 · 给别人」的签码请求（T42）：名字、会话都要写明，"*" 要第二次确认才带 confirmAllAgents；
 * bridge 的校验码换成界面上的话。服务端同一套规则见 tests/guest-pairing.test.ts。
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api/client";
import { GUEST_ALL_WARNING, grantsAllAgents, guestShareOpts, shareCodeErrorText } from "@/lib/guest-share";

describe("guestShareOpts", () => {
  test("名字空白：不发请求，提示写给谁（不会退化成给自己签全权码）", () => {
    for (const name of ["", "   ", "\t"]) expect(guestShareOpts(name, ["worker-a"], false)).toEqual({ error: "写一下是给谁的，比如「Alex 的手机」" });
  });

  test("一个会话都没选：不发请求", () => {
    expect(guestShareOpts("Alex", [], true)).toEqual({ error: "至少选一个会话" });
  });

  test("具体会话：名字去掉首尾空白，原样带上，不带 confirmAllAgents", () => {
    expect(guestShareOpts(" Alex ", ["worker-a", "worker-b"], false)).toEqual({ opts: { guest: "Alex", agents: ["worker-a", "worker-b"] } });
    expect(guestShareOpts("123", ["worker-a"], false)).toEqual({ opts: { guest: "123", agents: ["worker-a"] } });
  });

  test('"*"：第一次要确认，确认后才带 confirmAllAgents', () => {
    expect(guestShareOpts("Alex", ["*"], false)).toEqual({ confirm: true });
    expect(guestShareOpts("Alex", ["*"], true)).toEqual({ opts: { guest: "Alex", agents: ["*"], confirmAllAgents: true } });
  });
});

test("grantsAllAgents：\"*\"（数组或字符串形式）才算全部，批准时据此单独警告", () => {
  expect(grantsAllAgents({ agents: ["*"] })).toBe(true);
  expect(grantsAllAgents({ agents: "*" })).toBe(true);
  expect(grantsAllAgents({ agents: ["worker-a"] })).toBe(false);
});

describe("shareCodeErrorText", () => {
  const err = (code: string) => new ApiError("raw", 400, {}, code);
  test("bridge 的 guest 校验码换成界面文案，其它原样", () => {
    expect(shareCodeErrorText(err("guest_name_required"))).toBe("写一下是给谁的，比如「Alex 的手机」");
    expect(shareCodeErrorText(err("guest_agents_required"))).toBe("至少选一个会话");
    expect(shareCodeErrorText(err("guest_all_needs_confirm"))).toBe(GUEST_ALL_WARNING);
    expect(shareCodeErrorText(new Error("中继没连上"))).toBe("中继没连上");
  });
});
