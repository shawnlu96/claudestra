/** lib/flag-like.ts：POST /api/v1/agents 透传给 manager 的字段不能长得像 flag（model / effort 也算） */
import { describe, expect, test } from "bun:test";
import { controlCharError, firstControlCharField, firstFlagLikeField, firstNonStringField, hasControlChar, textFieldsProblem } from "../src/lib/flag-like";
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
  test("换行、\\r、\\x03、\\x1b、NUL、\\x7f、C1、U+2028/2029、\\p{Cf}（零宽空格、BOM、方向控制符、tag 字符）都算；报第一个出问题的字段名", () => {
    const cf = ["a\u2028b", "a\u2029b", "a\u061cb", "a\u200eb", "a\u200fb", "a\u202ab", "a\u202eb", "a\u2066b", "a\u2069b", "a\ufeffb", "\ufeffabc", "a\u009bb",
      "a\u200bb", "a\u2060b", "a\u{E0041}b", "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"];
    for (const bad of ["a\nb", "a\rb", "a\u0003b", "a\u001b[Z", "a\u0000", "a\u007f", "a\u0085", ...cf]) {
      expect([bad, firstControlCharField({ name: "ok", prompt: bad })]).toEqual([bad, "prompt"]);
    }
    expect(firstControlCharField({ name: "a\tb", prompt: "x\ny" })).toBe("name");
  });
  test("中文、emoji（含 ZWJ 连起来的组合 emoji）、全角符号、空格放行；只看字符串，别的类型交给 firstNonStringField", () => {
    expect(firstControlCharField({ purpose: "看日志 📨［x］👨\u200d👩\u200d👧", model: "claude-opus-5-5", n: 3, x: null, y: undefined })).toBeNull();
    expect(firstControlCharField({ targetAgent: ["cc\r"] })).toBeNull();
    // 只放行 ZWNJ、ZWJ、软连字符；变体选择符是 Mn，不在 Cf 里
    for (const ok of ["a\u200db", "a\u200cb", "❤\ufe0f", "🏳\ufe0f\u200d🌈", "a\u00adb"]) expect([ok, hasControlChar(ok)]).toEqual([ok, false]);
    expect(firstControlCharField(null)).toBeNull();
    expect(firstControlCharField("a\nb")).toBeNull(); // 不是对象：没有字段可报，调用方的 JSON 形状校验会拦
  });
  test("报错文案说清哪个字段、为什么不行，中英各一段", () => {
    const e = controlCharError("prompt");
    for (const part of ["「prompt」", "换行会让它提前提交", "只能写成一行", '"prompt"', "submits early", "single line"]) expect(e).toContain(part);
  });
});

describe("textFieldsProblem：入口闸，先于 trim", () => {
  test("对象、数组、数字 → not_string（写明字段）；toString 被改过的对象也不会抛", () => {
    expect(firstNonStringField({ a: "x", b: null, c: undefined })).toBeNull();
    for (const v of [{ toString: "x" }, ["cc"], 3, true]) expect(textFieldsProblem({ ok: "x", prompt: v })).toMatchObject({ ok: false, code: "not_string", field: "prompt" });
  });
  test("首尾的 \\r \\n 也算（以前 create / claude-settings 先 trim 掉了）；给 keys 只看那几个字段", () => {
    expect(textFieldsProblem({ model: "claude-fake-3\r" })).toEqual({ ok: false, code: "control_chars", field: "model", error: controlCharError("model") });
    expect(textFieldsProblem({ model: "opus", extra: { a: 1 } }, ["model"])).toBeNull();
    expect(textFieldsProblem(null, ["model"])).toBeNull();
  });
});
