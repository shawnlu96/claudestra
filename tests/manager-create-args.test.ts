/**
 * src/manager/create-args.ts：create 的 argv 解析。重点是 --purpose 最先抽——它的值是自由文本
 * （web 经 POST /api/v1/agents 传进来），长得像 flag 也不能被别的提取器吃掉。
 */
import { describe, expect, test } from "bun:test";
import { parseCreateArgs } from "../src/manager/create-args";

const ok = (args: string[]) => {
  const r = parseCreateArgs(args);
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("parseCreateArgs", () => {
  test("常规：位置参数 + 各 flag", () => {
    const r = ok(["t9", "/repo", "--project", "p", "--task", "T9 值守", "--parent=claudestra", "--external", "--effort", "high"]);
    expect(r).toMatchObject({ name: "t9", dir: "/repo", projectFlag: "p", external: true, effort: "high", teamFlags: { parent: "claudestra", task: "T9 值守" } });
  });
  test("--purpose 的值长得像 flag：原样当 purpose，不被当成 --parent / --external / --model / --project", () => {
    for (const p of ["--parent=master", "--external", "--model=opus", "--project=x", "--task=T"]) {
      const r = ok(["a", "/d", "--purpose", p]);
      expect(r.purpose).toBe(p);
      expect(r.teamFlags).toEqual({});
      expect(r.external).toBe(false);
      expect(r.model).toBeUndefined();
      expect(r.projectFlag).toBeUndefined();
    }
  });
  test("位置 purpose 仍可用；缺 name / dir、名字像 flag、--parent 缺值 → error", () => {
    expect(ok(["a", "/d", "做", "前端"]).purpose).toBe("做 前端");
    expect(parseCreateArgs(["a"])).toHaveProperty("error");
    expect(parseCreateArgs(["-a", "/d"])).toHaveProperty("error");
    expect((parseCreateArgs(["a", "/d", "--parent"]) as { error: string }).error).toContain("--parent");
  });
});
