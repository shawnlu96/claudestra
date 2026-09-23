import { describe, expect, test } from "bun:test";
import { summarizeUpdate } from "../src/lib/update-status";
import { settingsError } from "../src/bridge/update-routes";

const rel = (v: string) => ({ tag: `v${v}`, version: v, name: "", body: "" });

describe("summarizeUpdate（网页「版本与更新」显示能升到哪个版本）", () => {
  test("release：远端更新 → 可升；相同或本地更新（开发机）→ 已是最新", () => {
    expect(summarizeUpdate({ channel: "release", version: "2.24.1", head: "e6c6411abc", release: rel("2.24.2") }))
      .toMatchObject({ latest: "v2.24.2", upToDate: false, current: { version: "2.24.1", head: "e6c6411" } });
    expect(summarizeUpdate({ channel: "release", version: "2.24.1", head: "x", release: rel("2.24.1") }).upToDate).toBe(true);
    expect(summarizeUpdate({ channel: "release", version: "2.25.0", head: "x", release: rel("2.24.1") }).upToDate).toBe(true);
  });

  test("release 查不到远端：upToDate=null 带原因，不假装已是最新", () => {
    const s = summarizeUpdate({ channel: "release", version: "2.24.1", head: "x", release: null });
    expect(s.upToDate).toBeNull();
    expect(s.error).toBeTruthy();
  });

  test("beta：落后 main → 可升并给出落后数；追平或领先（behind=0）→ 已是最新", () => {
    expect(summarizeUpdate({ channel: "beta", version: "2.24.1", head: "aaaaaaa1", remoteHead: "bbbbbbb2", behind: 3 }))
      .toMatchObject({ latest: "bbbbbbb", behind: 3, upToDate: false });
    expect(summarizeUpdate({ channel: "beta", version: "2.24.1", head: "same", remoteHead: "same", behind: 0 }).upToDate).toBe(true);
    expect(summarizeUpdate({ channel: "beta", version: "2.24.1", head: "ahead", remoteHead: "main", behind: 0 }).upToDate).toBe(true);
    expect(summarizeUpdate({ channel: "beta", version: "2.24.1", head: "x" }).upToDate).toBeNull();
  });
});

describe("settingsError（POST /update/settings 的 body 校验）", () => {
  test("合法：给哪项改哪项", () => {
    expect(settingsError({ channel: "beta" })).toBeNull();
    expect(settingsError({ claudestra: false, claudeCode: true })).toBeNull();
  });
  test("非法值与空改动都拒", () => {
    expect(settingsError({ channel: "nightly" })).toContain("channel");
    expect(settingsError({ claudestra: "on" })).toContain("claudestra");
    expect(settingsError({})).toBe("nothing to change");
    expect(settingsError(null)).toBeTruthy();
  });
});
