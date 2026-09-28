/** lib/flag-like.ts：POST /api/v1/agents 透传给 manager 的字段不能长得像 flag（model / effort 也算） */
import { describe, expect, test } from "bun:test";
import { controlCharError, firstControlCharField, firstFlagLikeField } from "../src/lib/flag-like";
import { parseCreateArgs } from "../src/manager/create-args";

describe("firstFlagLikeField", () => {
  test("model / effort 以 - 开头 → 报出字段名；正常值放行", () => {
    expect(firstFlagLikeField({ name: "a", dir: "/d", project: "", model: "--parent=master", effort: "" })).toBe("model");
    expect(firstFlagLikeField({ name: "a", dir: "/d", project: "", model: "", effort: "--task=x" })).toBe("effort");
    expect(firstFlagLikeField({ name: "-a", dir: "/d" })).toBe("name");
    expect(firstFlagLikeField({ name: "a", dir: "~/d", project: "p", model: "opus", effort: "high" })).toBeNull();
  });
  test("为什么要挡：不挡的话 --model 的值会被 create 解析成 --parent", () => {
    const r = parseCreateArgs(["a", "/d", "--model", "--parent=master"]);
    expect("error" in r ? null : r.teamFlags.parent).toBe("master");
  });
});

describe("firstControlCharField", () => {
  test("换行、\\r、\\x03、\\x1b、NUL、\\x7f 都算；报第一个出问题的字段名", () => {
    for (const bad of ["a\nb", "a\rb", "a\u0003b", "a\u001b[Z", "a\u0000", "a\u007f", "a\u0085"]) {
      expect([bad, firstControlCharField({ name: "ok", prompt: bad })]).toEqual([bad, "prompt"]);
    }
    expect(firstControlCharField({ name: "a\tb", prompt: "x\ny" })).toBe("name");
  });
  test("中文、emoji、全角符号、空格放行；非字符串值按 String() 看，null / undefined 跳过", () => {
    expect(firstControlCharField({ purpose: "看日志 📨［x］", model: "claude-opus-5-5", n: 3, x: null, y: undefined })).toBeNull();
    expect(firstControlCharField({ targetAgent: ["cc\r"] })).toBe("targetAgent");
    expect(firstControlCharField(null)).toBeNull();
    expect(firstControlCharField("a\nb")).toBeNull(); // 不是对象：没有字段可报，调用方的 JSON 形状校验会拦
  });
  test("报错文案说清哪个字段、为什么不行，中英各一段", () => {
    const e = controlCharError("prompt");
    for (const part of ["「prompt」", "换行会让它提前提交", "只能写成一行", '"prompt"', "submits early", "single line"]) expect(e).toContain(part);
  });
});
