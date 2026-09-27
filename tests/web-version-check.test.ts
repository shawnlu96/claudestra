import { describe, expect, test } from "bun:test";
import { bundleStale, clientTooOld, machineTooOld, semverLt } from "@/lib/version-check";

const client = { commit: "aaaaaaa", webCommit: "1111111", version: "2.28.0" };

describe("bundleStale（前端 bundle 是否滞后）", () => {
  test("有 webCommit 精确比它：只改 src/ 的后端提交（HEAD 变、webCommit 不变）不亮", () => {
    expect(bundleStale({ commit: "bbbbbbb", webCommit: "1111111" }, client)).toBeNull();
    expect(bundleStale({ commit: "bbbbbbb", webCommit: "2222222" }, client)).toBe("2222222");
  });
  test("只有 commit 时退回比 HEAD；两边都缺不算滞后", () => {
    expect(bundleStale({ commit: "aaaaaaa" }, client)).toBeNull();
    expect(bundleStale({ commit: "bbbbbbb" }, client)).toBe("bbbbbbb");
    expect(bundleStale({}, client)).toBeNull();
    expect(bundleStale(null, client)).toBeNull();
    expect(bundleStale({ commit: "x" }, { ...client, commit: "" })).toBeNull();
  });
});

describe("machineTooOld / clientTooOld", () => {
  test("apiVersion 低于要求才算老机器；没字段（老 bridge / 拿不到）不吓人", () => {
    expect(machineTooOld({ apiVersion: 0 })).toBe(true);
    expect(machineTooOld({ apiVersion: 1 })).toBe(false);
    expect(machineTooOld({})).toBe(false);
    expect(machineTooOld(null)).toBe(false);
  });
  test("minClient 高于本 bundle 版本才算前端太老；解析不了的不误判", () => {
    expect(clientTooOld({ minClient: "2.29.0" }, "2.28.0")).toBe(true);
    expect(clientTooOld({ minClient: "2.28.0" }, "2.28.0")).toBe(false);
    expect(clientTooOld({ minClient: "v2.30.1" }, "2.30.0")).toBe(true);
    expect(clientTooOld({ minClient: "latest" }, "2.28.0")).toBe(false);
    expect(clientTooOld({}, "2.28.0")).toBe(false);
    expect(clientTooOld({ minClient: "3.0.0" }, "")).toBe(false);
  });
  test("semverLt", () => {
    expect(semverLt("2.9.9", "2.10.0")).toBe(true);
    expect(semverLt("2.10.0", "2.9.9")).toBe(false);
    expect(semverLt("1.0.0", "1.0.0")).toBe(false);
  });
});
