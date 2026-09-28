/** lib/flag-like.ts：POST /api/v1/agents 透传给 manager 的字段不能长得像 flag（model / effort 也算） */
import { describe, expect, test } from "bun:test";
import { firstFlagLikeField } from "../src/lib/flag-like";
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
