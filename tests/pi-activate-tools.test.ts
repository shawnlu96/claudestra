/**
 * 0.99 内建工具的激活扩展：`-e builtin:codemode` 只注册不激活（真机实测），
 * 靠本扩展在 session_start 里 setActiveTools —— 这里钉住它的解析与差集逻辑。
 */
import { describe, expect, test } from "bun:test";
import activateTools, { ACTIVATE_ENV, activationDelta, parseActivateList } from "../src/lib/acp/pi-adapter/activate-tools.ts";

type PiApi = Parameters<typeof activationDelta>[0];

function api(active: string[], all: string[] | null, onSet?: (names: string[]) => void): PiApi {
  return {
    on: (_e: "session_start", h: (e: unknown, ctx: unknown) => unknown) => void handlers.push(h),
    getActiveTools: () => [...active],
    getAllTools: all === null ? undefined : () => all.map((name) => ({ name })),
    setActiveTools: (names: string[]) => onSet?.(names),
  };
}
let handlers: Array<(e: unknown, ctx: unknown) => unknown> = [];

describe("activate-tools 扩展", () => {
  test("parseActivateList：去空、去重、排序", () => {
    expect(parseActivateList(" codemode , tool_search ,codemode,, ")).toEqual(["codemode", "tool_search"]);
    expect(parseActivateList(undefined)).toEqual([]);
  });

  test("activationDelta：已在 active 的不重复加；pi 里没有的名字不加（避免拿错名字去 set）", () => {
    expect(activationDelta(api(["read"], ["read", "codemode"]), ["codemode"])).toEqual(["codemode"]);
    expect(activationDelta(api(["read", "codemode"], ["read", "codemode"]), ["codemode"])).toEqual([]);
    expect(activationDelta(api(["read"], ["read"]), ["codemode"])).toEqual([]);
    // 拿不到全量清单（老版本）时按"都有"处理：宁可多试一次，也不静默失效
    expect(activationDelta(api(["read"], null), ["codemode"])).toEqual(["codemode"]);
  });

  test("session_start 时把工具打开，并把环境变量删掉（bash 子进程会继承 process.env）", () => {
    handlers = [];
    const env: Record<string, string | undefined> = { [ACTIVATE_ENV]: "codemode" };
    const got: { v: string[] | null } = { v: null }; // 用属性装：直接 let + 闭包赋值会被 TS 收窄成 null
    activateTools(api(["read", "bash"], ["read", "bash", "codemode"], (n) => {
      got.v = n;
    }), env);
    expect(env[ACTIVATE_ENV]).toBeUndefined(); // 读完即删
    expect(handlers).toHaveLength(1);
    handlers[0]({}, {});
    expect(got.v).toEqual(["read", "bash", "codemode"]);
  });

  test("没有环境变量时什么都不做（普通 agent 不装这个东西）", () => {
    handlers = [];
    activateTools(api(["read"], ["read"]), {});
    expect(handlers).toHaveLength(0);
  });
});
